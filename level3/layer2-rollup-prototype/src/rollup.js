/**
 * rollup.js - the rollup client ("sequencer").
 *
 * Lifecycle of a transaction:
 *   1. submitTransaction()  -> validated against the projected state, then queued as PENDING
 *   2. processBatch()       -> pending transactions are executed off-chain, grouped into a
 *                              batch, a commitment is computed, and the batch is validated
 *   3. submitBatch()        -> the batch is re-validated and ONLY its commitment is sent
 *                              to the RollupVerifier contract
 *   4. verifyBatch()        -> recompute the commitment and compare with the on-chain record
 *
 * You can run a demo from the command line:  npm run client
 */
const { State } = require("./state");
const { validateTransactionFormat } = require("./transaction");
const { buildBatch, validateBatch, MAX_BATCH_SIZE } = require("./batch");
const { verifyOnChain, demonstrateTamper, revertReason } = require("./verifier");

const DEFAULT_GENESIS = { alice: 1000, bob: 500, carol: 250, dave: 100 };

class Rollup {
  /**
   * @param {object}  options
   * @param {Contract} options.contract      RollupVerifier contract connected to the sequencer signer
   * @param {object}  [options.genesis]      starting balances
   * @param {number}  [options.maxBatchSize] transactions per batch (1..MAX_BATCH_SIZE)
   */
  constructor({ contract, genesis = DEFAULT_GENESIS, maxBatchSize = 5 }) {
    if (!contract) throw new Error("A RollupVerifier contract instance is required");
    this.contract = contract;
    this.maxBatchSize = Math.min(Math.max(1, maxBatchSize), MAX_BATCH_SIZE);

    this.state = new State(genesis);     // state after all PROCESSED batches
    this.projected = this.state.clone(); // state after processed batches + pending transactions
    this.pending = [];                   // accepted transactions waiting to be batched
    this.rejected = [];                  // recent rejected transactions (for display)
    this.batches = [];                   // batch records, oldest first
    this.nextBatchNumber = 1;
  }

  /** Call once after creating the Rollup: continue numbering after what is already on-chain. */
  async init() {
    this.nextBatchNumber = Number(await this.contract.nextBatchNumber());
    return this;
  }

  // ---------------------------------------------------------------- transactions

  /**
   * Validate a transaction and, if it is OK, add it to the pending queue.
   * Returns { accepted, errors, tx }. Invalid transactions are never queued.
   */
  submitTransaction(tx) {
    const check = this.projected.checkTransaction(tx);
    if (!check.valid) {
      this.rejected.unshift({ tx, errors: check.errors });
      this.rejected = this.rejected.slice(0, 10);
      return { accepted: false, errors: check.errors, tx };
    }
    this.projected.applyTransaction(tx);
    this.pending.push({ ...tx });
    return { accepted: true, errors: [], tx };
  }

  /** Convenience: fill in the correct nonce automatically. */
  sendTokens(from, to, amount) {
    return this.submitTransaction({ from, to, amount, nonce: this.projected.getNonce(from) });
  }

