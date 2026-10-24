require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// OPTIONAL: if your network blocks binaries.soliditylang.org (Hardhat's compiler download),
// run `npm install --no-save solc@0.8.19` and set USE_SOLCJS=1 to compile with the npm
// "solc" package instead. Same compiler version, just slower. Most people do NOT need this.
if (process.env.USE_SOLCJS === "1") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args) => {
    const solc = require("solc");
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version().replace(/\.Emscripten.*$/, ""),
    };
  });
}

// The local node started with `npx hardhat node` listens here by default.
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.19",
  networks: {
    // In-process network used by `npx hardhat test` (no setup needed).
    hardhat: {},
    // The long-running local node used by the deploy script, client, and dashboard.
    localhost: {
      url: RPC_URL,
    },
  },
};
