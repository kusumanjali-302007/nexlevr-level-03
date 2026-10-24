require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY, REPORT_GAS } = process.env;

// Only use PRIVATE_KEY if it looks like a real 32-byte hex key (so the .env.example placeholder is ignored).
const hasValidKey = typeof PRIVATE_KEY === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(PRIVATE_KEY);
const accounts = hasValidKey ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // Built-in in-memory network used by `npx hardhat test`.
    hardhat: { chainId: 31337 },
    // Local node started with `npx hardhat node`.
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Sepolia testnet. Needs SEPOLIA_RPC_URL and PRIVATE_KEY in .env.
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts,
      chainId: 11155111,
    },
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    noColors: true,
    outputFile: REPORT_GAS === "true" ? "gas-report/hardhat-gas-report.txt" : undefined,
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 120000 },
};