  /** Queue `count` random but valid transactions. */
  createSampleTransactions(count = 3, rng = Math.random) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const accounts = Object.keys(this.projected.balances);
      const senders = accounts.filter((a) => this.projected.getBalance(a) >= 1);
      if (!senders.length) break;
      const from = senders[Math.floor(rng() * senders.length)];
      const others = accounts.filter((a) => a !== from);
      const to = others[Math.floor(rng() * others.length)];
      const maxAmount = Math.min(this.projected.getBalance(from), 100);
      const amount = 1 + Math.floor(rng() * maxAmount);
      results.push(this.sendTokens(from, to, amount));
    }
    return results;
  }

  /** Try to queue a deliberately invalid transaction (for demos). It will be rejected. */
  createInvalidSample(kind = "insufficient") {
    const accounts = Object.keys(this.projected.balances);
    const from = accounts[0];
    const to = accounts[1];
    const nonce = this.projected.getNonce(from);
    const balance = this.projected.getBalance(from);
    const bad = {
      insufficient: { from, to, amount: balance + 1, nonce },
      nonce: { from, to, amount: 1, nonce: nonce + 5 },
      self: { from, to: from, amount: 1, nonce },
      amount: { from, to, amount: -5, nonce },
    }[kind];
    if (!bad) throw new Error(`Unknown invalid sample kind "${kind}"`);
    return this.submitTransaction(bad);
  }

  // ---------------------------------------------------------------- batches

  /**
   * Execute up to maxBatchSize pending transactions off-chain, build a batch, and validate it.
   * Returns the batch record, or null if nothing is pending.
   */
  processBatch() {
    if (this.pending.length === 0) return null;

    const txs = this.pending.slice(0, this.maxBatchSize);
    const { batch, postState } = buildBatch({
      batchNumber: this.nextBatchNumber,
      preState: this.state,
      transactions: txs,
    });

    const validation = validateBatch(batch);
    if (!validation.valid) {
      // Should not happen for transactions we validated ourselves, but never submit a bad batch.
      throw new Error(`Batch failed validation: ${validation.errors.join("; ")}`);
    }

    // Commit the off-chain execution result.
    this.state = postState;
    this.pending.splice(0, txs.length);
    this.nextBatchNumber += 1;

    const record = { batch, status: "validated", validation: { valid: true, errors: [] } };
    this.batches.push(record);
    return record;
  }

  findRecord(batchNumber) {
    const record = this.batches.find((r) => r.batch.batchNumber === batchNumber);
    if (!record) throw new Error(`Unknown batch #${batchNumber}`);
    return record;
  }

  /** Validate the batch again, then send its commitment to the contract. */
  async submitBatch(batchNumber) {
    const record = this.findRecord(batchNumber);
    if (record.status === "submitted") throw new Error(`Batch #${batchNumber} was already submitted`);

    const validation = validateBatch(record.batch);
    record.validation = { valid: validation.valid, errors: validation.errors };
    if (!validation.valid) {
      record.status = "invalid";
      throw new Error(`Refusing to submit invalid batch #${batchNumber}: ${validation.errors.join("; ")}`);
    }

    let receipt;
    try {
      const tx = await this.contract.submitBatch(record.batch.batchNumber, record.batch.commitment, record.batch.txCount);
      receipt = await tx.wait();
    } catch (err) {
      throw new Error(`Contract rejected batch #${batchNumber}: ${revertReason(err)}`);
    }
    record.status = "submitted";
    record.chain = { txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
    return record;
  }

  /** Submit the oldest batch that has not been submitted yet. Returns null if there is none. */
  async submitNextBatch() {
    const next = this.batches.find((r) => r.status === "validated");
    return next ? this.submitBatch(next.batch.batchNumber) : null;
  }

  /** Check a batch against the on-chain record. */
  async verifyBatch(batchNumber) {
    const record = this.findRecord(batchNumber);
    const result = await verifyOnChain(this.contract, record.batch);
    record.verification = result;
    return result;
  }

  /** Tamper demo on a copy of a batch (the real batch and the chain are untouched). */
  async tamperDemo(batchNumber, txIndex = 0) {
    return demonstrateTamper(this.contract, this.findRecord(batchNumber).batch, txIndex);
  }

  // ---------------------------------------------------------------- views

  /** Everything the dashboard needs, as plain JSON. */
  async getView() {
    const provider = this.contract.runner.provider;
    const [batchCountOnChain, blockNumber, network] = await Promise.all([
      this.contract.batchCount(),
      provider.getBlockNumber(),
      provider.getNetwork(),
    ]);
    return {
      balances: { ...this.state.balances },
      nonces: { ...this.state.nonces },
      projectedBalances: { ...this.projected.balances },
      pending: this.pending.map((tx) => ({ ...tx })),
      rejected: this.rejected,
      batches: this.batches.map((r) => ({
        ...r.batch,
        preState: undefined, // keep the payload small; the full batch stays on the server
        status: r.status,
        validation: r.validation,
        chain: r.chain || null,
        verification: r.verification || null,
      })),
      chain: {
        contract: await this.contract.getAddress(),
        chainId: Number(network.chainId),
        blockNumber,
        batchCountOnChain: Number(batchCountOnChain),
        sequencer: await this.contract.sequencer(),
      },
      maxBatchSize: this.maxBatchSize,
    };
  }
}

