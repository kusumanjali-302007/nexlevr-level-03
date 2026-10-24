/**
 * state.js - the rollup's off-chain "ledger": who owns how many tokens.
 *
 * The State remembers two things per account:
 *   balances[account] : tokens owned
 *   nonces[account]   : number of transactions the account has sent
 *
 * It can summarise itself as a single "state root" hash. If any balance or nonce
 * changes, the state root changes.
 */
const { keccak256, toUtf8Bytes } = require("ethers");
const { validateTransactionFormat } = require("./transaction");

class State {
  constructor(balances = {}, nonces = {}) {
    this.balances = { ...balances };
    this.nonces = { ...nonces };
  }

  getBalance(account) {
    return this.balances[account] || 0;
  }

  getNonce(account) {
    return this.nonces[account] || 0;
  }

  /**
   * Can this transaction be applied right now? Does NOT change the state.
   * Returns { valid, errors }.
   */
  checkTransaction(tx) {
    const format = validateTransactionFormat(tx);
    if (!format.valid) return format;

    const errors = [];
    const expectedNonce = this.getNonce(tx.from);
    if (tx.nonce !== expectedNonce) {
      errors.push(`Bad nonce: ${tx.from} expected ${expectedNonce} but got ${tx.nonce}`);
    }
    const balance = this.getBalance(tx.from);
    if (balance < tx.amount) {
      errors.push(`Insufficient balance: ${tx.from} has ${balance} but needs ${tx.amount}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /** Apply a transaction. Throws (and changes nothing) if it is invalid. */
  applyTransaction(tx) {
    const check = this.checkTransaction(tx);
    if (!check.valid) throw new Error(check.errors.join("; "));

    this.balances[tx.from] = this.getBalance(tx.from) - tx.amount;
    this.balances[tx.to] = this.getBalance(tx.to) + tx.amount;
    this.nonces[tx.from] = this.getNonce(tx.from) + 1;
    return this;
  }

  /** Independent copy, so we can "try" transactions without touching the real state. */
  clone() {
    return new State(this.balances, this.nonces);
  }

  /** Plain-object copy (safe to send as JSON). */
  snapshot() {
    return { balances: { ...this.balances }, nonces: { ...this.nonces } };
  }

  static fromSnapshot(snapshot) {
    return new State(snapshot.balances, snapshot.nonces);
  }

  totalSupply() {
    return Object.values(this.balances).reduce((sum, value) => sum + value, 0);
  }

  /**
   * Hash of the whole state. Accounts are sorted so the result never depends on
   * the order in which accounts were created.
   */
  root() {
    const accounts = [...new Set([...Object.keys(this.balances), ...Object.keys(this.nonces)])].sort();
    const rows = accounts.map((a) => [a, this.getBalance(a), this.getNonce(a)]);
    return keccak256(toUtf8Bytes(JSON.stringify(rows)));
  }
}

module.exports = { State };
