const { expect } = require("chai");
const { ethers } = require("hardhat");
const { State } = require("../src/state");
const { validateTransactionFormat, hashTransaction } = require("../src/transaction");
const { buildBatch, validateBatch, computeTxRoot } = require("../src/batch");
const { Rollup } = require("../src/rollup");
const { tamperTransaction } = require("../src/verifier");

const GENESIS = { alice: 100, bob: 50, carol: 0 };

describe("Transactions and state (off-chain)", function () {
  it("executes a valid transaction", function () {
    const state = new State(GENESIS);
    state.applyTransaction({ from: "alice", to: "bob", amount: 30, nonce: 0 });
    expect(state.getBalance("alice")).to.equal(70);
    expect(state.getBalance("bob")).to.equal(80);
    expect(state.getNonce("alice")).to.equal(1);
    expect(state.totalSupply()).to.equal(150);
  });

  it("rejects malformed transactions", function () {
    const bad = [
      { from: "alice", to: "bob", amount: 0, nonce: 0 },
      { from: "alice", to: "bob", amount: -3, nonce: 0 },
      { from: "alice", to: "bob", amount: 1.5, nonce: 0 },
      { from: "alice", to: "alice", amount: 1, nonce: 0 },
      { from: "Alice!", to: "bob", amount: 1, nonce: 0 },
      { from: "alice", to: "bob", amount: 1 }, // no nonce
      { from: "alice", to: "bob", amount: 1, nonce: 0, extra: true },
      null,
    ];
    for (const tx of bad) expect(validateTransactionFormat(tx).valid, JSON.stringify(tx)).to.equal(false);
  });

  it("handles insufficient balance without changing the state", function () {
    const state = new State(GENESIS);
    const before = state.root();
    const check = state.checkTransaction({ from: "bob", to: "alice", amount: 51, nonce: 0 });
    expect(check.valid).to.equal(false);
    expect(check.errors[0]).to.contain("Insufficient balance");
    expect(() => state.applyTransaction({ from: "bob", to: "alice", amount: 51, nonce: 0 })).to.throw(
      "Insufficient balance"
    );
    expect(state.root()).to.equal(before);
  });

  it("rejects wrong nonces (ordering and replay)", function () {
    const state = new State(GENESIS);
    state.applyTransaction({ from: "alice", to: "bob", amount: 1, nonce: 0 });
    expect(() => state.applyTransaction({ from: "alice", to: "bob", amount: 1, nonce: 0 })).to.throw("Bad nonce");
    expect(() => state.applyTransaction({ from: "alice", to: "bob", amount: 1, nonce: 5 })).to.throw("Bad nonce");
  });

  it("gives the same hash for the same transaction and different hashes otherwise", function () {
    const tx = { from: "alice", to: "bob", amount: 5, nonce: 0 };
    expect(hashTransaction(tx)).to.equal(hashTransaction({ ...tx }));
    expect(hashTransaction(tx)).to.not.equal(hashTransaction({ ...tx, amount: 6 }));
  });
});

describe("Batches and commitments (off-chain)", function () {
  const txs = [
    { from: "alice", to: "bob", amount: 10, nonce: 0 },
    { from: "bob", to: "carol", amount: 20, nonce: 0 },
    { from: "alice", to: "carol", amount: 5, nonce: 1 },
  ];
  const makeBatch = () => buildBatch({ batchNumber: 1, preState: new State(GENESIS), transactions: txs }).batch;

  it("generates a deterministic batch commitment", function () {
    const a = makeBatch();
    const b = makeBatch();
    expect(a.commitment).to.match(/^0x[0-9a-f]{64}$/);
    expect(a.commitment).to.equal(b.commitment);
    expect(a.txCount).to.equal(3);
    expect(a.txRoot).to.equal(computeTxRoot(txs));
  });

  it("validates a good batch", function () {
    const result = validateBatch(makeBatch());
    expect(result.errors).to.deep.equal([]);
    expect(result.valid).to.equal(true);
  });

  it("refuses to build a batch containing an invalid transaction", function () {
    const bad = [...txs, { from: "carol", to: "alice", amount: 9999, nonce: 0 }];
    expect(() => buildBatch({ batchNumber: 1, preState: new State(GENESIS), transactions: bad })).to.throw(
      "Transaction #3 rejected"
    );
  });

  it("rejects a batch whose transactions are out of order", function () {
    const batch = makeBatch();
    batch.transactions = [batch.transactions[2], batch.transactions[0], batch.transactions[1]];
    const result = validateBatch(batch);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(" ")).to.contain("Bad nonce");
  });

  it("detects a tampered transaction (stale hashes)", function () {
    const batch = makeBatch();
    const tampered = tamperTransaction(batch, 0, 9, false);
    const result = validateBatch(tampered);
    expect(result.valid).to.equal(false);
    expect(result.errors.join(" ")).to.contain("txRoot mismatch");
  });

  it("changes the commitment when a transaction is tampered with and hashes are recomputed", function () {
    const batch = makeBatch();
    const tampered = tamperTransaction(batch, 0, 9, true);
    expect(validateBatch(tampered).valid).to.equal(true); // internally consistent...
    expect(tampered.commitment).to.not.equal(batch.commitment); // ...but a different commitment
    expect(tampered.txRoot).to.not.equal(batch.txRoot);
    expect(tampered.newStateRoot).to.not.equal(batch.newStateRoot);
  });

  it("detects a batch whose commitment or starting state was forged", function () {
    const forgedCommitment = makeBatch();
    forgedCommitment.commitment = "0x" + "11".repeat(32);
    expect(validateBatch(forgedCommitment).errors.join(" ")).to.contain("commitment mismatch");

    const forgedState = makeBatch();
    forgedState.preState.balances.alice = 1_000_000;
    expect(validateBatch(forgedState).errors.join(" ")).to.contain("prevStateRoot");
  });
});