// ====================================================================== CLI demo
async function demo() {
  require("dotenv").config();
  const { JsonRpcProvider } = require("ethers");
  const { loadDeployment, getContract, revertReason } = require("./verifier");

  const line = (t) => console.log(`\n=== ${t} ===`);
  const short = (h) => `${h.slice(0, 10)}...${h.slice(-6)}`;

  const provider = new JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");
  const deployment = loadDeployment();
  const signer = await provider.getSigner(0); // the node's first free test account
  const contract = getContract(deployment.address, signer);
  const rollup = await new Rollup({ contract, maxBatchSize: 3 }).init();

  console.log("Layer 2 Rollup Prototype (educational - NOT a production rollup)");
  console.log("Contract:", deployment.address, "| first batch number:", rollup.nextBatchNumber);
  console.log("Genesis balances:", rollup.state.balances);

  line("1. Submit transactions (2 valid + 3 invalid)");
  const show = (label, r) => console.log(`${r.accepted ? "ACCEPTED" : "REJECTED"} ${label}`, r.accepted ? "" : `-> ${r.errors.join("; ")}`);
  show("alice -> bob 100", rollup.sendTokens("alice", "bob", 100));
  show("bob -> carol 50", rollup.sendTokens("bob", "carol", 50));
  show("dave -> alice 9999 (too much)", rollup.submitTransaction({ from: "dave", to: "alice", amount: 9999, nonce: 0 }));
  show("alice -> bob 5 with nonce 7", rollup.submitTransaction({ from: "alice", to: "bob", amount: 5, nonce: 7 }));
  show("carol -> carol 1 (self)", rollup.submitTransaction({ from: "carol", to: "carol", amount: 1, nonce: 0 }));
  console.log("Pending:", rollup.pending.length);

  line("2. Process batch off-chain");
  const record = rollup.processBatch();
  const b = record.batch;
  console.log(`Batch #${b.batchNumber}: ${b.txCount} txs, status=${record.status}`);
  console.log("  prevStateRoot:", short(b.prevStateRoot));
  console.log("  txRoot:       ", short(b.txRoot));
  console.log("  newStateRoot: ", short(b.newStateRoot));
  console.log("  commitment:   ", b.commitment);
  console.log("New balances:", rollup.state.balances);

  line("3. Submit commitment on-chain");
  const submitted = await rollup.submitBatch(b.batchNumber);
  console.log(`Recorded in block ${submitted.chain.blockNumber}, tx ${short(submitted.chain.txHash)}, gas ${submitted.chain.gasUsed}`);

  line("4. Verify against the chain");
  console.log(await rollup.verifyBatch(b.batchNumber));

  line("5. Tamper demo (copies only; nothing real is changed)");
  const t = await rollup.tamperDemo(b.batchNumber, 0);
  console.log(`Changed tx #0 amount ${t.originalAmount} -> ${t.tamperedAmount}`);
  console.log("Original commitment:       ", t.originalCommitment);
  console.log("Naive edit detected?        ", !t.naive.valid, "-", t.naive.errors[0]);
  console.log("Edit + recomputed hashes:   ", t.withFixedHashes.newCommitment);
  console.log("  matches on-chain record?  ", t.withFixedHashes.matchesOnChain);

  line("6. Duplicate submission is rejected by the contract");
  try {
    await (await contract.submitBatch(b.batchNumber, b.commitment, b.txCount)).wait();
    console.log("ERROR: duplicate was accepted (should not happen)");
  } catch (err) {
    console.log("Rejected as expected:", revertReason(err));
  }

  console.log("\nDone. On-chain batch count:", (await contract.batchCount()).toString());
}

if (require.main === module) {
  demo().catch((err) => {
    console.error("\nDemo failed:", err.message);
    process.exit(1);
  });
}

module.exports = { Rollup, DEFAULT_GENESIS };
