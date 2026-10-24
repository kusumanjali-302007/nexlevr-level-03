/**
 * verifier.js - talking to the RollupVerifier contract and checking batches against it.
 */
const fs = require("fs");
const path = require("path");
const { Contract } = require("ethers");
const { validateBatch, computeCommitment, refreshBatch } = require("./batch");

// Human-readable ABI: only the parts of the contract the client uses.
const ROLLUP_VERIFIER_ABI = [
  "function sequencer() view returns (address)",
  "function batchCount() view returns (uint256)",
  "function nextBatchNumber() view returns (uint256)",
  "function batchExists(uint256 batchNumber) view returns (bool)",
  "function verifyBatch(uint256 batchNumber, bytes32 commitment) view returns (bool)",
  "function getBatch(uint256 batchNumber) view returns (bytes32 commitment, uint256 txCount, address submitter, uint256 timestamp)",
  "function submitBatch(uint256 batchNumber, bytes32 commitment, uint256 txCount)",
  "function transferSequencer(address newSequencer)",
  "event BatchSubmitted(uint256 indexed batchNumber, bytes32 indexed commitment, address indexed submitter, uint256 txCount)",
  "event SequencerChanged(address indexed oldSequencer, address indexed newSequencer)",
];

/**
 * Pull a readable revert message (e.g. "Batch already submitted") out of an ethers error.
 * Different node types wrap the reason differently, so we check a few places.
 */
function revertReason(err) {
  const candidates = [err && err.reason, err && err.error && err.error.message, err && err.info && err.info.error && err.info.error.message, err && err.shortMessage, err && err.message];
  for (const text of candidates) {
    if (typeof text !== "string") continue;
    const match = text.match(/reverted with reason string '([^']*)'/);
    if (match) return match[1];
  }
  return candidates.find((t) => typeof t === "string" && t !== "could not coalesce error") || "Unknown error";
}

const DEPLOYMENT_FILE = path.join(__dirname, "..", "deployments", "localhost.json");

/** Read the address written by `npm run deploy`. */
function loadDeployment(file = DEPLOYMENT_FILE) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at ${file}.\nStart the node (npm run node) and deploy (npm run deploy) first.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function getContract(address, signerOrProvider) {
  return new Contract(address, ROLLUP_VERIFIER_ABI, signerOrProvider);
}

/**
 * Full verification of one batch:
 *   1. Re-validate the batch locally (replay + recompute every hash).
 *   2. Ask the contract whether the commitment we recompute matches the recorded one.
 * We deliberately recompute the commitment from the batch contents instead of trusting
 * the `commitment` field stored inside the batch object.
 */
async function verifyOnChain(contract, batch) {
  const local = validateBatch(batch);
  const recomputedCommitment = computeCommitment({
    batchNumber: batch.batchNumber,
    prevStateRoot: batch.prevStateRoot,
    txRoot: local.recomputed ? local.recomputed.txRoot : batch.txRoot,
    newStateRoot: local.recomputed && local.recomputed.newStateRoot ? local.recomputed.newStateRoot : batch.newStateRoot,
  });

  const exists = await contract.batchExists(batch.batchNumber);
  const matchesOnChain = exists ? await contract.verifyBatch(batch.batchNumber, recomputedCommitment) : false;

  return {
    batchNumber: batch.batchNumber,
    existsOnChain: exists,
    locallyValid: local.valid,
    localErrors: local.errors,
    recomputedCommitment,
    matchesOnChain,
    verified: local.valid && matchesOnChain,
  };
}

/**
 * Return a COPY of the batch where one transaction's amount was edited.
 * `fixHashes = false`: only the amount changes (stored hashes become stale).
 * `fixHashes = true` : the attacker also recomputes txRoot / newStateRoot / commitment.
 */
function tamperTransaction(batch, txIndex, newAmount, fixHashes = false) {
  const copy = JSON.parse(JSON.stringify(batch));
  if (!copy.transactions[txIndex]) throw new Error(`No transaction at index ${txIndex}`);
  copy.transactions[txIndex].amount = newAmount;
  return fixHashes ? refreshBatch(copy) : copy;
}

/**
 * Show what tampering does. Never changes the original batch or the chain.
 * Returns the original commitment and the results of both tampering styles.
 */
async function demonstrateTamper(contract, batch, txIndex = 0) {
  const original = batch.transactions[txIndex].amount;
  const newAmount = original > 1 ? original - 1 : original + 1; // always a *different* amount

  const naive = tamperTransaction(batch, txIndex, newAmount, false);
  const naiveCheck = validateBatch(naive);

  let fixed = null;
  let fixedResult = null;
  try {
    fixed = tamperTransaction(batch, txIndex, newAmount, true);
    fixedResult = await verifyOnChain(contract, fixed);
  } catch (err) {
    fixedResult = { error: `Edited batch no longer replays: ${err.message}` };
  }

  return {
    txIndex,
    originalAmount: original,
    tamperedAmount: newAmount,
    originalCommitment: batch.commitment,
    naive: { valid: naiveCheck.valid, errors: naiveCheck.errors },
    withFixedHashes: fixed
      ? {
          newCommitment: fixed.commitment,
          commitmentChanged: fixed.commitment !== batch.commitment,
          ...fixedResult,
        }
      : fixedResult,
  };
}

module.exports = {
  ROLLUP_VERIFIER_ABI,
  loadDeployment,
  getContract,
  revertReason,
  verifyOnChain,
  tamperTransaction,
  demonstrateTamper,
};
