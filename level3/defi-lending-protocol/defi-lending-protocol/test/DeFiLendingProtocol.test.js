const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ---------------------------------------------------------------------------
// Helpers and constants
// ---------------------------------------------------------------------------
const e18 = (n) => ethers.parseUnits(String(n), 18); // 18-decimals amount / USD price
const usdc = (n) => ethers.parseUnits(String(n), 6); // 6-decimals amount
const WETH_PRICE = e18(2000);
const ONE_USD = e18(1);
const REENTRANCY_SELECTOR = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);

async function deployFixture() {
  const [owner, lender, borrower, liquidator, other] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const weth = await Mock.deploy("Mock WETH", "mWETH", 18);
  const usdcToken = await Mock.deploy("Mock USDC", "mUSDC", 6);
  const dai = await Mock.deploy("Mock DAI", "mDAI", 18);

  const Protocol = await ethers.getContractFactory("DeFiLendingProtocol");
  const protocol = await Protocol.deploy(owner.address);

  // WETH: 75% LTV / 80% liquidation threshold. USDC: 80% / 85%. DAI: 75% / 80%.
  await protocol.addAsset(await weth.getAddress(), WETH_PRICE, 7500, 8000);
  await protocol.addAsset(await usdcToken.getAddress(), ONE_USD, 8000, 8500);
  await protocol.addAsset(await dai.getAddress(), ONE_USD, 7500, 8000);

  const protocolAddr = await protocol.getAddress();

  // Fund and approve everybody.
  for (const [token, who, amount] of [
    [usdcToken, lender, usdc(100_000)],
    [dai, lender, e18(50_000)],
    [weth, borrower, e18(10)],
    [usdcToken, liquidator, usdc(100_000)],
    [dai, liquidator, e18(50_000)],
  ]) {
    await token.mint(who.address, amount);
  }
  for (const token of [weth, usdcToken, dai]) {
    for (const who of [lender, borrower, liquidator, other]) {
      await token.connect(who).approve(protocolAddr, ethers.MaxUint256);
    }
  }

  return { protocol, protocolAddr, weth, usdcToken, dai, owner, lender, borrower, liquidator, other };
}

// Lender supplies 100k USDC + 50k DAI, borrower locks 10 WETH ($20,000 => borrow limit $15,000).
async function liquidityFixture() {
  const f = await deployFixture();
  await f.protocol.connect(f.lender).deposit(await f.usdcToken.getAddress(), usdc(100_000));
  await f.protocol.connect(f.lender).deposit(await f.dai.getAddress(), e18(50_000));
  await f.protocol.connect(f.borrower).depositCollateral(await f.weth.getAddress(), e18(10));
  return f;
}

// Borrower has borrowed the maximum $15,000 USDC against 10 WETH.
async function loanFixture() {
  const f = await liquidityFixture();
  await f.protocol.connect(f.borrower).borrow(await f.usdcToken.getAddress(), usdc(15_000));
  return f;
}

