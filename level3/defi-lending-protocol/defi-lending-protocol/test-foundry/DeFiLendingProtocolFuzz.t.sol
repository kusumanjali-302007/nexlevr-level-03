// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeFiLendingProtocol} from "../contracts/DeFiLendingProtocol.sol";
import {MockERC20} from "../contracts/MockERC20.sol";

/// @notice Property-based (fuzz) tests. Foundry calls each `testFuzz_*` function with many random inputs.
contract DeFiLendingProtocolFuzzTest is Test {
    DeFiLendingProtocol internal protocol;
    MockERC20 internal weth; // 18 decimals, $2000, 75% LTV, 80% threshold
    MockERC20 internal usdc; // 6 decimals,  $1,    80% LTV, 85% threshold

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    uint256 internal constant POOL = 10_000_000e6; // 10M USDC of liquidity
    uint256 internal constant MAX_COLLATERAL = 1_000_000e18;

    function setUp() public {
        protocol = new DeFiLendingProtocol(address(this));
        weth = new MockERC20("Mock WETH", "mWETH", 18);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        protocol.addAsset(address(weth), 2000e18, 7500, 8000);
        protocol.addAsset(address(usdc), 1e18, 8000, 8500);

        usdc.mint(lender, POOL);
        _approve(lender);
        vm.prank(lender);
        protocol.deposit(address(usdc), POOL);

        _approve(borrower);
        _approve(liquidator);
        usdc.mint(liquidator, POOL);
    }

    function _approve(address who) internal {
        vm.startPrank(who);
        weth.approve(address(protocol), type(uint256).max);
        usdc.approve(address(protocol), type(uint256).max);
        vm.stopPrank();
    }

    function _lockCollateral(uint256 amount) internal {
        weth.mint(borrower, amount);
        vm.prank(borrower);
        protocol.depositCollateral(address(weth), amount);
    }

    // --- Property 1: users cannot borrow above the allowed collateral limit ---------------------
    function testFuzz_cannotBorrowAboveLimit(uint256 collateralAmount, uint256 borrowAmount) public {
        collateralAmount = bound(collateralAmount, 1e15, MAX_COLLATERAL);
        borrowAmount = bound(borrowAmount, 1, POOL);
        _lockCollateral(collateralAmount);

        // Borrow limit in USDC units: collateral * $2000 * 75% -> 6 decimals.
        uint256 limit = (collateralAmount * 2000 * 7500) / 10_000 / 1e12;
        if (limit > POOL) limit = POOL;

        vm.prank(borrower);
        if (borrowAmount > limit + 1) {
            // (limit + 1 allows for rounding in the protocol's conservative USD conversion)
            vm.expectRevert();
            protocol.borrow(address(usdc), borrowAmount);
        } else {
            try protocol.borrow(address(usdc), borrowAmount) {} catch {}
        }

        // Whatever happened, the account must never end up above its borrow capacity.
        DeFiLendingProtocol.AccountData memory d = protocol.getAccountData(borrower);
        assertLe(d.debtValue, d.borrowCapacity, "debt exceeds borrow capacity");
    }

    // --- Property 2: debt accounting stays consistent --------------------------------------------
    function testFuzz_debtAccountingConsistent(uint256 collateralAmount, uint256 borrowAmount, uint256 repayAmount)
        public
    {
        collateralAmount = bound(collateralAmount, 1e18, MAX_COLLATERAL);
        _lockCollateral(collateralAmount);
        uint256 maxBorrow = protocol.maxBorrow(borrower, address(usdc));
        borrowAmount = bound(borrowAmount, 1, maxBorrow);

        vm.prank(borrower);
        protocol.borrow(address(usdc), borrowAmount);
        assertEq(protocol.debtOf(borrower, address(usdc)), borrowAmount);
        (, uint256 borrowsAfterBorrow,) = protocol.getTotals(address(usdc));
        assertEq(borrowsAfterBorrow, borrowAmount);
        assertEq(protocol.availableLiquidity(address(usdc)), POOL - borrowAmount);

        repayAmount = bound(repayAmount, 1, borrowAmount * 2); // may overshoot on purpose
        uint256 expectedPaid = repayAmount > borrowAmount ? borrowAmount : repayAmount;
        uint256 balanceBefore = usdc.balanceOf(borrower);
        usdc.mint(borrower, borrowAmount); // make sure an over-repay attempt is affordable
        vm.prank(borrower);
        protocol.repay(address(usdc), repayAmount);

        assertEq(protocol.debtOf(borrower, address(usdc)), borrowAmount - expectedPaid, "debt after repay");
        (, uint256 borrowsAfterRepay,) = protocol.getTotals(address(usdc));
        assertEq(borrowsAfterRepay, borrowAmount - expectedPaid, "totalBorrows after repay");
        assertEq(usdc.balanceOf(borrower), balanceBefore + borrowAmount - expectedPaid, "tokens taken");
    }

    // --- Property 3: cannot withdraw collateral that secures a loan ------------------------------
    function testFuzz_cannotWithdrawRequiredCollateral(uint256 collateralAmount, uint256 borrowFraction, uint256 withdrawAmount)
        public
    {
        collateralAmount = bound(collateralAmount, 1e18, MAX_COLLATERAL);
        _lockCollateral(collateralAmount);
        uint256 maxBorrow = protocol.maxBorrow(borrower, address(usdc));
        uint256 borrowAmount = bound(borrowFraction, 1, maxBorrow);
        vm.prank(borrower);
        protocol.borrow(address(usdc), borrowAmount);

        withdrawAmount = bound(withdrawAmount, 1, collateralAmount);
        vm.prank(borrower);
        try protocol.withdrawCollateral(address(weth), withdrawAmount) {
            // If it succeeded, the loan must still be inside the borrow limit.
            DeFiLendingProtocol.AccountData memory d = protocol.getAccountData(borrower);
            assertLe(d.debtValue, d.borrowCapacity, "withdrawal left loan undercollateralized");
        } catch {
            // Reverted: collateral must be unchanged.
            assertEq(protocol.collateralOf(borrower, address(weth)), collateralAmount);
        }
    }

    // --- Property 4: unauthorized users cannot change configuration ------------------------------
    function testFuzz_unauthorizedCannotConfigure(address caller, uint128 price, uint16 ltv, uint16 threshold) public {
        vm.assume(caller != address(this));
        vm.startPrank(caller);
        vm.expectRevert();
        protocol.addAsset(address(0xBEEF), price, ltv, threshold);
        vm.expectRevert();
        protocol.setAssetPrice(address(weth), price);
        vm.expectRevert();
        protocol.setAssetRisk(address(weth), ltv, threshold);
        vm.expectRevert();
        protocol.setLiquidationParams(ltv, threshold);
        vm.expectRevert();
        protocol.pause();
        vm.expectRevert();
        protocol.transferOwnership(caller);
        vm.stopPrank();

        assertEq(protocol.owner(), address(this));
        (, , , , uint128 currentPrice) = protocol.assetConfig(address(weth));
        assertEq(currentPrice, 2000e18);
    }

    // --- Property 5: repayment never goes below zero / never takes more than owed ----------------
    function testFuzz_repayNeverExceedsDebt(uint256 borrowAmount, uint256 repayAmount) public {
        _lockCollateral(100e18); // $200k, $150k limit
        borrowAmount = bound(borrowAmount, 1, 150_000e6);
        vm.prank(borrower);
        protocol.borrow(address(usdc), borrowAmount);

        repayAmount = bound(repayAmount, 1, type(uint128).max);
        usdc.mint(borrower, repayAmount);
        uint256 before_ = usdc.balanceOf(borrower);
        vm.prank(borrower);
        protocol.repay(address(usdc), repayAmount);

        uint256 paid = before_ - usdc.balanceOf(borrower);
        assertLe(paid, borrowAmount, "paid more than owed");
        assertEq(protocol.debtOf(borrower, address(usdc)), borrowAmount - paid);
    }

    // --- Extra: deposit/withdraw roundtrip returns exactly the same amount -----------------------
    function testFuzz_depositWithdrawRoundtrip(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000e6);
        usdc.mint(borrower, amount);
        uint256 before_ = usdc.balanceOf(borrower);
        vm.startPrank(borrower);
        protocol.deposit(address(usdc), amount);
        protocol.withdraw(address(usdc), amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(borrower), before_);
        assertEq(protocol.depositOf(borrower, address(usdc)), 0);
    }

    // --- Extra: liquidation never succeeds on healthy accounts and keeps accounting exact ---------
    function testFuzz_liquidationRules(uint256 newPrice, uint256 repayAmount) public {
        _lockCollateral(10e18);
        vm.prank(borrower);
        protocol.borrow(address(usdc), 15_000e6); // the max at $2000

        newPrice = bound(newPrice, 100e18, 4000e18);
        protocol.setAssetPrice(address(weth), uint128(newPrice));
        repayAmount = bound(repayAmount, 1, 15_000e6);

        bool liquidatable = protocol.isLiquidatable(borrower);
        (uint256 depBefore, uint256 borBefore, uint256 colBefore) = protocol.getTotals(address(usdc));
        uint256 collBefore = protocol.collateralOf(borrower, address(weth));

        vm.prank(liquidator);
        try protocol.liquidate(borrower, address(usdc), address(weth), repayAmount) {
            assertTrue(liquidatable, "liquidated a healthy account");
            assertLe(repayAmount, 7_500e6, "close factor violated");
            uint256 debtNow = protocol.debtOf(borrower, address(usdc));
            (uint256 dep, uint256 bor, uint256 col) = protocol.getTotals(address(usdc));
            assertEq(dep, depBefore);
            assertEq(col, colBefore);
            assertEq(bor, debtNow, "totalBorrows != borrower debt");
            assertLt(bor, borBefore);
            assertLt(protocol.collateralOf(borrower, address(weth)), collBefore);
        } catch {
            // Reverts are fine; state must be untouched.
            assertEq(protocol.debtOf(borrower, address(usdc)), 15_000e6);
        }
    }
}
