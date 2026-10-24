// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DeFiLendingProtocol} from "../contracts/DeFiLendingProtocol.sol";
import {MockERC20} from "../contracts/MockERC20.sol";

/**
 * @notice The Handler is the only contract the invariant fuzzer calls. Each of its functions is a
 *         "user action" with bounded random inputs. It also keeps "ghost" records that the invariants check.
 */
contract Handler is Test {
    DeFiLendingProtocol public protocol;
    MockERC20 public weth;
    MockERC20 public usdc;
    address[] public actors;

    // Ghost variables
    uint256 public ghostBorrowLimitViolations; // a borrow/withdrawCollateral succeeded but left debt > capacity
    uint256 public ghostHealthyLiquidations; // a liquidation succeeded on a healthy account
    uint256 public calls;
    uint256 public successfulLiquidations; // coverage: how often liquidation really happened

    constructor(DeFiLendingProtocol p, MockERC20 w, MockERC20 u) {
        protocol = p;
        weth = w;
        usdc = u;
        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            vm.startPrank(a);
            w.approve(address(p), type(uint256).max);
            u.approve(address(p), type(uint256).max);
            vm.stopPrank();
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (MockERC20) {
        return seed % 2 == 0 ? weth : usdc;
    }

    function deposit(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        amount = bound(amount, 1, t == weth ? 1_000e18 : 2_000_000e6);
        t.mint(a, amount);
        vm.prank(a);
        protocol.deposit(address(t), amount);
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 max = protocol.depositOf(a, address(t));
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(a);
        try protocol.withdraw(address(t), amount) {} catch {}
    }

    function depositCollateral(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        amount = bound(amount, 1, t == weth ? 500e18 : 1_000_000e6);
        t.mint(a, amount);
        vm.prank(a);
        protocol.depositCollateral(address(t), amount);
    }

    function withdrawCollateral(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 max = protocol.collateralOf(a, address(t));
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(a);
        try protocol.withdrawCollateral(address(t), amount) {
            DeFiLendingProtocol.AccountData memory d = protocol.getAccountData(a);
            if (d.debtValue > d.borrowCapacity) ghostBorrowLimitViolations++;
        } catch {}
    }

    function borrow(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        // Sometimes try more than allowed on purpose.
        uint256 max = protocol.maxBorrow(a, address(t));
        if (max > 0 && amount % 3 == 0) {
            amount = max; // often borrow the full limit so price drops can make the loan liquidatable
        } else {
            amount = bound(amount, 1, max == 0 ? 1 : max + max / 10 + 1);
        }
        vm.prank(a);
        try protocol.borrow(address(t), amount) {
            DeFiLendingProtocol.AccountData memory d = protocol.getAccountData(a);
            if (d.debtValue > d.borrowCapacity) ghostBorrowLimitViolations++;
        } catch {}
    }

    function repay(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        calls++;
        address a = _actor(actorSeed);
        MockERC20 t = _token(tokenSeed);
        uint256 debt = protocol.debtOf(a, address(t));
        if (debt == 0) return;
        amount = bound(amount, 1, debt * 2);
        t.mint(a, amount); // make sure they can pay
        vm.prank(a);
        try protocol.repay(address(t), amount) {} catch {}
    }

    /// @dev Moves the WETH price between $800 and $3,200 so positions become liquidatable now and then.
    function changePrice(uint256 newPrice) external {
        calls++;
        newPrice = bound(newPrice, 800e18, 3200e18);
        protocol.setAssetPrice(address(weth), uint128(newPrice)); // the Handler is the protocol owner
    }

    function liquidate(uint256 liquidatorSeed, uint256 borrowerSeed, uint256 debtSeed, uint256 amount) external {
        calls++;
        address liq = _actor(liquidatorSeed);
        address bor = _actor(borrowerSeed);
        MockERC20 debtToken = _token(debtSeed);
        MockERC20 collToken = debtToken == weth ? usdc : weth;
        uint256 debt = protocol.debtOf(bor, address(debtToken));
        if (debt == 0) return;
        amount = bound(amount, 1, debt);
        debtToken.mint(liq, amount);
        bool wasLiquidatable = protocol.isLiquidatable(bor);
        vm.prank(liq);
        try protocol.liquidate(bor, address(debtToken), address(collToken), amount) {
            successfulLiquidations++;
            if (!wasLiquidatable) ghostHealthyLiquidations++;
        } catch {}
    }
}

contract DeFiLendingProtocolInvariantTest is StdInvariant, Test {
    DeFiLendingProtocol internal protocol;
    MockERC20 internal weth;
    MockERC20 internal usdc;
    Handler internal handler;

    function setUp() public {
        protocol = new DeFiLendingProtocol(address(this));
        weth = new MockERC20("Mock WETH", "mWETH", 18);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        protocol.addAsset(address(weth), 2000e18, 7500, 8000);
        protocol.addAsset(address(usdc), 1e18, 8000, 8500);

        handler = new Handler(protocol, weth, usdc);
        protocol.transferOwnership(address(handler)); // handler needs to change prices
        vm.prank(address(handler));
        protocol.acceptOwnership();

        targetContract(address(handler)); // only call the handler
    }

    function _sum(address asset) internal view returns (uint256 dep, uint256 col, uint256 debt) {
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; ++i) {
            address a = handler.actors(i);
            dep += protocol.depositOf(a, asset);
            col += protocol.collateralOf(a, asset);
            debt += protocol.debtOf(a, asset);
        }
    }

    /// Per-user numbers always add up to the protocol-wide totals.
    function invariant_totalsMatchUserSums() public view {
        address[2] memory assets = [address(weth), address(usdc)];
        for (uint256 i; i < 2; ++i) {
            (uint256 dep, uint256 col, uint256 debt) = _sum(assets[i]);
            (uint256 tDep, uint256 tBor, uint256 tCol) = protocol.getTotals(assets[i]);
            assertEq(dep, tDep, "deposits");
            assertEq(col, tCol, "collateral");
            assertEq(debt, tBor, "borrows");
        }
    }

    /// The contract holds exactly: deposits + collateral - borrows (nobody can mint or steal tokens).
    function invariant_tokenBalanceMatchesAccounting() public view {
        MockERC20[2] memory tokens = [weth, usdc];
        for (uint256 i; i < 2; ++i) {
            (uint256 d, uint256 b, uint256 c) = protocol.getTotals(address(tokens[i]));
            assertEq(tokens[i].balanceOf(address(protocol)), d + c - b, "balance != d + c - b");
        }
    }

    /// Borrowed tokens never exceed lenders' deposits (no lending out of thin air).
    function invariant_borrowsNeverExceedDeposits() public view {
        address[2] memory assets = [address(weth), address(usdc)];
        for (uint256 i; i < 2; ++i) {
            (uint256 d, uint256 b,) = protocol.getTotals(assets[i]);
            assertLe(b, d, "borrows > deposits");
        }
    }

    /// borrow() and withdrawCollateral() never leave an account above its borrow limit.
    function invariant_noBorrowLimitViolationsByActions() public view {
        assertEq(handler.ghostBorrowLimitViolations(), 0);
    }

    /// Healthy accounts are never liquidated.
    function invariant_healthyAccountsNeverLiquidated() public view {
        assertEq(handler.ghostHealthyLiquidations(), 0);
    }
}
