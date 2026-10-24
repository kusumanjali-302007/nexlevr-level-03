/**
 * Deploys the lending protocol and three mock tokens, configures risk parameters,
 * prints the addresses, saves them to JSON, and (optionally) verifies on Etherscan.
 *
 *   Local:   npx hardhat node               (terminal 1)
 *            npm run deploy:local           (terminal 2)
 *   Sepolia: npm run deploy:sepolia         (needs .env, see README)
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network, run } = hre;

const e18 = (n) => ethers.parseUnits(String(n), 18);

// Starter settings for the demo assets. Prices use 1e18 precision (USD per whole token).
const TOKENS = [
  { key: "WETH", name: "Mock Wrapped Ether", symbol: "mWETH", decimals: 18, price: e18(2000), ltvBps: 7500, liqBps: 8000 },
  { key: "USDC", name: "Mock USD Coin", symbol: "mUSDC", decimals: 6, price: e18(1), ltvBps: 8000, liqBps: 8500 },
  { key: "DAI", name: "Mock Dai", symbol: "mDAI", decimals: 18, price: e18(1), ltvBps: 7500, liqBps: 8000 },
];

async function verify(address, constructorArguments) {
  try {
    await run("verify:verify", { address, constructorArguments });
    console.log(`  verified ${address}`);
  } catch (err) {
    if (/already verified/i.test(err.message)) console.log(`  already verified ${address}`);
    else console.log(`  verification failed for ${address}: ${err.message.split("\n")[0]}`);
  }
}

async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer account. Set a valid PRIVATE_KEY in .env (see README) or use a local network.");
  }
  const deployer = signers[0];
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const isLocal = ["hardhat", "localhost"].includes(network.name);

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);
  if (!isLocal && (await ethers.provider.getBalance(deployer.address)) === 0n) {
    throw new Error("Deployer has 0 ETH. Get Sepolia test ETH from a faucet first (see README).");
  }

  // 1. Protocol
  const Protocol = await ethers.getContractFactory("DeFiLendingProtocol");
  const protocol = await Protocol.deploy(deployer.address);
  await protocol.waitForDeployment();
  const protocolAddress = await protocol.getAddress();
  console.log(`DeFiLendingProtocol: ${protocolAddress}`);

  // 2. Mock tokens + 3. configuration
  const Mock = await ethers.getContractFactory("MockERC20");
  const tokens = {};
  for (const t of TOKENS) {
    const token = await Mock.deploy(t.name, t.symbol, t.decimals);
    await token.waitForDeployment();
    const address = await token.getAddress();
    tokens[t.key] = { address, name: t.name, symbol: t.symbol, decimals: t.decimals, priceUsd: ethers.formatUnits(t.price, 18), ltvBps: t.ltvBps, liquidationThresholdBps: t.liqBps };
    console.log(`${t.symbol.padEnd(6)} (${t.decimals} dec):      ${address}`);
    await (await protocol.addAsset(address, t.price, t.ltvBps, t.liqBps)).wait();
  }
  console.log("\nAssets listed and risk parameters configured.");

  // 4. Optional starter liquidity so a fresh deployment can be borrowed from right away.
  if (isLocal || process.env.SEED_LIQUIDITY === "true") {
    const usdc = await ethers.getContractAt("MockERC20", tokens.USDC.address);
    const dai = await ethers.getContractAt("MockERC20", tokens.DAI.address);
    const amounts = [[usdc, ethers.parseUnits("100000", 6)], [dai, e18(100000)]];
    for (const [token, amount] of amounts) {
      await (await token.mint(deployer.address, amount)).wait();
      await (await token.approve(protocolAddress, amount)).wait();
      await (await protocol.deposit(await token.getAddress(), amount)).wait();
    }
    console.log("Seeded the pool with 100,000 mUSDC and 100,000 mDAI from the deployer.");
  }

  // 5. Save details
  const deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    protocol: protocolAddress,
    tokens,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  console.log(`\nSaved deployment details to ${path.relative(process.cwd(), file)}`);

  // The frontend reads this file (keyed by chain id) to find the contracts.
  const frontendFile = path.join(__dirname, "..", "frontend", "deployments.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(frontendFile, "utf8")); } catch (_) { /* first deployment */ }
  all[chainId] = deployment;
  fs.writeFileSync(frontendFile, JSON.stringify(all, null, 2));
  console.log(`Updated frontend/deployments.json for chain ${chainId}`);

  // 6. Verify on Etherscan (only on real networks and only if an API key is configured)
  if (!isLocal && process.env.ETHERSCAN_API_KEY) {
    console.log("\nWaiting for confirmations before verification...");
    await protocol.deploymentTransaction().wait(5);
    await verify(protocolAddress, [deployer.address]);
    for (const t of TOKENS) await verify(tokens[t.key].address, [t.name, t.symbol, t.decimals]);
  } else if (!isLocal) {
    console.log("\nSkipping verification (set ETHERSCAN_API_KEY in .env to enable).");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
