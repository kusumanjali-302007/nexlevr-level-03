/**
 * Deploys RollupVerifier and saves its address to deployments/localhost.json
 * so the client and dashboard can find it.
 *
 *   npm run deploy      (= hardhat run scripts/deploy.js --network localhost)
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // The deployer becomes the sequencer: the only account allowed to submit batches.
  const verifier = await hre.ethers.deployContract("RollupVerifier", [deployer.address]);
  await verifier.waitForDeployment();
  const address = await verifier.getAddress();
  const network = await hre.ethers.provider.getNetwork();

  console.log("RollupVerifier deployed to:", address);

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hre.network.name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ address, sequencer: deployer.address, chainId: Number(network.chainId), network: hre.network.name }, null, 2)
  );
  console.log("Saved deployment info to", path.relative(process.cwd(), file));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
