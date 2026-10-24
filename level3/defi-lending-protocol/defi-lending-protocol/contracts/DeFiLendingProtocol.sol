// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title DeFiLendingProtocol
 * @notice A small, educational lending and borrowing protocol.
 *
 * HOW IT WORKS (short version)
 * ----------------------------
 *  - Lenders `deposit` tokens. Deposited tokens form a pool that others can borrow from.
 *  - Borrowers `depositCollateral` first. Collateral is NOT lent out; it only backs loans.
 *  - Borrowers can `borrow` as long as their total debt value stays under the "borrow limit"
 *    (collateral value x the asset's loan-to-value ratio).
 *  - Borrowers `repay` to reduce debt, and `withdrawCollateral` as long as the loan stays safe.
 *  - If collateral value falls so that debt > "liquidation capacity", anybody may `liquidate`
 *    part of the loan: they repay some debt and receive collateral plus a bonus.
 *
 * ASSUMPTIONS AND LIMITATIONS (read before using!)
 * ------------------------------------------------
 *  1. NOT AUDITED and NOT PRODUCTION-READY. This is a learning project.
 *  2. Prices are set manually by the owner (no oracle). A real protocol needs a decentralized,
 *     manipulation-resistant price feed (e.g. Chainlink) with staleness checks.
 *  3. No interest is charged: debt only changes when you borrow, repay or get liquidated.
 *  4. Fee-on-transfer, rebasing and ERC-777 style tokens are not supported. Fee-on-transfer
 *     tokens are rejected at runtime.
 *  5. Bad debt (collateral worth less than the debt) is not socialized or covered; it simply
 *     stays as unpaid debt and lenders may be unable to withdraw everything.
 *  6. The owner is trusted: it can change prices, risk parameters, and pause the protocol.
 *     Use a multisig plus a timelock in any serious deployment.
 *  7. At most MAX_ASSETS assets are supported because account checks loop over all assets.
 */
contract DeFiLendingProtocol is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice 100% expressed in basis points (1 bps = 0.01%).
    uint256 public constant BPS = 10_000;
    /// @notice Max number of listed assets (keeps account-health loops cheap and bounded).
    uint256 public constant MAX_ASSETS = 16;
    /// @notice Highest allowed liquidation bonus (20%).
    uint256 public constant MAX_LIQUIDATION_BONUS_BPS = 2_000;
    /// @notice Highest allowed liquidation threshold per asset (95%).
    uint256 public constant MAX_LIQUIDATION_THRESHOLD_BPS = 9_500;
    /// @dev Health factor is scaled by 1e18 (1e18 == exactly at the liquidation line).
    uint256 private constant HEALTH_PRECISION = 1e18;

    // ---------------------------------------------------------------------
    // Types (packed to save storage slots)
    // ---------------------------------------------------------------------

    /// @dev 1 + 1 + 2 + 2 + 16 = 22 bytes -> fits in ONE storage slot.
    struct AssetConfig {
        bool supported;
        uint8 decimals;
        uint16 ltvBps; // max borrowing power per unit of collateral value
        uint16 liquidationThresholdBps; // debt above this share of collateral => liquidatable
        uint128 price; // USD value (1e18 precision) of ONE whole token (10**decimals units)
    }

    /// @dev Used for batch listing. Passed as calldata to avoid copying to memory.
    struct AssetParams {
        address token;
        uint128 price;
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
    }

    /// @dev 16 + 16 = 32 bytes -> ONE slot. Collateral and debt are always read together.
    struct Position {
        uint128 collateral;
        uint128 debt;
    }

    /// @dev Pool-wide totals per asset. 16 + 16 = 32 bytes -> ONE slot.
    struct Totals {
        uint128 deposits;
        uint128 borrows;
    }

    /// @notice Summary of an account, all values in USD with 1e18 precision.
    struct AccountData {
        uint256 collateralValue; // full market value of all collateral
        uint256 debtValue; // market value of all debt
        uint256 borrowCapacity; // max debt allowed (uses LTV)
        uint256 liquidationCapacity; // debt above this can be liquidated (uses liquidation threshold)
        uint256 collateralRatioBps; // collateral / debt in bps (max uint if no debt)
        uint256 healthFactor; // liquidationCapacity / debt, 1e18 = at the line (max uint if no debt)
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Bonus paid to liquidators on top of the repaid value (bps). Default 5%.
    uint16 public liquidationBonusBps = 500;
    /// @notice Max share of a single debt that can be repaid in one liquidation (bps). Default 50%.
    uint16 public closeFactorBps = 5_000;

    address[] private _assets;
    mapping(address asset => AssetConfig) public assetConfig;
    mapping(address user => mapping(address asset => uint256)) private _deposits;
    mapping(address user => mapping(address asset => Position)) private _positions;
    mapping(address asset => Totals) private _totals;
    mapping(address asset => uint256) private _totalCollateral;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event CollateralDeposited(address indexed user, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount);
    event Borrowed(address indexed user, address indexed asset, uint256 amount);
    event Repaid(address indexed user, address indexed asset, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event AssetAdded(address indexed asset, uint128 price, uint16 ltvBps, uint16 liquidationThresholdBps);
    event AssetRiskUpdated(address indexed asset, uint16 ltvBps, uint16 liquidationThresholdBps);
    event AssetPriceUpdated(address indexed asset, uint128 oldPrice, uint128 newPrice);
    event LiquidationParamsUpdated(uint16 liquidationBonusBps, uint16 closeFactorBps);

    // ---------------------------------------------------------------------
    // Custom errors (cheaper than revert strings)
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error AssetNotSupported(address asset);
    error AssetAlreadySupported(address asset);
    error TooManyAssets();
    error InvalidDecimals();
    error InvalidPrice();
    error InvalidRiskParams();
    error InsufficientDeposit();
    error InsufficientCollateral();
    error InsufficientLiquidity();
    error ExceedsBorrowLimit();
    error NothingToRepay();
    error PositionHealthy();
    error CannotLiquidateSelf();
    error RepayExceedsCloseFactor(uint256 maxRepay);
    error NothingToSeize();
    error UnsupportedTokenBehavior();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address initialOwner) Ownable(initialOwner) {}

    // =====================================================================
    //                         OWNER CONFIGURATION
    // =====================================================================

    /// @notice List a new ERC-20 asset.
    /// @param token ERC-20 address.
    /// @param price USD price of one whole token, 1e18 precision (e.g. 2000e18 = $2000).
    /// @param ltvBps Loan-to-value in bps (e.g. 7500 = 75%).
    /// @param liquidationThresholdBps Liquidation threshold in bps (must be >= ltv).
    function addAsset(address token, uint128 price, uint16 ltvBps, uint16 liquidationThresholdBps)
        external
        onlyOwner
    {
        _addAsset(token, price, ltvBps, liquidationThresholdBps);
    }

    /// @notice List many assets in one transaction. `calldata` avoids copying the array to memory.
    function addAssets(AssetParams[] calldata params) external onlyOwner {
        uint256 len = params.length;
        for (uint256 i; i < len; ++i) {
            AssetParams calldata p = params[i];
            _addAsset(p.token, p.price, p.ltvBps, p.liquidationThresholdBps);
        }
    }

    /// @notice Change the risk settings of an asset. Existing loans are affected immediately.
    function setAssetRisk(address token, uint16 ltvBps, uint16 liquidationThresholdBps) external onlyOwner {
        if (!assetConfig[token].supported) revert AssetNotSupported(token);
        _validateRisk(ltvBps, liquidationThresholdBps, liquidationBonusBps);

        AssetConfig storage cfg = assetConfig[token];
        cfg.ltvBps = ltvBps;
        cfg.liquidationThresholdBps = liquidationThresholdBps;
        emit AssetRiskUpdated(token, ltvBps, liquidationThresholdBps);
    }

    /// @notice Set the USD price of one whole token (1e18 precision). Manual "oracle" (see limitations).
    function setAssetPrice(address token, uint128 newPrice) external onlyOwner {
        AssetConfig storage cfg = assetConfig[token];
        if (!cfg.supported) revert AssetNotSupported(token);
        if (newPrice == 0) revert InvalidPrice();
        uint128 oldPrice = cfg.price;
        cfg.price = newPrice;
        emit AssetPriceUpdated(token, oldPrice, newPrice);
    }

    /// @notice Set liquidation bonus and close factor.
    function setLiquidationParams(uint16 newBonusBps, uint16 newCloseFactorBps) external onlyOwner {
        if (newBonusBps > MAX_LIQUIDATION_BONUS_BPS) revert InvalidRiskParams();
        if (newCloseFactorBps == 0 || newCloseFactorBps > BPS) revert InvalidRiskParams();

        // Every listed asset must still satisfy: threshold * (1 + bonus) <= 100%.
        address[] memory assets = _assets;
        uint256 len = assets.length;
        for (uint256 i; i < len; ++i) {
            if (uint256(assetConfig[assets[i]].liquidationThresholdBps) * (BPS + newBonusBps) > BPS * BPS) {
                revert InvalidRiskParams();
            }
        }
        liquidationBonusBps = newBonusBps;
        closeFactorBps = newCloseFactorBps;
        emit LiquidationParamsUpdated(newBonusBps, newCloseFactorBps);
    }

    /// @notice Emergency stop for deposits, collateral deposits, borrowing and liquidation.
    ///         Repaying and withdrawing stay available so users are never locked in.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =====================================================================
    //                          LENDER FUNCTIONS
    // =====================================================================

    /// @notice Lend tokens to the pool. They can be borrowed by others and withdrawn by you later.
    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _requireSupported(asset);

        // Effects first...
        _deposits[msg.sender][asset] += amount;
        _totals[asset].deposits += amount.toUint128();

        // ...then the external call (checks-effects-interactions).
        _pull(asset, msg.sender, amount);
        emit Deposited(msg.sender, asset, amount);
    }

    /// @notice Withdraw previously deposited tokens, if the pool has enough idle liquidity.
    function withdraw(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 userDeposit = _deposits[msg.sender][asset]; // cache: read once
        if (amount > userDeposit) revert InsufficientDeposit();

        Totals memory t = _totals[asset]; // cache both fields with one SLOAD
        // Idle liquidity = deposits not currently lent out. Safe: borrows <= deposits is enforced in borrow().
        if (amount > t.deposits - t.borrows) revert InsufficientLiquidity();

        unchecked {
            // Safe: amount <= userDeposit and amount <= t.deposits (checked above).
            _deposits[msg.sender][asset] = userDeposit - amount;
            t.deposits -= uint128(amount);
        }
        _totals[asset] = t;

        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    // =====================================================================
    //                         BORROWER FUNCTIONS
    // =====================================================================

    /// @notice Lock tokens as collateral. Collateral is not lent to others.
    function depositCollateral(address asset, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _requireSupported(asset);

        _positions[msg.sender][asset].collateral += amount.toUint128();
        _totalCollateral[asset] += amount;

        _pull(asset, msg.sender, amount);
        emit CollateralDeposited(msg.sender, asset, amount);
    }

    /// @notice Take collateral back. Reverts if your loans would no longer be within the borrow limit.
    function withdrawCollateral(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Position storage pos = _positions[msg.sender][asset];
        uint128 current = pos.collateral;
        if (amount > current) revert InsufficientCollateral();

        unchecked {
            // Safe: amount <= current (checked above); totalCollateral >= every user's collateral.
            pos.collateral = current - uint128(amount);
            _totalCollateral[asset] -= amount;
        }

        // Health check AFTER the state change, so it sees the post-withdrawal position.
        (, uint256 debtValue, uint256 borrowCapacity,) = _accountValues(msg.sender);
        if (debtValue > borrowCapacity) revert ExceedsBorrowLimit();

        IERC20(asset).safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, asset, amount);
    }

    /// @notice Borrow tokens from the pool, up to your borrow limit and the pool's idle liquidity.
    function borrow(address asset, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _requireSupported(asset);

        Totals memory t = _totals[asset];
        if (amount > t.deposits - t.borrows) revert InsufficientLiquidity();

        uint128 amount128 = amount.toUint128();
        _positions[msg.sender][asset].debt += amount128;
        t.borrows += amount128; // <= t.deposits, so it can never exceed deposits
        _totals[asset] = t;

        (, uint256 debtValue, uint256 borrowCapacity,) = _accountValues(msg.sender);
        if (debtValue > borrowCapacity) revert ExceedsBorrowLimit();

        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, asset, amount);
    }

    /// @notice Repay debt. If `amount` is more than you owe, only the debt is taken.
    function repay(address asset, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Position storage pos = _positions[msg.sender][asset];
        uint128 debt = pos.debt;
        if (debt == 0) revert NothingToRepay();

        uint128 payment = amount > debt ? debt : uint128(amount);
        unchecked {
            // Safe: payment <= debt, and totals.borrows >= every user's debt.
            pos.debt = debt - payment;
            _totals[asset].borrows -= payment;
        }

        _pull(asset, msg.sender, payment);
        emit Repaid(msg.sender, asset, payment);
    }

    // =====================================================================
    //                            LIQUIDATION
    // =====================================================================

    /**
     * @notice Repay part of an unhealthy borrower's debt and receive their collateral at a discount.
     * @dev Rules:
     *   1. Borrower must be liquidatable: total debt value > liquidation capacity.
     *   2. You can repay at most `closeFactorBps` of the borrower's debt in `debtAsset` per call.
     *   3. You receive repaid value x (1 + liquidationBonus) of `collateralAsset`.
     *   4. If the borrower has less collateral than that, you get all of it and pay proportionally less.
     * @param borrower Account to liquidate.
     * @param debtAsset Token the borrower owes (and you will pay with).
     * @param collateralAsset Token you want to receive.
     * @param repayAmount Amount of `debtAsset` you want to repay.
     */
    function liquidate(address borrower, address debtAsset, address collateralAsset, uint256 repayAmount)
        external
        nonReentrant
        whenNotPaused
    {
        if (repayAmount == 0) revert ZeroAmount();
        if (borrower == msg.sender) revert CannotLiquidateSelf();

        // Validates both assets, then works out how much collateral is seized and how much debt is
        // really repaid (rules 3 and 4).
        (uint256 actualRepay, uint256 seizeAmount) =
            _computeSeize(borrower, debtAsset, collateralAsset, repayAmount);

        // Rules 1 and 2: unhealthy position + close factor.
        _checkLiquidation(borrower, debtAsset, repayAmount);
        if (actualRepay == 0 || seizeAmount == 0) revert NothingToSeize();

        // Effects. Storage pointers are used (not memory copies) so it is safe even if
        // debtAsset == collateralAsset.
        _positions[borrower][debtAsset].debt -= actualRepay.toUint128();
        _totals[debtAsset].borrows -= actualRepay.toUint128();
        _positions[borrower][collateralAsset].collateral -= seizeAmount.toUint128();
        _totalCollateral[collateralAsset] -= seizeAmount;

        // Interactions.
        _pull(debtAsset, msg.sender, actualRepay);
        IERC20(collateralAsset).safeTransfer(msg.sender, seizeAmount);
        emit Liquidated(msg.sender, borrower, debtAsset, collateralAsset, actualRepay, seizeAmount);
    }

    // =====================================================================
    //                               VIEWS
    // =====================================================================

    function depositOf(address user, address asset) external view returns (uint256) {
        return _deposits[user][asset];
    }

    function collateralOf(address user, address asset) external view returns (uint256) {
        return _positions[user][asset].collateral;
    }

    function debtOf(address user, address asset) external view returns (uint256) {
        return _positions[user][asset].debt;
    }

    function getTotals(address asset)
        external
        view
        returns (uint256 totalDeposits, uint256 totalBorrows, uint256 totalCollateral)
    {
        Totals memory t = _totals[asset];
        return (t.deposits, t.borrows, _totalCollateral[asset]);
    }

    /// @notice Tokens in the pool that are not lent out (what lenders can withdraw / others can borrow).
    function availableLiquidity(address asset) external view returns (uint256) {
        Totals memory t = _totals[asset];
        return t.deposits - t.borrows;
    }

    function getAssets() external view returns (address[] memory) {
        return _assets;
    }

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    /// @notice Collateral value, debt value, limits, collateral ratio and health factor of `user`.
    function getAccountData(address user) public view returns (AccountData memory data) {
        (data.collateralValue, data.debtValue, data.borrowCapacity, data.liquidationCapacity) =
            _accountValues(user);
        if (data.debtValue == 0) {
            data.collateralRatioBps = type(uint256).max;
            data.healthFactor = type(uint256).max;
        } else {
            data.collateralRatioBps = (data.collateralValue * BPS) / data.debtValue;
            data.healthFactor = (data.liquidationCapacity * HEALTH_PRECISION) / data.debtValue;
        }
    }

    /// @notice True if `user` can currently be liquidated.
    function isLiquidatable(address user) external view returns (bool) {
        (, uint256 debtValue,, uint256 liquidationCapacity) = _accountValues(user);
        return debtValue > liquidationCapacity;
    }

    /// @notice How much of `asset` `user` could borrow right now (limited by borrow power and pool liquidity).
    function maxBorrow(address user, address asset) external view returns (uint256) {
        AssetConfig memory cfg = assetConfig[asset];
        if (!cfg.supported) return 0;
        (, uint256 debtValue, uint256 borrowCapacity,) = _accountValues(user);
        if (debtValue >= borrowCapacity) return 0;
        uint256 byPower = Math.mulDiv(borrowCapacity - debtValue, 10 ** cfg.decimals, cfg.price);
        Totals memory t = _totals[asset];
        uint256 liquidity = t.deposits - t.borrows;
        return byPower < liquidity ? byPower : liquidity;
    }

    // =====================================================================
    //                            INTERNALS
    // =====================================================================

    function _addAsset(address token, uint128 price, uint16 ltvBps, uint16 liquidationThresholdBps) internal {
        if (token == address(0)) revert ZeroAddress();
        if (assetConfig[token].supported) revert AssetAlreadySupported(token);
        if (_assets.length >= MAX_ASSETS) revert TooManyAssets();
        if (price == 0) revert InvalidPrice();
        _validateRisk(ltvBps, liquidationThresholdBps, liquidationBonusBps);

        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        if (tokenDecimals > 18) revert InvalidDecimals();

        assetConfig[token] = AssetConfig({
            supported: true,
            decimals: tokenDecimals,
            ltvBps: ltvBps,
            liquidationThresholdBps: liquidationThresholdBps,
            price: price
        });
        _assets.push(token);
        emit AssetAdded(token, price, ltvBps, liquidationThresholdBps);
    }

    /// @dev ltv in (0, threshold]; threshold <= 95%; threshold * (1 + bonus) <= 100% so that
    ///      liquidating a position at the threshold never seizes more value than its collateral.
    function _validateRisk(uint16 ltvBps, uint16 thresholdBps, uint16 bonusBps) internal pure {
        if (ltvBps == 0 || ltvBps > thresholdBps || thresholdBps > MAX_LIQUIDATION_THRESHOLD_BPS) {
            revert InvalidRiskParams();
        }
        if (uint256(thresholdBps) * (BPS + bonusBps) > BPS * BPS) revert InvalidRiskParams();
    }

    function _requireSupported(address asset) internal view returns (AssetConfig memory cfg) {
        cfg = assetConfig[asset]; // one SLOAD, whole struct
        if (!cfg.supported) revert AssetNotSupported(asset);
    }

    /// @dev Pull tokens in and make sure we received exactly `amount` (rejects fee-on-transfer tokens).
    function _pull(address asset, address from, uint256 amount) internal {
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - balanceBefore != amount) revert UnsupportedTokenBehavior();
    }

    /// @dev Walks through all listed assets once and sums up the user's USD values.
    ///      Collateral values are rounded DOWN and debt values rounded UP (always conservative).
    function _accountValues(address user)
        internal
        view
        returns (uint256 collateralValue, uint256 debtValue, uint256 borrowCapacity, uint256 liquidationCapacity)
    {
        address[] memory assets = _assets; // copy array to memory once
        uint256 len = assets.length; // cache length
        for (uint256 i; i < len; ++i) {
            address asset = assets[i];
            Position memory pos = _positions[user][asset]; // 1 SLOAD for collateral AND debt
            if (pos.collateral == 0 && pos.debt == 0) continue; // skip assets the user does not use

            AssetConfig memory cfg = assetConfig[asset]; // 1 SLOAD
            uint256 unit = 10 ** cfg.decimals;

            if (pos.collateral != 0) {
                uint256 value = Math.mulDiv(pos.collateral, cfg.price, unit);
                collateralValue += value;
                borrowCapacity += (value * cfg.ltvBps) / BPS;
                liquidationCapacity += (value * cfg.liquidationThresholdBps) / BPS;
            }
            if (pos.debt != 0) {
                debtValue += Math.mulDiv(pos.debt, cfg.price, unit, Math.Rounding.Ceil);
            }
        }
    }

    /// @dev Reverts unless `borrower` is liquidatable and `repayAmount` respects the close factor.
    function _checkLiquidation(address borrower, address debtAsset, uint256 repayAmount) internal view {
        (, uint256 debtValue,, uint256 liquidationCapacity) = _accountValues(borrower);
        if (debtValue <= liquidationCapacity) revert PositionHealthy();

        uint256 borrowerDebt = _positions[borrower][debtAsset].debt;
        if (borrowerDebt == 0) revert NothingToRepay();
        uint256 maxRepay = (borrowerDebt * closeFactorBps) / BPS;
        if (maxRepay == 0) maxRepay = borrowerDebt; // tiny "dust" debts can be closed fully
        if (repayAmount > maxRepay) revert RepayExceedsCloseFactor(maxRepay);
    }

    /// @dev Converts a desired repayment into (actual repayment, collateral to seize).
    function _computeSeize(address borrower, address debtAsset, address collateralAsset, uint256 repayAmount)
        internal
        view
        returns (uint256 actualRepay, uint256 seizeAmount)
    {
        AssetConfig memory debtCfg = _requireSupported(debtAsset);
        AssetConfig memory collCfg = _requireSupported(collateralAsset);
        uint256 availableCollateral = _positions[borrower][collateralAsset].collateral;
        uint256 bonusFactor = BPS + liquidationBonusBps;

        // repaid value (USD) -> plus bonus -> collateral tokens (rounded down in the borrower's favour)
        uint256 repayValue = Math.mulDiv(repayAmount, debtCfg.price, 10 ** debtCfg.decimals);
        seizeAmount = Math.mulDiv((repayValue * bonusFactor) / BPS, 10 ** collCfg.decimals, collCfg.price);
        actualRepay = repayAmount;

        if (seizeAmount > availableCollateral) {
            // Not enough collateral: take everything and charge the liquidator proportionally less.
            seizeAmount = availableCollateral;
            uint256 availableValue = Math.mulDiv(availableCollateral, collCfg.price, 10 ** collCfg.decimals);
            actualRepay = Math.mulDiv((availableValue * BPS) / bonusFactor, 10 ** debtCfg.decimals, debtCfg.price);
        }
    }
}
