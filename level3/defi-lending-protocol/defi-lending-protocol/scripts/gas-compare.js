/**
 * Compares gas used by the optimized DeFiLendingProtocol against NaiveLendingProtocol
 * (same behaviour, written WITHOUT the optimizations). Runs on the in-memory Hardhat network.
 *
 *   npm run gas:compare
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const usdc = (n) => ethers.parseUnits(String(n), 6);

async function setup(kind) {
  const [owner, lender, borrower] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockERC20");
  const weth = await Mock.deploy("W", "W", 18);
  const usd = await Mock.deploy("U", "U", 6);
  const dai = await Mock.deploy("D", "D", 18);

  let protocol;
  if (kind === "optimized") {
    protocol = await (await ethers.getContractFactory("DeFiLendingProtocol")).deploy(owner.address);
    await protocol.addAsset(await weth.getAddress(), e18(2000), 7500, 8000);
    await protocol.addAsset(await usd.getAddress(), e18(1), 8000, 8500);
    await protocol.addAsset(await dai.getAddress(), e18(1), 7500, 8000);
  } else {
    protocol = await (await ethers.getContractFactory("NaiveLendingProtocol")).deploy(owner.address);
    await protocol.addAsset(await weth.getAddress(), e18(2000), 7500);
    await protocol.addAsset(await usd.getAddress(), e18(1), 8000);
    await protocol.addAsset(await dai.getAddress(), e18(1), 7500);
  }
  const addr = await protocol.getAddress();
  await usd.mint(lender.address, usdc(100000));
  await weth.mint(borrower.address, e18(10));
  await usd.connect(lender).approve(addr, ethers.MaxUint256);
  await weth.connect(borrower).approve(addr, ethers.MaxUint256);
  await usd.connect(borrower).approve(addr, ethers.MaxUint256);
  return { protocol, weth, usd, lender, borrower };
}

async function measure(kind) {
  const { protocol, weth, usd, lender, borrower } = await setup(kind);
  const gas = {};
  const run = async (name, tx) => { gas[name] = (await (await tx).wait()).gasUsed; };

  const wethA = await weth.getAddress();
  const usdA = await usd.getAddress();
  await run("deposit (first deposit)", protocol.connect(lender).deposit(usdA, usdc(100000)));
  await run("depositCollateral (first deposit)", protocol.connect(borrower).depositCollateral(wethA, e18(10)));
  await run("borrow (first loan)", protocol.connect(borrower).borrow(usdA, usdc(10000)));
  await run("repay (partial)", protocol.connect(borrower).repay(usdA, usdc(2000)));
  await run("withdrawCollateral (with open loan)", protocol.connect(borrower).withdrawCollateral(wethA, e18(1)));
  await run("withdraw (partial)", protocol.connect(lender).withdraw(usdA, usdc(1000)));
  return gas;
}

async function main() {
  const naive = await measure("naive");
  const opt = await measure("optimized");

  const rows = Object.keys(naive).map((name) => {
    const before = naive[name], after = opt[name];
    const saved = before - after;
    const pct = (Number(saved) * 100) / Number(before);
    return { name, before, after, saved, pct };
  });

  const lines = [
    "| Function | Baseline (gas) | Optimized (gas) | Saved (gas) | Saved (%) |",
    "|---|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.name} | ${r.before} | ${r.after} | ${r.saved} | ${r.pct.toFixed(1)}% |`),
  ];
  const md = lines.join("\n");
  console.log("\n" + md + "\n");
  console.log("Both contracts have the same safety features (reentrancy guard, pause, fee-on-transfer check).");
  console.log("Differences come from storage packing, cached reads, custom errors and cheaper loops.");
  console.log("deposit/depositCollateral/repay are dominated by unavoidable token-transfer and SSTORE costs,");
  console.log("so they barely change; the account-health loop (borrow, withdrawCollateral) is where it pays off.\n");

  fs.mkdirSync(path.join(__dirname, "..", "gas-report"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "gas-report", "gas-comparison.md"), md + "\n");
  console.log("Saved gas-report/gas-comparison.md");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
