/**
 * batch.js - grouping transactions into a batch and computing its commitment.
 *
 * A batch looks like this:
 *   {
 *     batchNumber,      // 1, 2, 3, ...
 *     prevStateRoot,    // hash of the state BEFORE the batch
 *     txRoot,           // hash of all transaction hashes (in order)
 *     newStateRoot,     // hash of the state AFTER the batch
 *     commitment,       // hash of the four values above -> this goes on-chain
 *     txCount,
 *     transactions,     // the transactions themselves (in order)
 *     preState          // balances/nonces before the batch, so anyone can replay it
 *   }
 *
 * Only `commitment` (+ batch number + tx count) is stored on-chain. The rest is
 * the "batch data" that, in a real rollup, would be published so others can
 * re-check your work.
 */
const { AbiCoder, keccak256, concat } = require("ethers");
const { hashTransaction, validateTransactionFormat } = require("./transaction");
const { State } = require("./state");

const MAX_BATCH_SIZE = 20;

/** One hash that represents the ordered list of transactions. */
function computeTxRoot(transactions) {
  return keccak256(concat(transactions.map(hashTransaction)));
}

/**
 * The batch commitment: keccak256(abi.encode(batchNumber, prevStateRoot, txRoot, newStateRoot)).
 * Change ANY of those inputs by even one bit and the commitment changes completely.
 */
function computeCommitment({ batchNumber, prevStateRoot, txRoot, newStateRoot }) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint256", "bytes32", "bytes32", "bytes32"],
    [batchNumber, prevStateRoot, txRoot, newStateRoot]
  );
  return keccak256(encoded);
}

/**
 * Execute `transactions` in order against a COPY of `preState` and package the result.
 * Throws if any transaction is invalid. Returns { batch, postState }.
 */
function buildBatch({ batchNumber, preState, transactions }) {
  if (!transactions.length) throw new Error("Cannot build an empty batch");
  if (transactions.length > MAX_BATCH_SIZE) {
    throw new Error(`Batch too large: ${transactions.length} > ${MAX_BATCH_SIZE}`);
  }

  const postState = preState.clone();
  transactions.forEach((tx, i) => {
    try {
      postState.applyTransaction(tx);
    } catch (err) {
      throw new Error(`Transaction #${i} rejected: ${err.message}`);
    }
  });

  const fields = {
    batchNumber,
    prevStateRoot: preState.root(),
    txRoot: computeTxRoot(transactions),
    newStateRoot: postState.root(),
  };
  const batch = {
    ...fields,
    commitment: computeCommitment(fields),
    txCount: transactions.length,
    transactions: transactions.map((tx) => ({ ...tx })),
    preState: preState.snapshot(),
  };
  return { batch, postState };
}

/**
 * Re-check an entire batch from scratch (this is the "validation" step).
 * Checks, in order: structure, starting state, transaction format + ordering (nonces),
 * balances, token conservation, and that every stored hash matches a fresh recomputation.
 * Returns { valid, errors, recomputed } - never throws.
 */
function validateBatch(batch) {
  const errors = [];

  if (!batch || typeof batch !== "object") {
    return { valid: false, errors: ["Batch is missing"], recomputed: null };
  }
  if (!Number.isSafeInteger(batch.batchNumber) || batch.batchNumber < 1) {
    errors.push("batchNumber must be a positive whole number");
  }
  if (!Array.isArray(batch.transactions) || batch.transactions.length === 0) {
    return { valid: false, errors: [...errors, "Batch has no transactions"], recomputed: null };
  }
  if (batch.transactions.length > MAX_BATCH_SIZE) {
    errors.push(`Batch too large: ${batch.transactions.length} > ${MAX_BATCH_SIZE}`);
  }
  if (batch.txCount !== batch.transactions.length) {
    errors.push(`txCount ${batch.txCount} does not match ${batch.transactions.length} transactions`);
  }
  if (!batch.preState || !batch.preState.balances || !batch.preState.nonces) {
    return { valid: false, errors: [...errors, "Batch is missing its preState"], recomputed: null };
  }

  // 1. Does the batch really start from the state it claims?
  const state = State.fromSnapshot(batch.preState);
  if (state.root() !== batch.prevStateRoot) {
    errors.push("prevStateRoot does not match the batch's preState");
  }
  const supplyBefore = state.totalSupply();

  // 2. Replay every transaction in order (this checks format, ordering/nonces, balances).
  let replayOk = true;
  batch.transactions.forEach((tx, i) => {
    const format = validateTransactionFormat(tx);
    if (!format.valid) {
      errors.push(`Transaction #${i} invalid: ${format.errors.join("; ")}`);
      replayOk = false;
      return;
    }
    const check = state.checkTransaction(tx);
    if (!check.valid) {
      errors.push(`Transaction #${i} invalid: ${check.errors.join("; ")}`);
      replayOk = false;
      return;
    }
    state.applyTransaction(tx);
  });

  // 3. Recompute every hash and compare with what the batch claims.
  const recomputed = { txRoot: computeTxRoot(batch.transactions) };
  if (recomputed.txRoot !== batch.txRoot) {
    errors.push("txRoot mismatch: the transactions were changed after the batch was built");
  }
  if (replayOk) {
    recomputed.newStateRoot = state.root();
    if (state.totalSupply() !== supplyBefore) errors.push("Token supply changed during the batch");
    if (recomputed.newStateRoot !== batch.newStateRoot) {
      errors.push("newStateRoot mismatch: replaying the transactions gives a different final state");
    }
    recomputed.commitment = computeCommitment({
      batchNumber: batch.batchNumber,
      prevStateRoot: batch.prevStateRoot,
      txRoot: recomputed.txRoot,
      newStateRoot: recomputed.newStateRoot,
    });
    if (recomputed.commitment !== batch.commitment) {
      errors.push("commitment mismatch: the batch does not match its commitment");
    }
  }

  return { valid: errors.length === 0, errors, recomputed };
}

/**
 * Rebuild the hashes of a batch from its (possibly edited) transactions.
 * Used to show that an attacker who edits a transaction AND fixes up all the hashes
 * still ends up with a DIFFERENT commitment from the one recorded on-chain.
 * Throws if the edited transactions no longer replay.
 */
function refreshBatch(batch) {
  return buildBatch({
    batchNumber: batch.batchNumber,
    preState: State.fromSnapshot(batch.preState),
    transactions: batch.transactions,
  }).batch;
}

module.exports = { MAX_BATCH_SIZE, computeTxRoot, computeCommitment, buildBatch, validateBatch, refreshBatch };