describe("Rollup client + RollupVerifier (integration)", function () {
  let contract, rollup, sequencer, other;

  beforeEach(async function () {
    [sequencer, other] = await ethers.getSigners();
    contract = await ethers.deployContract("RollupVerifier", [sequencer.address]);
    rollup = await new Rollup({ contract, genesis: GENESIS, maxBatchSize: 2 }).init();
  });

  it("queues valid transactions and rejects invalid ones", function () {
    expect(rollup.sendTokens("alice", "bob", 10).accepted).to.equal(true);
    const tooMuch = rollup.sendTokens("bob", "alice", 500);
    expect(tooMuch.accepted).to.equal(false);
    expect(tooMuch.errors[0]).to.contain("Insufficient balance");
    expect(rollup.createInvalidSample("nonce").accepted).to.equal(false);
    expect(rollup.createInvalidSample("self").accepted).to.equal(false);
    expect(rollup.pending).to.have.length(1);
  });

  it("accounts for pending transactions when validating new ones", function () {
    expect(rollup.sendTokens("bob", "carol", 40).accepted).to.equal(true);
    expect(rollup.sendTokens("bob", "carol", 20).accepted).to.equal(false); // only 10 left
  });

  it("processes pending transactions into batches of the configured size", function () {
    rollup.sendTokens("alice", "bob", 1);
    rollup.sendTokens("alice", "bob", 2);
    rollup.sendTokens("alice", "bob", 3);
    const first = rollup.processBatch();
    expect(first.batch.txCount).to.equal(2);
    expect(rollup.pending).to.have.length(1);
    const second = rollup.processBatch();
    expect(second.batch.batchNumber).to.equal(2);
    expect(second.batch.prevStateRoot).to.equal(first.batch.newStateRoot); // batches chain together
    expect(rollup.processBatch()).to.equal(null);
    expect(rollup.state.getBalance("bob")).to.equal(56);
  });

  it("submits a commitment on-chain and verifies it", async function () {
    rollup.sendTokens("alice", "bob", 10);
    rollup.sendTokens("bob", "carol", 5);
    const { batch } = rollup.processBatch();

    await expect(rollup.contract.submitBatch.staticCall(batch.batchNumber, batch.commitment, batch.txCount)).to.not.be
      .reverted;
    const record = await rollup.submitBatch(batch.batchNumber);
    expect(record.status).to.equal("submitted");
    expect(await contract.verifyBatch(batch.batchNumber, batch.commitment)).to.equal(true);

    const verification = await rollup.verifyBatch(batch.batchNumber);
    expect(verification.verified).to.equal(true);
  });

  it("detects tampering against the on-chain record", async function () {
    rollup.sendTokens("alice", "bob", 10);
    rollup.sendTokens("alice", "carol", 5);
    const { batch } = rollup.processBatch();
    await rollup.submitBatch(batch.batchNumber);

    const demo = await rollup.tamperDemo(batch.batchNumber, 0);
    expect(demo.naive.valid).to.equal(false);
    expect(demo.withFixedHashes.commitmentChanged).to.equal(true);
    expect(demo.withFixedHashes.matchesOnChain).to.equal(false);
    expect(demo.withFixedHashes.verified).to.equal(false);
    // the real batch is untouched and still verifies
    expect((await rollup.verifyBatch(batch.batchNumber)).verified).to.equal(true);
  });

  it("refuses to submit a corrupted batch", async function () {
    rollup.sendTokens("alice", "bob", 10);
    const { batch } = rollup.processBatch();
    batch.transactions[0].amount = 99; // corrupt it after processing
    let error;
    try {
      await rollup.submitBatch(batch.batchNumber);
    } catch (err) {
      error = err;
    }
    expect(error.message).to.contain("Refusing to submit invalid batch");
    expect(await contract.batchCount()).to.equal(0n);
  });

  it("rejects duplicate on-chain submission and double local submission", async function () {
    rollup.sendTokens("alice", "bob", 10);
    const { batch } = rollup.processBatch();
    await rollup.submitBatch(batch.batchNumber);

    await expect(contract.submitBatch(batch.batchNumber, batch.commitment, batch.txCount)).to.be.revertedWith(
      "Batch already submitted"
    );
    let error;
    try {
      await rollup.submitBatch(batch.batchNumber);
    } catch (err) {
      error = err;
    }
    expect(error.message).to.contain("already submitted");
  });

  it("prevents an unauthorized account from submitting a batch", async function () {
    rollup.sendTokens("alice", "bob", 10);
    const { batch } = rollup.processBatch();
    await expect(contract.connect(other).submitBatch(batch.batchNumber, batch.commitment, batch.txCount)).to.be
      .revertedWith("Only sequencer");
  });

  it("submitNextBatch sends batches in order", async function () {
    for (let i = 0; i < 4; i++) rollup.sendTokens("alice", "bob", 1);
    rollup.processBatch();
    rollup.processBatch();
    expect((await rollup.submitNextBatch()).batch.batchNumber).to.equal(1);
    expect((await rollup.submitNextBatch()).batch.batchNumber).to.equal(2);
    expect(await rollup.submitNextBatch()).to.equal(null);
    expect(await contract.batchCount()).to.equal(2n);
  });
});