describe("DeFiLendingProtocol", function () {
  // =========================================================================
  describe("Deployment and configuration", function () {
    it("sets the owner and default risk parameters", async function () {
      const { protocol, owner } = await loadFixture(deployFixture);
      expect(await protocol.owner()).to.equal(owner.address);
      expect(await protocol.liquidationBonusBps()).to.equal(500);
      expect(await protocol.closeFactorBps()).to.equal(5000);
      expect(await protocol.assetCount()).to.equal(3);
    });

    it("stores asset configuration (packed) correctly", async function () {
      const { protocol, weth } = await loadFixture(deployFixture);
      const cfg = await protocol.assetConfig(await weth.getAddress());
      expect(cfg.supported).to.equal(true);
      expect(cfg.decimals).to.equal(18);
      expect(cfg.ltvBps).to.equal(7500);
      expect(cfg.liquidationThresholdBps).to.equal(8000);
      expect(cfg.price).to.equal(WETH_PRICE);
    });

    it("emits AssetAdded when listing an asset", async function () {
      const { protocol } = await loadFixture(deployFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const t = await Mock.deploy("T", "T", 8);
      await expect(protocol.addAsset(await t.getAddress(), ONE_USD, 5000, 6000))
        .to.emit(protocol, "AssetAdded")
        .withArgs(await t.getAddress(), ONE_USD, 5000, 6000);
    });

    it("can list several assets in one call (calldata array)", async function () {
      const { protocol } = await loadFixture(deployFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const a = await Mock.deploy("A", "A", 18);
      const b = await Mock.deploy("B", "B", 6);
      await protocol.addAssets([
        { token: await a.getAddress(), price: ONE_USD, ltvBps: 5000, liquidationThresholdBps: 6000 },
        { token: await b.getAddress(), price: ONE_USD, ltvBps: 5000, liquidationThresholdBps: 6000 },
      ]);
      expect(await protocol.assetCount()).to.equal(5);
    });

    it("rejects invalid asset settings", async function () {
      const { protocol, weth } = await loadFixture(deployFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const t = await Mock.deploy("T", "T", 18);
      const addr = await t.getAddress();
      await expect(protocol.addAsset(ethers.ZeroAddress, ONE_USD, 5000, 6000)).to.be.revertedWithCustomError(
        protocol,
        "ZeroAddress"
      );
      await expect(protocol.addAsset(await weth.getAddress(), ONE_USD, 5000, 6000))
        .to.be.revertedWithCustomError(protocol, "AssetAlreadySupported")
        .withArgs(await weth.getAddress());
      await expect(protocol.addAsset(addr, 0, 5000, 6000)).to.be.revertedWithCustomError(protocol, "InvalidPrice");
      await expect(protocol.addAsset(addr, ONE_USD, 0, 6000)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
      await expect(protocol.addAsset(addr, ONE_USD, 7000, 6000)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams"); // ltv > threshold
      await expect(protocol.addAsset(addr, ONE_USD, 9000, 9600)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams"); // > 95%
    });

    it("rejects tokens with more than 18 decimals and more than MAX_ASSETS assets", async function () {
      const { protocol } = await loadFixture(deployFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const big = await Mock.deploy("Big", "BIG", 24);
      await expect(protocol.addAsset(await big.getAddress(), ONE_USD, 5000, 6000)).to.be.revertedWithCustomError(
        protocol,
        "InvalidDecimals"
      );
      for (let i = 0; i < 13; i++) {
        const t = await Mock.deploy("T", "T", 18);
        await protocol.addAsset(await t.getAddress(), ONE_USD, 5000, 6000);
      }
      expect(await protocol.assetCount()).to.equal(16);
      const extra = await Mock.deploy("X", "X", 18);
      await expect(protocol.addAsset(await extra.getAddress(), ONE_USD, 5000, 6000)).to.be.revertedWithCustomError(
        protocol,
        "TooManyAssets"
      );
    });

    it("owner can update price, risk and liquidation parameters", async function () {
      const { protocol, weth } = await loadFixture(deployFixture);
      const addr = await weth.getAddress();
      await expect(protocol.setAssetPrice(addr, e18(1500)))
        .to.emit(protocol, "AssetPriceUpdated")
        .withArgs(addr, WETH_PRICE, e18(1500));
      await expect(protocol.setAssetRisk(addr, 7000, 7500)).to.emit(protocol, "AssetRiskUpdated").withArgs(addr, 7000, 7500);
      await expect(protocol.setLiquidationParams(1000, 6000))
        .to.emit(protocol, "LiquidationParamsUpdated")
        .withArgs(1000, 6000);
      expect(await protocol.liquidationBonusBps()).to.equal(1000);
      expect(await protocol.closeFactorBps()).to.equal(6000);
    });

    it("rejects invalid updates", async function () {
      const { protocol, weth, other } = await loadFixture(deployFixture);
      const addr = await weth.getAddress();
      await expect(protocol.setAssetPrice(addr, 0)).to.be.revertedWithCustomError(protocol, "InvalidPrice");
      await expect(protocol.setAssetPrice(other.address, 1)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
      await expect(protocol.setAssetRisk(other.address, 5000, 6000)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
      await expect(protocol.setAssetRisk(addr, 8100, 8000)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
      await expect(protocol.setLiquidationParams(2001, 5000)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
      await expect(protocol.setLiquidationParams(500, 0)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
      await expect(protocol.setLiquidationParams(500, 10001)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
      // A 20% bonus would make USDC's 85% threshold unsafe (85% * 1.2 > 100%).
      await expect(protocol.setLiquidationParams(2000, 5000)).to.be.revertedWithCustomError(protocol, "InvalidRiskParams");
    });

    it("blocks every configuration function for non-owners", async function () {
      const { protocol, weth, other } = await loadFixture(deployFixture);
      const addr = await weth.getAddress();
      const p = protocol.connect(other);
      const denied = (tx) => expect(tx).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount").withArgs(other.address);
      await denied(p.addAsset(addr, ONE_USD, 5000, 6000));
      await denied(p.addAssets([]));
      await denied(p.setAssetPrice(addr, ONE_USD));
      await denied(p.setAssetRisk(addr, 5000, 6000));
      await denied(p.setLiquidationParams(500, 5000));
      await denied(p.pause());
      await denied(p.unpause());
    });

    it("uses two-step ownership transfer", async function () {
      const { protocol, owner, other } = await loadFixture(deployFixture);
      await protocol.transferOwnership(other.address);
      expect(await protocol.owner()).to.equal(owner.address); // not yet!
      await expect(protocol.connect(other).acceptOwnership()).to.not.be.reverted;
      expect(await protocol.owner()).to.equal(other.address);
    });
  });

  // =========================================================================
  describe("Deposits and withdrawals", function () {
    it("deposits tokens, updates balances and emits Deposited", async function () {
      const { protocol, protocolAddr, usdcToken, lender } = await loadFixture(deployFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(lender).deposit(addr, usdc(1000)))
        .to.emit(protocol, "Deposited")
        .withArgs(lender.address, addr, usdc(1000));
      expect(await protocol.depositOf(lender.address, addr)).to.equal(usdc(1000));
      expect(await usdcToken.balanceOf(protocolAddr)).to.equal(usdc(1000));
      const [deposits, borrows, collateral] = await protocol.getTotals(addr);
      expect([deposits, borrows, collateral]).to.deep.equal([usdc(1000), 0n, 0n]);
    });

    it("rejects zero amounts and unsupported assets", async function () {
      const { protocol, usdcToken, lender, other } = await loadFixture(deployFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(lender).deposit(addr, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
      await expect(protocol.connect(lender).deposit(other.address, 1))
        .to.be.revertedWithCustomError(protocol, "AssetNotSupported")
        .withArgs(other.address);
    });

    it("fails with insufficient allowance or balance (ERC-20 errors bubble up)", async function () {
      const { protocol, usdcToken, lender, other } = await loadFixture(deployFixture);
      const addr = await usdcToken.getAddress();
      await usdcToken.connect(lender).approve(await protocol.getAddress(), usdc(10));
      await expect(protocol.connect(lender).deposit(addr, usdc(11))).to.be.revertedWithCustomError(
        usdcToken,
        "ERC20InsufficientAllowance"
      );
      // `other` has approved but owns no tokens.
      await expect(protocol.connect(other).deposit(addr, usdc(1))).to.be.revertedWithCustomError(
        usdcToken,
        "ERC20InsufficientBalance"
      );
    });

    it("withdraws deposited tokens and emits Withdrawn", async function () {
      const { protocol, usdcToken, lender } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(lender).withdraw(addr, usdc(40_000)))
        .to.emit(protocol, "Withdrawn")
        .withArgs(lender.address, addr, usdc(40_000));
      expect(await protocol.depositOf(lender.address, addr)).to.equal(usdc(60_000));
      expect(await usdcToken.balanceOf(lender.address)).to.equal(usdc(40_000));
    });

    it("rejects withdrawing more than deposited, zero, or someone else's money", async function () {
      const { protocol, usdcToken, lender, other } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(lender).withdraw(addr, usdc(100_001))).to.be.revertedWithCustomError(protocol, "InsufficientDeposit");
      await expect(protocol.connect(lender).withdraw(addr, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
      await expect(protocol.connect(other).withdraw(addr, 1)).to.be.revertedWithCustomError(protocol, "InsufficientDeposit");
    });

    it("rejects withdrawals when the pool's liquidity is lent out", async function () {
      const { protocol, usdcToken, lender, borrower } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      await protocol.connect(borrower).borrow(addr, usdc(15_000));
      await expect(protocol.connect(lender).withdraw(addr, usdc(85_001))).to.be.revertedWithCustomError(
        protocol,
        "InsufficientLiquidity"
      );
      await expect(protocol.connect(lender).withdraw(addr, usdc(85_000))).to.not.be.reverted; // boundary
    });
  });

  // =========================================================================
  describe("Collateral", function () {
    it("deposits collateral and emits CollateralDeposited", async function () {
      const { protocol, weth, borrower } = await loadFixture(deployFixture);
      const addr = await weth.getAddress();
      await expect(protocol.connect(borrower).depositCollateral(addr, e18(5)))
        .to.emit(protocol, "CollateralDeposited")
        .withArgs(borrower.address, addr, e18(5));
      expect(await protocol.collateralOf(borrower.address, addr)).to.equal(e18(5));
      const [, , totalCollateral] = await protocol.getTotals(addr);
      expect(totalCollateral).to.equal(e18(5));
    });

    it("rejects zero, unsupported asset and too-large amounts", async function () {
      const { protocol, weth, borrower, other } = await loadFixture(deployFixture);
      const addr = await weth.getAddress();
      await expect(protocol.connect(borrower).depositCollateral(addr, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
      await expect(protocol.connect(borrower).depositCollateral(other.address, 1)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
      await expect(protocol.connect(borrower).depositCollateral(addr, e18(11))).to.be.revertedWithCustomError(weth, "ERC20InsufficientBalance");
    });

    it("withdraws collateral freely when there is no debt", async function () {
      const { protocol, weth, borrower } = await loadFixture(liquidityFixture);
      const addr = await weth.getAddress();
      await expect(protocol.connect(borrower).withdrawCollateral(addr, e18(10)))
        .to.emit(protocol, "CollateralWithdrawn")
        .withArgs(borrower.address, addr, e18(10));
      expect(await weth.balanceOf(borrower.address)).to.equal(e18(10));
    });

    it("rejects withdrawing more collateral than deposited", async function () {
      const { protocol, weth, borrower, other } = await loadFixture(liquidityFixture);
      const addr = await weth.getAddress();
      await expect(protocol.connect(borrower).withdrawCollateral(addr, e18(10) + 1n)).to.be.revertedWithCustomError(protocol, "InsufficientCollateral");
      await expect(protocol.connect(other).withdrawCollateral(addr, 1)).to.be.revertedWithCustomError(protocol, "InsufficientCollateral");
      await expect(protocol.connect(borrower).withdrawCollateral(addr, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
    });

    it("blocks withdrawals that would undercollateralize a loan (exact boundary)", async function () {
      const { protocol, usdcToken, weth, borrower } = await loadFixture(liquidityFixture);
      await protocol.connect(borrower).borrow(await usdcToken.getAddress(), usdc(10_000));
      const addr = await weth.getAddress();
      // $10,000 debt at 75% LTV needs >= 6.666666666666666667 WETH of collateral.
      await expect(protocol.connect(borrower).withdrawCollateral(addr, 3_333_333_333_333_333_334n)).to.be.revertedWithCustomError(
        protocol,
        "ExceedsBorrowLimit"
      );
      await expect(protocol.connect(borrower).withdrawCollateral(addr, 3_333_333_333_333_333_333n)).to.not.be.reverted;
    });

    it("blocks withdrawing all collateral while a loan is open", async function () {
      const { protocol, weth, borrower } = await loadFixture(loanFixture);
      await expect(protocol.connect(borrower).withdrawCollateral(await weth.getAddress(), e18(10))).to.be.revertedWithCustomError(
        protocol,
        "ExceedsBorrowLimit"
      );
    });

    it("allows full collateral withdrawal after the loan is repaid", async function () {
      const { protocol, weth, usdcToken, borrower } = await loadFixture(loanFixture);
      await usdcToken.mint(borrower.address, usdc(0)); // no-op mint, keeps the intent obvious
      await protocol.connect(borrower).repay(await usdcToken.getAddress(), usdc(15_000)); // has exactly 15,000 USDC from borrowing
      await expect(protocol.connect(borrower).withdrawCollateral(await weth.getAddress(), e18(10))).to.not.be.reverted;
    });
  });

  // =========================================================================
  describe("Borrowing", function () {
    it("borrows within the limit and emits Borrowed", async function () {
      const { protocol, protocolAddr, usdcToken, borrower } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(borrower).borrow(addr, usdc(10_000)))
        .to.emit(protocol, "Borrowed")
        .withArgs(borrower.address, addr, usdc(10_000));
      expect(await protocol.debtOf(borrower.address, addr)).to.equal(usdc(10_000));
      expect(await usdcToken.balanceOf(borrower.address)).to.equal(usdc(10_000));
      expect(await usdcToken.balanceOf(protocolAddr)).to.equal(usdc(90_000));
      const [deposits, borrows] = await protocol.getTotals(addr);
      expect(deposits).to.equal(usdc(100_000));
      expect(borrows).to.equal(usdc(10_000));
      expect(await protocol.availableLiquidity(addr)).to.equal(usdc(90_000));
    });

    it("allows borrowing exactly the limit but not one unit more", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      // 10 WETH = $20,000 x 75% = $15,000 limit.
      await expect(protocol.connect(borrower).borrow(addr, usdc(15_000) + 1n)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
      await expect(protocol.connect(borrower).borrow(addr, usdc(15_000))).to.not.be.reverted;
      await expect(protocol.connect(borrower).borrow(addr, 1)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
    });

    it("cannot borrow without collateral", async function () {
      const { protocol, usdcToken, other } = await loadFixture(liquidityFixture);
      await expect(protocol.connect(other).borrow(await usdcToken.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
    });

    it("rejects zero amounts and unsupported assets", async function () {
      const { protocol, usdcToken, borrower, other } = await loadFixture(liquidityFixture);
      await expect(protocol.connect(borrower).borrow(await usdcToken.getAddress(), 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
      await expect(protocol.connect(borrower).borrow(other.address, 1)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
    });

    it("rejects borrowing more than the pool holds, and exactly drains it at the boundary", async function () {
      const { protocol, usdcToken, weth, borrower, lender } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      await weth.mint(borrower.address, e18(90));
      await protocol.connect(borrower).depositCollateral(await weth.getAddress(), e18(90)); // 100 WETH => $150k limit
      await expect(protocol.connect(borrower).borrow(addr, usdc(100_001))).to.be.revertedWithCustomError(protocol, "InsufficientLiquidity");
      await protocol.connect(borrower).borrow(addr, usdc(100_000));
      expect(await protocol.availableLiquidity(addr)).to.equal(0);
      await expect(protocol.connect(borrower).borrow(addr, 1)).to.be.revertedWithCustomError(protocol, "InsufficientLiquidity");
      await expect(protocol.connect(lender).withdraw(addr, 1)).to.be.revertedWithCustomError(protocol, "InsufficientLiquidity");
    });

    it("shares one borrow limit across several borrowed assets", async function () {
      const { protocol, usdcToken, dai, borrower } = await loadFixture(liquidityFixture);
      await protocol.connect(borrower).borrow(await usdcToken.getAddress(), usdc(8_000));
      await protocol.connect(borrower).borrow(await dai.getAddress(), e18(7_000)); // total $15,000 = limit
      await expect(protocol.connect(borrower).borrow(await dai.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
    });

    it("lets collateral in several assets back one loan", async function () {
      const { protocol, usdcToken, dai, borrower } = await loadFixture(liquidityFixture);
      await dai.mint(borrower.address, e18(4_000)); // $4,000 x 75% = $3,000 extra borrowing power
      await protocol.connect(borrower).depositCollateral(await dai.getAddress(), e18(4_000));
      await expect(protocol.connect(borrower).borrow(await usdcToken.getAddress(), usdc(18_000))).to.not.be.reverted;
      await expect(protocol.connect(borrower).borrow(await usdcToken.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
    });

    it("maxBorrow reports remaining capacity", async function () {
      const { protocol, usdcToken, borrower, other } = await loadFixture(liquidityFixture);
      const addr = await usdcToken.getAddress();
      expect(await protocol.maxBorrow(borrower.address, addr)).to.equal(usdc(15_000));
      await protocol.connect(borrower).borrow(addr, usdc(5_000));
      expect(await protocol.maxBorrow(borrower.address, addr)).to.equal(usdc(10_000));
      expect(await protocol.maxBorrow(other.address, addr)).to.equal(0);
      expect(await protocol.maxBorrow(borrower.address, other.address)).to.equal(0); // unsupported asset
    });
  });

  // =========================================================================
  describe("Repayment", function () {
    it("repays partially and emits Repaid", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(borrower).repay(addr, usdc(5_000)))
        .to.emit(protocol, "Repaid")
        .withArgs(borrower.address, addr, usdc(5_000));
      expect(await protocol.debtOf(borrower.address, addr)).to.equal(usdc(10_000));
      const [, borrows] = await protocol.getTotals(addr);
      expect(borrows).to.equal(usdc(10_000));
    });

    it("repays in full", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await protocol.connect(borrower).repay(addr, usdc(15_000));
      expect(await protocol.debtOf(borrower.address, addr)).to.equal(0);
      expect(await protocol.availableLiquidity(addr)).to.equal(usdc(100_000));
    });

    it("caps over-repayment at the outstanding debt (debt never goes below zero)", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await usdcToken.mint(borrower.address, usdc(5_000)); // extra funds
      await expect(protocol.connect(borrower).repay(addr, usdc(20_000)))
        .to.emit(protocol, "Repaid")
        .withArgs(borrower.address, addr, usdc(15_000)); // only 15,000 taken
      expect(await usdcToken.balanceOf(borrower.address)).to.equal(usdc(5_000));
      expect(await protocol.debtOf(borrower.address, addr)).to.equal(0);
    });

    it("fails when there is nothing to repay or the amount is zero", async function () {
      const { protocol, usdcToken, borrower, other } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(other).repay(addr, 1)).to.be.revertedWithCustomError(protocol, "NothingToRepay");
      await expect(protocol.connect(borrower).repay(addr, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
    });

    it("fails with insufficient allowance or balance", async function () {
      const { protocol, protocolAddr, usdcToken, borrower } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await usdcToken.connect(borrower).approve(protocolAddr, usdc(100));
      await expect(protocol.connect(borrower).repay(addr, usdc(101))).to.be.revertedWithCustomError(usdcToken, "ERC20InsufficientAllowance");
      await usdcToken.connect(borrower).approve(protocolAddr, ethers.MaxUint256);
      await usdcToken.connect(borrower).transfer(ethers.Wallet.createRandom().address, usdc(15_000)); // lose the funds
      await expect(protocol.connect(borrower).repay(addr, usdc(1))).to.be.revertedWithCustomError(usdcToken, "ERC20InsufficientBalance");
    });

    it("restores borrowing power after repayment", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(loanFixture);
      const addr = await usdcToken.getAddress();
      await expect(protocol.connect(borrower).borrow(addr, 1)).to.be.revertedWithCustomError(protocol, "ExceedsBorrowLimit");
      await protocol.connect(borrower).repay(addr, usdc(1_000));
      await expect(protocol.connect(borrower).borrow(addr, usdc(1_000))).to.not.be.reverted;
    });
  });

  // =========================================================================
  describe("Account data and collateralization ratio", function () {
    it("reports max values when there is no debt", async function () {
      const { protocol, borrower } = await loadFixture(liquidityFixture);
      const d = await protocol.getAccountData(borrower.address);
      expect(d.collateralValue).to.equal(e18(20_000));
      expect(d.debtValue).to.equal(0);
      expect(d.borrowCapacity).to.equal(e18(15_000));
      expect(d.liquidationCapacity).to.equal(e18(16_000));
      expect(d.collateralRatioBps).to.equal(ethers.MaxUint256);
      expect(d.healthFactor).to.equal(ethers.MaxUint256);
    });

    it("computes collateral ratio and health factor", async function () {
      const { protocol, usdcToken, borrower } = await loadFixture(liquidityFixture);
      await protocol.connect(borrower).borrow(await usdcToken.getAddress(), usdc(10_000));
      const d = await protocol.getAccountData(borrower.address);
      expect(d.debtValue).to.equal(e18(10_000));
      expect(d.collateralRatioBps).to.equal(20_000); // 200%
      expect(d.healthFactor).to.equal(e18("1.6"));
    });

    it("at the maximum borrow, the ratio is the inverse of the LTV (133.33%)", async function () {
      const { protocol, borrower } = await loadFixture(loanFixture);
      expect((await protocol.getAccountData(borrower.address)).collateralRatioBps).to.equal(13_333);
    });

    it("reports zeros for an empty account", async function () {
      const { protocol, other } = await loadFixture(deployFixture);
      const d = await protocol.getAccountData(other.address);
      expect(d.collateralValue).to.equal(0);
      expect(d.debtValue).to.equal(0);
    });
  });

  // =========================================================================
  describe("Liquidation", function () {
    const dropPrice = async (protocol, weth, usd) => protocol.setAssetPrice(await weth.getAddress(), e18(usd));

    it("is not possible while the position is healthy", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      expect(await protocol.isLiquidatable(borrower.address)).to.equal(false);
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address, await usdcToken.getAddress(), await weth.getAddress(), usdc(1000))
      ).to.be.revertedWithCustomError(protocol, "PositionHealthy");
    });

    it("stays unavailable exactly at the threshold and opens just below it", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      // Debt $15,000. Capacity = 10 x price x 80%. Equal when price = $1,875.
      await dropPrice(protocol, weth, 1875);
      expect(await protocol.isLiquidatable(borrower.address)).to.equal(false);
      await protocol.setAssetPrice(await weth.getAddress(), e18(1875) - 1n);
      expect(await protocol.isLiquidatable(borrower.address)).to.equal(true);
    });

    it("liquidates up to the close factor and pays the 5% bonus", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 1800); // collateral $18,000, liquidation capacity $14,400 < $15,000 debt
      const debtAsset = await usdcToken.getAddress();
      const collAsset = await weth.getAddress();

      // Close factor 50% => at most 7,500 USDC.
      await expect(protocol.connect(liquidator).liquidate(borrower.address, debtAsset, collAsset, usdc(7_500) + 1n))
        .to.be.revertedWithCustomError(protocol, "RepayExceedsCloseFactor")
        .withArgs(usdc(7_500));

      // $7,500 x 1.05 = $7,875 / $1,800 = 4.375 WETH.
      await expect(protocol.connect(liquidator).liquidate(borrower.address, debtAsset, collAsset, usdc(7_500)))
        .to.emit(protocol, "Liquidated")
        .withArgs(liquidator.address, borrower.address, debtAsset, collAsset, usdc(7_500), e18("4.375"));

      expect(await protocol.debtOf(borrower.address, debtAsset)).to.equal(usdc(7_500));
      expect(await protocol.collateralOf(borrower.address, collAsset)).to.equal(e18("5.625"));
      expect(await weth.balanceOf(liquidator.address)).to.equal(e18("4.375"));
      expect(await usdcToken.balanceOf(liquidator.address)).to.equal(usdc(92_500));
      const [, borrows, totalCollateral] = await protocol.getTotals(debtAsset);
      expect(borrows).to.equal(usdc(7_500));
      expect(totalCollateral).to.equal(0);
      expect((await protocol.getTotals(collAsset))[2]).to.equal(e18("5.625"));
      // After liquidation the position is healthy again (debt $7,500 vs capacity $8,100).
      expect(await protocol.isLiquidatable(borrower.address)).to.equal(false);
    });

    it("supports partial liquidation amounts", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 1800);
      await protocol.connect(liquidator).liquidate(borrower.address, await usdcToken.getAddress(), await weth.getAddress(), usdc(1_800));
      // $1,800 x 1.05 / $1,800 = 1.05 WETH
      expect(await weth.balanceOf(liquidator.address)).to.equal(e18("1.05"));
    });

    it("gives the liquidator all collateral (and charges less) when collateral is short", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 700); // collateral only worth $7,000 vs $15,000 debt
      const debtAsset = await usdcToken.getAddress();
      await protocol.connect(liquidator).liquidate(borrower.address, debtAsset, await weth.getAddress(), usdc(7_500));
      // Takes all 10 WETH ($7,000) and pays $7,000 / 1.05 = 6,666.666666 USDC.
      expect(await weth.balanceOf(liquidator.address)).to.equal(e18(10));
      expect(await usdcToken.balanceOf(liquidator.address)).to.equal(usdc(100_000) - 6_666_666_666n);
      expect(await protocol.collateralOf(borrower.address, await weth.getAddress())).to.equal(0);
      expect(await protocol.debtOf(borrower.address, debtAsset)).to.equal(usdc(15_000) - 6_666_666_666n);
      // The leftover is bad debt: nothing more can be seized.
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address, debtAsset, await weth.getAddress(), usdc(100))
      ).to.be.revertedWithCustomError(protocol, "NothingToSeize");
    });

    it("rejects invalid liquidation requests", async function () {
      const { protocol, usdcToken, dai, weth, borrower, liquidator, other } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 1800);
      const debtAsset = await usdcToken.getAddress();
      const collAsset = await weth.getAddress();
      const b = borrower.address;
      await expect(protocol.connect(liquidator).liquidate(b, debtAsset, collAsset, 0)).to.be.revertedWithCustomError(protocol, "ZeroAmount");
      await expect(protocol.connect(borrower).liquidate(b, debtAsset, collAsset, 1)).to.be.revertedWithCustomError(protocol, "CannotLiquidateSelf");
      await expect(protocol.connect(liquidator).liquidate(b, other.address, collAsset, 1)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
      await expect(protocol.connect(liquidator).liquidate(b, debtAsset, other.address, 1)).to.be.revertedWithCustomError(protocol, "AssetNotSupported");
      // Borrower owes USDC, not DAI.
      await expect(protocol.connect(liquidator).liquidate(b, await dai.getAddress(), collAsset, 1)).to.be.revertedWithCustomError(protocol, "NothingToRepay");
    });

    it("fails if the liquidator lacks allowance or balance", async function () {
      const { protocol, protocolAddr, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 1800);
      await usdcToken.connect(liquidator).approve(protocolAddr, usdc(10));
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address, await usdcToken.getAddress(), await weth.getAddress(), usdc(1_000))
      ).to.be.revertedWithCustomError(usdcToken, "ERC20InsufficientAllowance");
    });

    it("can be disabled by pausing", async function () {
      const { protocol, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await dropPrice(protocol, weth, 1800);
      await protocol.pause();
      await expect(
        protocol.connect(liquidator).liquidate(borrower.address, await usdcToken.getAddress(), await weth.getAddress(), usdc(1_000))
      ).to.be.revertedWithCustomError(protocol, "EnforcedPause");
    });

    it("handles a borrower whose debt and collateral are the same token", async function () {
      const { protocol, usdcToken, borrower, liquidator, lender, owner } = await loadFixture(deployFixture);
      const addr = await usdcToken.getAddress();
      await protocol.connect(lender).deposit(addr, usdc(50_000));
      await usdcToken.mint(borrower.address, usdc(10_000));
      await protocol.connect(borrower).depositCollateral(addr, usdc(10_000));
      await protocol.connect(borrower).borrow(addr, usdc(8_000)); // limit 80%
      // Tighten risk settings so the (unchanged) loan becomes liquidatable: threshold 80% < 80.0% needs lower.
      await protocol.setAssetRisk(addr, 5000, 7000);
      expect(await protocol.isLiquidatable(borrower.address)).to.equal(true);
      await protocol.connect(liquidator).liquidate(borrower.address, addr, addr, usdc(4_000));
      expect(await protocol.debtOf(borrower.address, addr)).to.equal(usdc(4_000));
      expect(await protocol.collateralOf(borrower.address, addr)).to.equal(usdc(10_000) - usdc(4_200));
    });
  });

  // =========================================================================
  describe("Pausing", function () {
    it("blocks deposits, collateral and borrowing but still allows repay and withdrawals", async function () {
      const { protocol, usdcToken, weth, lender, borrower } = await loadFixture(loanFixture);
      const usdcAddr = await usdcToken.getAddress();
      await protocol.pause();
      await expect(protocol.connect(lender).deposit(usdcAddr, 1)).to.be.revertedWithCustomError(protocol, "EnforcedPause");
      await expect(protocol.connect(borrower).depositCollateral(await weth.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "EnforcedPause");
      await expect(protocol.connect(borrower).borrow(usdcAddr, 1)).to.be.revertedWithCustomError(protocol, "EnforcedPause");
      await expect(protocol.connect(borrower).repay(usdcAddr, usdc(1_000))).to.not.be.reverted;
      await expect(protocol.connect(lender).withdraw(usdcAddr, usdc(1_000))).to.not.be.reverted;
      await protocol.unpause();
      await expect(protocol.connect(lender).deposit(usdcAddr, 1)).to.not.be.reverted;
    });
  });

  // =========================================================================
  describe("Security", function () {
    async function reentrantSetup() {
      const f = await loadFixture(deployFixture);
      const RT = await ethers.getContractFactory("ReentrantToken");
      const rt = await RT.deploy();
      const rtAddr = await rt.getAddress();
      await f.protocol.addAsset(rtAddr, ONE_USD, 5000, 6000);
      await rt.mint(f.lender.address, e18(1_000));
      await rt.connect(f.lender).approve(f.protocolAddr, ethers.MaxUint256);
      return { ...f, rt, rtAddr };
    }

    it("blocks reentrancy during deposit (token calls withdraw mid-transfer)", async function () {
      const { protocol, protocolAddr, rt, rtAddr, lender } = await reentrantSetup();
      const payload = protocol.interface.encodeFunctionData("withdraw", [rtAddr, 1]);
      await rt.arm(protocolAddr, payload);
      await expect(protocol.connect(lender).deposit(rtAddr, e18(100))).to.not.be.reverted;
      expect(await rt.attempted()).to.equal(true);
      expect(await rt.reentrySucceeded()).to.equal(false);
      expect((await rt.lastRevertData()).slice(0, 10)).to.equal(REENTRANCY_SELECTOR);
      expect(await protocol.depositOf(lender.address, rtAddr)).to.equal(e18(100)); // accounting intact
    });

    it("blocks reentrancy during borrow (token calls repay mid-transfer)", async function () {
      const { protocol, protocolAddr, rt, rtAddr, lender, weth, borrower } = await reentrantSetup();
      await protocol.connect(lender).deposit(rtAddr, e18(1_000));
      await protocol.connect(borrower).depositCollateral(await weth.getAddress(), e18(1));
      const payload = protocol.interface.encodeFunctionData("repay", [rtAddr, 1]);
      await rt.arm(protocolAddr, payload);
      await expect(protocol.connect(borrower).borrow(rtAddr, e18(100))).to.not.be.reverted;
      expect(await rt.attempted()).to.equal(true);
      expect(await rt.reentrySucceeded()).to.equal(false);
      expect((await rt.lastRevertData()).slice(0, 10)).to.equal(REENTRANCY_SELECTOR);
      expect(await protocol.debtOf(borrower.address, rtAddr)).to.equal(e18(100));
    });

    it("blocks reentrancy during withdraw (token calls withdrawCollateral mid-transfer)", async function () {
      const { protocol, protocolAddr, rt, rtAddr, lender } = await reentrantSetup();
      await protocol.connect(lender).deposit(rtAddr, e18(100));
      const payload = protocol.interface.encodeFunctionData("withdrawCollateral", [rtAddr, 1]);
      await rt.arm(protocolAddr, payload);
      await protocol.connect(lender).withdraw(rtAddr, e18(10));
      expect(await rt.attempted()).to.equal(true);
      expect(await rt.reentrySucceeded()).to.equal(false);
      expect((await rt.lastRevertData()).slice(0, 10)).to.equal(REENTRANCY_SELECTOR);
    });

    it("rejects fee-on-transfer tokens", async function () {
      const { protocol, protocolAddr, lender } = await loadFixture(deployFixture);
      const Fee = await ethers.getContractFactory("FeeOnTransferToken");
      const fee = await Fee.deploy();
      await protocol.addAsset(await fee.getAddress(), ONE_USD, 5000, 6000);
      await fee.mint(lender.address, e18(100));
      await fee.connect(lender).approve(protocolAddr, ethers.MaxUint256);
      await expect(protocol.connect(lender).deposit(await fee.getAddress(), e18(100))).to.be.revertedWithCustomError(
        protocol,
        "UnsupportedTokenBehavior"
      );
    });

    it("users cannot touch each other's positions", async function () {
      const { protocol, usdcToken, weth, other } = await loadFixture(loanFixture);
      await expect(protocol.connect(other).withdraw(await usdcToken.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "InsufficientDeposit");
      await expect(protocol.connect(other).withdrawCollateral(await weth.getAddress(), 1)).to.be.revertedWithCustomError(protocol, "InsufficientCollateral");
    });

    it("keeps token balances equal to deposits + collateral - borrows after a mixed workflow", async function () {
      const { protocol, protocolAddr, usdcToken, weth, borrower, liquidator } = await loadFixture(loanFixture);
      await protocol.setAssetPrice(await weth.getAddress(), e18(1800));
      await protocol.connect(liquidator).liquidate(borrower.address, await usdcToken.getAddress(), await weth.getAddress(), usdc(5_000));
      await protocol.connect(borrower).repay(await usdcToken.getAddress(), usdc(2_000));
      for (const token of [usdcToken, weth]) {
        const [d, b, c] = await protocol.getTotals(await token.getAddress());
        expect(await token.balanceOf(protocolAddr)).to.equal(d + c - b);
      }
    });
  });
});
