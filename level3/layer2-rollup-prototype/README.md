# Layer 2 Rollup Prototype

An **educational** prototype that shows the core idea of a Layer 2 rollup:

1. transactions are executed **off-chain** against a simple balance ledger,
2. they are grouped into **batches** and validated,
3. each batch is summarised by a **cryptographic commitment** (a hash),
4. only that commitment is recorded **on a local Ethereum blockchain** by a smart contract,
5. anyone can later **verify** a batch against the recorded commitment, and tampering changes the hash.

> ⚠️ **This is NOT a production rollup and provides NO real rollup security.** The contract stores hashes; it does not prove that a batch is valid. See [Limitations](#limitations-compared-with-real-rollups).

Stack: Solidity 0.8.19 · Hardhat · ethers.js v6 · Node.js · plain HTML/CSS/JS dashboard. Hashing uses **keccak256** (Ethereum's hash). Everything runs locally on free test accounts; no real funds or private keys are needed.

---

## What is a Layer 2 rollup?

Ethereum (Layer 1) is secure but every transaction costs gas and block space is limited. A **rollup** moves the work off the main chain:

- A **sequencer** collects many user transactions and executes them off-chain.
- It posts a compact **summary** (a commitment, plus in real rollups the transaction data) to Layer 1 in one cheap transaction.
- Layer 1 acts as the source of truth. In an **optimistic rollup**, others can submit *fraud proofs* if a batch is wrong. In a **zero-knowledge rollup**, a *validity proof* shows the batch is correct before it is accepted.

This project builds the middle part, executing, batching, committing and checking, without the proof systems.

## How this prototype works

### Data formats

Transaction:
```json
{ "from": "alice", "to": "bob", "amount": 25, "nonce": 0 }
```
`nonce` must equal the sender's number of previously sent transactions. This enforces ordering and prevents replays.

Batch (simplified):
```text
batchNumber    1, 2, 3, ...
prevStateRoot  hash of all balances/nonces BEFORE the batch
txRoot         keccak256 of the ordered transaction hashes
newStateRoot   hash of all balances/nonces AFTER the batch
commitment     keccak256(abi.encode(batchNumber, prevStateRoot, txRoot, newStateRoot))   <- goes on-chain
transactions   the transactions, in order      (stays off-chain)
preState       balances/nonces before the batch (stays off-chain, lets anyone replay it)
```

### Architecture

```text
 Dashboard (public/)  --HTTP-->  server.js  --uses-->  Rollup client (src/)  --ethers.js-->  Hardhat node
  buttons + tables               JSON API               state / batch / verifier              RollupVerifier.sol
```

| File | Role |
|---|---|
| `contracts/RollupVerifier.sol` | Stores `batchNumber -> commitment`, enforces rules, emits events, answers `verifyBatch` |
| `src/transaction.js` | Transaction format checks and hashing |
| `src/state.js` | Balances and nonces, transaction execution, state root |
| `src/batch.js` | Batch building, commitment computation, full batch validation |
| `src/rollup.js` | The client: queue, process, submit, verify (also the CLI demo) |
| `src/verifier.js` | Contract ABI/connection, on-chain verification, tamper demo |
| `scripts/deploy.js` | Deploys the contract, saves its address in `deployments/localhost.json` |
| `server.js` | Small dependency-free web server for the dashboard |
| `public/` | Dashboard (HTML, CSS, JS) |
| `test/` | Contract tests and client tests |

### Transaction lifecycle

1. **Submit**: the client checks the format, nonce and balance (counting transactions already pending). Invalid transactions are rejected and never queued.
2. **Process batch**: up to 5 pending transactions are executed in order against the state, grouped into a batch, and a commitment is computed. The batch is then validated from scratch (replay + recompute every hash). Status: `validated`.
3. **Submit commitment**: the batch is validated *again*, then `submitBatch(batchNumber, commitment, txCount)` is sent to the contract. Status: `submitted`.
4. **Verify**: the client recomputes the commitment from the batch contents (it does not trust the stored value) and asks the contract `verifyBatch(batchNumber, commitment)`.

### Smart contract rules (`RollupVerifier.sol`)

- `submitBatch` can only be called by the **sequencer** (the deploying account), otherwise `Only sequencer`.
- Duplicate batch numbers revert with `Batch already submitted`.
- Batches must be recorded in order (`1, 2, 3...`), otherwise `Batch number out of order`.
- Empty commitments or empty batches are rejected.
- `BatchSubmitted(batchNumber, commitment, submitter, txCount)` is emitted for every batch.
- `verifyBatch`, `getBatch`, `batchExists`, `batchCount`, `nextBatchNumber` are read-only helpers.

### Validation model

A batch is valid only if: the starting state matches `prevStateRoot`; every transaction has a valid format, correct nonce (ordering) and sufficient balance; total token supply is unchanged; and `txRoot`, `newStateRoot` and `commitment` all match a fresh recomputation.

### Tamper demonstration

Changing one amount in a batch is caught in two ways:
- **Edit only**: the stored `txRoot` / `newStateRoot` / `commitment` no longer match, so validation fails.
- **Edit + recompute all hashes**: the batch becomes internally consistent, but its **commitment is different**, so it does **not** match what is recorded on-chain.

---

## Installation and execution

Requirements: **Node.js 18 or newer** (tested with Node 22) and npm. Open **three terminals** in the project folder.

```bash
# 0. Install dependencies (once)
npm install

# Terminal 1: start the local blockchain (leave it running)
npm run node

# Terminal 2: compile + deploy the contract to that node
npm run deploy

# Terminal 2: run the command-line demo
npm run client

# Terminal 2: start the dashboard, then open http://localhost:3000
npm run frontend
```

Restart the node → run `npm run deploy` again (the chain starts empty, and the saved address is no longer valid). For a clean demo, redeploy before starting the dashboard.

### Run the tests

```bash
npm test
```
Tests use Hardhat's built-in in-memory network, so you do **not** need the node running.

Covered: valid execution, invalid transaction rejection, insufficient balance, nonce/ordering errors, commitment generation, tamper detection, contract submission, verification, duplicate rejection, unauthorized submission and out-of-order batches.

### Using the dashboard

The dashboard updates **live**: it polls the server every 2 seconds, so changes (including from auto mode or another browser tab) appear without clicking anything. A green **● live** badge shows the connection. Tick **Auto mode** and the server will batch and submit pending transactions every 3 seconds on its own.

1. **Create sample transactions**: random valid transfers appear under *Pending*.
2. **Try an invalid transaction**: shows a rejection reason; nothing is queued.
3. **Process batch**: pending transactions become a validated batch with commitment hashes.
4. **Submit commitment**: records the commitment on-chain; see *On-chain submission history*.
5. **Auto mode** (checkbox): processes and submits pending transactions automatically.
6. **Verify batches** (or per-batch *Verify against chain*) and **Tamper demo** (works on a copy; changes nothing real).

## Example output (`npm run client`)

Captured from a real run on a fresh local node (addresses and hashes will differ slightly each time you redeploy):

```text
Layer 2 Rollup Prototype (educational - NOT a production rollup)
Contract: 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 | first batch number: 1
Genesis balances: { alice: 1000, bob: 500, carol: 250, dave: 100 }

=== 1. Submit transactions (2 valid + 3 invalid) ===
ACCEPTED alice -> bob 100 
ACCEPTED bob -> carol 50 
REJECTED dave -> alice 9999 (too much) -> Insufficient balance: dave has 100 but needs 9999
REJECTED alice -> bob 5 with nonce 7 -> Bad nonce: alice expected 1 but got 7
REJECTED carol -> carol 1 (self) -> Sender and recipient must be different accounts
Pending: 2

=== 2. Process batch off-chain ===
Batch #1: 2 txs, status=validated
  prevStateRoot: 0x6acdd137...c6ad9c
  txRoot:        0x7745595b...86a146
  newStateRoot:  0x762581b5...ebf8d4
  commitment:    0x9f8505ec22b1096b27fd44077d5a29e3c001018c55a63ed3f088fc1e0b3d81bf
New balances: { alice: 900, bob: 550, carol: 300, dave: 100 }

=== 3. Submit commitment on-chain ===
Recorded in block 11, tx 0x8c024bcf...eaffca, gas 160720

=== 4. Verify against the chain ===
{
  batchNumber: 1,
  existsOnChain: true,
  locallyValid: true,
  localErrors: [],
  recomputedCommitment: '0x9f8505ec22b1096b27fd44077d5a29e3c001018c55a63ed3f088fc1e0b3d81bf',
  matchesOnChain: true,
  verified: true
}

=== 5. Tamper demo (copies only; nothing real is changed) ===
Changed tx #0 amount 100 -> 99
Original commitment:        0x9f8505ec22b1096b27fd44077d5a29e3c001018c55a63ed3f088fc1e0b3d81bf
Naive edit detected?         true - txRoot mismatch: the transactions were changed after the batch was built
Edit + recomputed hashes:    0x040def769665895ab33ff6091285aa4aeefb12494d20f8a6284c407d426844f7
  matches on-chain record?   false

=== 6. Duplicate submission is rejected by the contract ===
Rejected as expected: Batch already submitted

Done. On-chain batch count: 1
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot reach a node at http://127.0.0.1:8545` | Start the node: `npm run node` (keep that terminal open). |
| `No deployment found` | Run `npm run deploy` while the node is running. |
| `The saved contract address has no code` | You restarted the node. Run `npm run deploy` again. |
| Port 8545 or 3000 already in use | Stop the other program, or change `RPC_URL` / `PORT` in a `.env` file (copy `.env.example`). |
| `HH502: Couldn't download compiler version list` | Your network blocks Hardhat's compiler download. Run `npm install --no-save solc@0.8.19`, then use `USE_SOLCJS=1 npm test` (macOS/Linux) or `$env:USE_SOLCJS=1; npm test` (PowerShell). Same compiler, just slower. |
| Contract rejected batch: `Batch number out of order` | The chain already holds batches from an earlier session. Restart the node and redeploy. |
| Dashboard shows old data after redeploying | Restart `npm run frontend` (it keeps its state in memory). |
| Old Node.js version errors | Install Node.js 18+ (`node -v` to check). |

## Limitations compared with real rollups

This is a teaching tool. Compared with real optimistic and zero-knowledge rollups:

- **No proofs.** The contract trusts the sequencer. It never checks that a batch is valid; it only stores and compares a hash. Real optimistic rollups allow *fraud proofs* during a challenge window; ZK rollups verify a *validity proof* on-chain.
- **Validation is done by the client only.** "Validated" here means our own JavaScript re-ran the transactions. A malicious sequencer could commit an invalid batch and the contract would accept it.
- **No transaction data on-chain.** Real rollups publish transaction data (calldata or blobs) so anyone can reconstruct the state. Here the batch data lives only in the client's memory, so if it is lost the commitment cannot be checked.
- **No signatures.** Anyone can create a transaction for any account. Real systems require users to sign transactions.
- **Single trusted sequencer** with no decentralisation, censorship resistance or forced exits.
- **No deposits or withdrawals.** Balances are fictional genesis values and are not backed by ETH locked on Layer 1.
- **No state proofs.** The state root is a flat hash, not a Merkle tree, so you cannot prove a single balance without the whole state.
- **No persistence.** The client keeps its state in memory; restarting the dashboard server resets it.
- **No fee market, finality rules, or security audit.**

## Publish on GitHub

```bash
# 1. Create an EMPTY repository on github.com (no README), e.g. "layer2-rollup-prototype"
# 2. In the project folder:
git init
git add .
git commit -m "Layer 2 rollup prototype"
git branch -M main
git remote add origin https://github.com/<your-username>/layer2-rollup-prototype.git
git push -u origin main
```
`.gitignore` already excludes `node_modules/`, build output, `deployments/` and `.env`. Never commit private keys. This project does not need one.

## License

MIT, for learning and experimentation.
