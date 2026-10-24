// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title NaiveLendingProtocol  (BASELINE FOR GAS COMPARISON ONLY)
 * @notice Same core behaviour as DeFiLendingProtocol for deposit / depositCollateral / borrow /
 *         repay / withdraw / withdrawCollateral, but written the "obvious" way WITHOUT the gas
 *         optimizations: revert strings, one uint256 mapping per field (no packing), no caching of
 *         storage reads, repeated storage reads inside loops, `.length` read every iteration.
 *         It deliberately keeps the SAME safety features (ReentrancyGuard, SafeERC20, pause switch and
 *         fee-on-transfer check) so the comparison measures the optimizations, not missing security.
 *         It has no liquidation or close factor. Do NOT deploy it.
 */
contract NaiveLendingProtocol is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10000;

    // Unpacked storage: every field has its own slot (and its own SLOAD).
    mapping(address => bool) public supported;
    mapping(address => uint256) public decimalsOf;
    mapping(address => uint256) public ltvOf;
    mapping(address => uint256) public priceOf;
    address[] public assets;

    mapping(address => mapping(address => uint256)) public deposits;
    mapping(address => mapping(address => uint256)) public collateral;
    mapping(address => mapping(address => uint256)) public debt;
    mapping(address => uint256) public totalDeposits;
    mapping(address => uint256) public totalBorrows;
    mapping(address => uint256) public totalCollateral;

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event CollateralDeposited(address indexed user, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed user, address indexed asset, uint256 amount);
    event Borrowed(address indexed user, address indexed asset, uint256 amount);
    event Repaid(address indexed user, address indexed asset, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function addAsset(address token, uint256 price, uint256 ltv) external onlyOwner {
        require(!supported[token], "Asset already supported");
        supported[token] = true;
        decimalsOf[token] = IERC20Metadata(token).decimals();
        ltvOf[token] = ltv;
        priceOf[token] = price;
        assets.push(token);
    }

    function deposit(address asset, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(supported[asset], "Asset is not supported by this protocol");
        deposits[msg.sender][asset] = deposits[msg.sender][asset] + amount;
        totalDeposits[asset] = totalDeposits[asset] + amount;
        _pull(asset, amount);
        emit Deposited(msg.sender, asset, amount);
    }

    function withdraw(address asset, uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than zero");
        require(deposits[msg.sender][asset] >= amount, "Not enough deposited balance");
        require(totalDeposits[asset] - totalBorrows[asset] >= amount, "Not enough liquidity in pool");
        deposits[msg.sender][asset] = deposits[msg.sender][asset] - amount;
        totalDeposits[asset] = totalDeposits[asset] - amount;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, asset, amount);
    }

    function depositCollateral(address asset, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(supported[asset], "Asset is not supported by this protocol");
        collateral[msg.sender][asset] = collateral[msg.sender][asset] + amount;
        totalCollateral[asset] = totalCollateral[asset] + amount;
        _pull(asset, amount);
        emit CollateralDeposited(msg.sender, asset, amount);
    }

    function withdrawCollateral(address asset, uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than zero");
        require(collateral[msg.sender][asset] >= amount, "Not enough collateral deposited");
        collateral[msg.sender][asset] = collateral[msg.sender][asset] - amount;
        totalCollateral[asset] = totalCollateral[asset] - amount;
        require(_debtValue(msg.sender) <= _borrowCapacity(msg.sender), "Withdrawal would exceed borrow limit");
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, asset, amount);
    }

    function borrow(address asset, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(supported[asset], "Asset is not supported by this protocol");
        require(totalDeposits[asset] - totalBorrows[asset] >= amount, "Not enough liquidity in pool");
        debt[msg.sender][asset] = debt[msg.sender][asset] + amount;
        totalBorrows[asset] = totalBorrows[asset] + amount;
        require(_debtValue(msg.sender) <= _borrowCapacity(msg.sender), "Borrow exceeds collateral limit");
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, asset, amount);
    }

    function repay(address asset, uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than zero");
        require(debt[msg.sender][asset] > 0, "Nothing to repay");
        uint256 payment = amount;
        if (payment > debt[msg.sender][asset]) {
            payment = debt[msg.sender][asset];
        }
        debt[msg.sender][asset] = debt[msg.sender][asset] - payment;
        totalBorrows[asset] = totalBorrows[asset] - payment;
        _pull(asset, payment);
        emit Repaid(msg.sender, asset, payment);
    }

    function _pull(address asset, uint256 amount) internal {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        require(IERC20(asset).balanceOf(address(this)) - balanceBefore == amount, "Token takes a fee on transfer");
    }

    // Unoptimized loops: `assets.length` and every mapping are re-read on each iteration.
    function _borrowCapacity(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < assets.length; i++) {
            address a = assets[i];
            uint256 value = (collateral[user][a] * priceOf[a]) / (10 ** decimalsOf[a]);
            total = total + (value * ltvOf[a]) / BPS;
        }
    }

    function _debtValue(address user) internal view returns (uint256 total) {
        for (uint256 i = 0; i < assets.length; i++) {
            address a = assets[i];
            total = total + (debt[user][a] * priceOf[a]) / (10 ** decimalsOf[a]);
        }
    }
}
