/**
 * transaction.js - what a rollup transaction looks like, and how to hash it.
 *
 * Every transaction in this prototype has exactly four fields:
 *
 *   { from: "alice", to: "bob", amount: 25, nonce: 0 }
 *
 *   from / to : account names (lowercase letters, digits, underscore)
 *   amount    : whole number of tokens to move (> 0)
 *   nonce     : how many transactions `from` has already sent. It must match the
 *               sender's current nonce, which keeps transactions in order and
 *               stops the same transaction from being applied twice (replay).
 *
 * NOTE: real systems also require a digital signature so only the owner of an
 * account can spend from it. We skip signatures to keep the prototype small.
 */
const { keccak256, toUtf8Bytes } = require("ethers");

const ACCOUNT_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;
const ALLOWED_FIELDS = ["from", "to", "amount", "nonce"];

/** Build a transaction object in the standard format. */
function createTransaction({ from, to, amount, nonce }) {
  return { from, to, amount, nonce };
}

/**
 * Check the *shape* of a transaction (not balances; State does that).
 * Returns { valid: boolean, errors: string[] }.
 */
function validateTransactionFormat(tx) {
  const errors = [];

  if (tx === null || typeof tx !== "object" || Array.isArray(tx)) {
    return { valid: false, errors: ["Transaction must be an object"] };
  }

  for (const key of Object.keys(tx)) {
    if (!ALLOWED_FIELDS.includes(key)) errors.push(`Unknown field "${key}"`);
  }
  for (const field of ["from", "to"]) {
    if (typeof tx[field] !== "string" || !ACCOUNT_PATTERN.test(tx[field])) {
      errors.push(`"${field}" must be a lowercase account name (letters, digits, underscore)`);
    }
  }
  if (typeof tx.from === "string" && tx.from === tx.to) {
    errors.push("Sender and recipient must be different accounts");
  }
  if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) {
    errors.push("\"amount\" must be a positive whole number");
  }
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) {
    errors.push("\"nonce\" must be a non-negative whole number");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Hash a transaction with keccak256 (the hash Ethereum uses).
 * The fields are always written in the same fixed order, so the same transaction
 * always gives the same hash and any change gives a completely different one.
 */
function hashTransaction(tx) {
  const canonical = JSON.stringify([tx.from, tx.to, tx.amount, tx.nonce]);
  return keccak256(toUtf8Bytes(canonical));
}

module.exports = { createTransaction, validateTransactionFormat, hashTransaction, ACCOUNT_PATTERN };
