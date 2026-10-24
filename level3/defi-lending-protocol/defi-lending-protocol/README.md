# DeFi Lending Protocol (educational project)

A small lending and borrowing protocol written in Solidity, with Hardhat unit tests, Foundry fuzz and invariant tests, deployment scripts for a local node and the Sepolia testnet, and a simple MetaMask frontend.

> **Not audited. Not production-ready. Do not use real money.**
> This project exists to teach how a lending protocol works. The price feed is a number the owner types in, no interest is charged, and many risks of real protocols are not handled (see [Security considerations](#11-security-considerations-and-known-limitations)).

---

## Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Workflows](#3-workflows)
4. [Install](#4-install)
5. [Run the tests](#5-run-the-tests)
6. [Gas optimizations and measurements](#6-gas-optimizations-and-measurements)
7. [Deploy locally](#7-deploy-locally)
8. [Deploy to Sepolia](#8-deploy-to-sepolia)
9. [Frontend](#9-frontend)
10. [Example transaction walkthrough](#10-example-transaction-walkthrough)
11. [Security considerations and known limitations](#11-security-considerations-and-known-limitations)
12. [What was and was not verified](#12-what-was-and-was-not-verified)

---

## 1. Overview

Users can:

| Action | Function | What it does |
|---|---|---|
| Lend | `deposit` / `withdraw` | Put tokens in the shared pool so others can borrow them. Withdraw when the pool has free tokens. |
| Add collateral | `depositCollateral` / `withdrawCollateral` | Lock tokens that back a loan. Collateral is **not** lent to others. |
| Borrow | `borrow` | Take tokens from the pool, up to the borrow limit. |
| Repay | `repay` | Pay debt back. Over-paying only takes what is owed. |
| Liquidate | `liquidate` | Anyone can repay part of an unhealthy loan and receive the borrower's collateral plus a bonus. |

The owner can list assets, set prices and risk parameters, and pause the protocol. Everything else is permissionless.

## 2. Architecture

```
defi-lending-protocol/
├── contracts/
│   ├── DeFiLendingProtocol.sol        main protocol
│   ├── MockERC20.sol                  free-to-mint test token
│   ├── mocks/
│   │   ├── ReentrantToken.sol         test token that tries to re-enter the protocol
│   │   └── FeeOnTransferToken.sol     test token that burns 1% per transfer
│   └── baseline/
│       └── NaiveLendingProtocol.sol   un-optimized twin, used ONLY for the gas comparison
├── scripts/
│   ├── deploy.js                      deploy + configure + save JSON + verify
│   └── gas-compare.js                 before/after gas table
├── test/DeFiLendingProtocol.test.js   57 Hardhat unit tests
├── test-foundry/
│   ├── DeFiLendingProtocolFuzz.t.sol       7 fuzz tests
│   └── DeFiLendingProtocolInvariant.t.sol  5 invariants + handler
├── frontend/                          index.html, style.css, app.js (+ vendor/ethers)
├── deployments/                       deployment records are written here
├── gas-report/                        generated gas reports
├── hardhat.config.js, foundry.toml, package.json, .env.example, .gitignore
└── lib/forge-std/                     Foundry test library (bundled)
```

### Key ideas in `DeFiLendingProtocol.sol`

* **Per-user, per-asset records**: `deposits` (lent), `collateral`, `debt`.
* **Prices** are USD values with 1e18 precision for one whole token, set by the owner (`setAssetPrice`). Example: `2000e18` means $2,000.
* **Two risk numbers per asset** (in basis points, 10,000 = 100%):
  * `ltvBps` (loan-to-value): how much you can borrow against collateral. 7,500 = you can borrow up to 75% of collateral value.
  * `liquidationThresholdBps`: if debt rises above this share of collateral value, the loan can be liquidated. Always >= LTV, so a safety gap exists between "you cannot borrow more" and "you get liquidated".
* **Collateral ratio** = collateral value / debt value (shown in bps). **Health factor** = liquidation capacity / debt (1e18 = right at the liquidation line).
* **Liquidation rules** (see the NatSpec on `liquidate`):
  1. The borrower's total debt value must exceed their liquidation capacity.
  2. You may repay at most `closeFactorBps` (default 50%) of the borrower's debt in one asset per call.
  3. You receive repaid value x (1 + `liquidationBonusBps`, default 5%) in the collateral token you choose.
  4. If the borrower has less collateral than that, you take it all and pay proportionally less.
* **Owner controls** (`Ownable2Step`, so ownership transfers need acceptance): `addAsset`, `addAssets`, `setAssetRisk`, `setAssetPrice`, `setLiquidationParams`, `pause`, `unpause`. Parameter checks keep `threshold x (1 + bonus) <= 100%`, so liquidating never seizes more value than exists.
* **Pause** blocks deposits, new collateral, borrowing and liquidation, but **repay and withdrawals stay open** so users are never locked in.
* **Events**: `Deposited`, `Withdrawn`, `CollateralDeposited`, `CollateralWithdrawn`, `Borrowed`, `Repaid`, `Liquidated`, plus admin events.

## 3. Workflows

**Deposit (lender)** → approve token → `deposit(token, amount)` → tokens enter the pool, your `deposits` balance grows.

**Collateral + borrow** → approve → `depositCollateral(weth, 10e18)` → `borrow(usdc, 10_000e6)`. The contract recomputes your account (summing every asset you use) and reverts with `ExceedsBorrowLimit` if debt value > borrow capacity.

**Repay** → approve → `repay(usdc, amount)`. Debt shrinks; borrow power returns.

**Withdraw collateral** → `withdrawCollateral(weth, amount)`. Reverts with `ExceedsBorrowLimit` if the remaining collateral would no longer cover your loan at the LTV.

**Withdraw deposit** → `withdraw(usdc, amount)`. Needs your deposit balance >= amount **and** enough free liquidity in the pool (`InsufficientLiquidity` otherwise).

**Liquidation** → price drops, `isLiquidatable(borrower)` becomes true → liquidator approves the debt token → `liquidate(borrower, debtToken, collateralToken, repayAmount)`.

## 4. Install

**Required software**

* Node.js 18+ (tested with Node 22) and npm
* Git (only needed if you re-install Foundry libraries)
* [Foundry](https://book.getfoundry.sh/getting-started/installation) for fuzz/invariant tests (`curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`). Tested with forge 1.5.1.
* MetaMask browser extension (frontend only)

```bash
cd defi-lending-protocol
npm install
cp .env.example .env     # then edit .env (only needed for Sepolia)
```

Dependencies (pinned in `package.json`): Hardhat ^2.22 with `@nomicfoundation/hardhat-toolbox` ^5 (ethers v6, chai, gas reporter, verify), OpenZeppelin Contracts **5.0.2**, dotenv, http-server. Solidity is fixed at **0.8.24**; `forge-std` v1.9.4 is bundled in `lib/`.

**Environment variables** (`.env`, never commit it):

| Variable | Needed for | Meaning |
|---|---|---|
| `SEPOLIA_RPC_URL` | Sepolia | HTTPS RPC URL from Alchemy, Infura, QuickNode... |
| `PRIVATE_KEY` | Sepolia | Private key of a **throwaway** wallet holding only test ETH |
| `ETHERSCAN_API_KEY` | optional | Enables automatic contract verification |
| `REPORT_GAS` | optional | `true` prints a gas table during tests |
| `SEED_LIQUIDITY` | optional | `true` makes the deploy script also deposit starter liquidity (always on for local networks) |

## 5. Run the tests

```bash
npx hardhat compile            # compile contracts
npm test                       # 57 Hardhat unit tests
npm run test:gas               # same tests + gas table (gas-report/hardhat-gas-report.txt)

npm run test:fuzz              # 7 Foundry fuzz tests (1000 runs each)
npm run test:invariant         # 5 invariants (256 runs x 100 calls each)
npm run test:foundry           # all Foundry tests
npm run test:all               # Hardhat + Foundry
```

Increase fuzzing depth: `forge test --fuzz-runs 10000`.

**What the tests cover**

* *Unit tests*: deposits/withdrawals, collateral, borrowing inside/outside the limit (exact boundary and one-wei-over), multi-asset limits, repayment (partial, full, over-payment, no debt), insufficient balance/allowance, withdrawal restrictions with open loans, ratio and health factor, liquidation eligibility/close factor/bonus/short-collateral/same-token case, pause behavior, access control on every owner function, two-step ownership.
* *Security*: reentrancy through a malicious token during `deposit`, `borrow` and `withdraw` (the guard rejects the inner call and accounting stays intact); fee-on-transfer tokens rejected; no cross-user access.
* *Fuzz properties*: borrowing never exceeds the limit; debt/total-borrow accounting stays exact through borrow and repay; required collateral can never be withdrawn; strangers can never change configuration; repayments never exceed debt; deposit/withdraw round trips are exact; liquidations only hit unhealthy accounts, respect the close factor and keep totals exact.
* *Invariants* (a handler randomly deposits, withdraws, borrows, repays, moves prices and liquidates across 3 users and 2 tokens): per-user sums equal protocol totals; the token balance always equals `deposits + collateral - borrows`; borrows never exceed deposits; `borrow`/`withdrawCollateral` never leave an account over its limit; healthy accounts are never liquidated.

## 6. Gas optimizations and measurements

| Technique | Where | Why it helps |
|---|---|---|
| Packed structs | `AssetConfig` (22 bytes), `Position` (collateral+debt, 32 bytes), `Totals` (deposits+borrows, 32 bytes) | One storage slot read/written instead of several (each cold `SLOAD` is 2,100 gas) |
| `uint128` for balances | `Position`, `Totals` | Enables packing; max ~3.4e38 base units is far above any real supply. Narrowing uses `SafeCast`, so overflow reverts instead of wrapping |
| Cache storage in memory/locals | `withdraw`, `borrow`, `_accountValues` (`Totals`, `Position`, `AssetConfig`, array length) | Read once, use many times |
| Minimal writes | `withdraw`/`borrow` write a whole `Totals` once; the health loop is read-only | Each `SSTORE` is the most expensive operation |
| Custom errors | all reverts | No string storage/ABI-encoding of messages |
| `calldata` for arrays | `addAssets(AssetParams[] calldata)` | No copy into memory |
| `unchecked` where provably safe | subtractions right after bounds checks in `withdraw`, `withdrawCollateral`, `repay` | Skips redundant overflow checks; each use has a comment with the proof |
| Bounded loops | `MAX_ASSETS = 16`; loop skips assets the user does not use | Predictable cost, no unbounded iteration |
| `immutable`/`constant` | `BPS`, limits, mock token decimals | Inlined, no storage reads |

Security was **not** traded away for gas: the optimized contract keeps the reentrancy guard, `SafeERC20`, the pause switch and the fee-on-transfer check.

### Before / after

`scripts/gas-compare.js` runs the same scenario on `NaiveLendingProtocol` (revert strings, one mapping per field, no caching, `.length` and every mapping re-read inside loops) and on `DeFiLendingProtocol`. The baseline has the **same safety features**, so the table isolates the optimizations. Measured on the in-memory Hardhat network (Solidity 0.8.24, optimizer 200 runs):

```
| Function | Baseline (gas) | Optimized (gas) | Saved (gas) | Saved (%) |
|---|---:|---:|---:|---:|
| deposit (first deposit) | 109051 | 109513 | -462 | -0.4% |
| depositCollateral (first deposit) | 109074 | 109591 | -517 | -0.5% |
| borrow (first loan) | 158977 | 113190 | 45787 | 28.8% |
| repay (partial) | 58667 | 58201 | 466 | 0.8% |
| withdrawCollateral (with open loan) | 118214 | 92483 | 25731 | 21.8% |
| withdraw (partial) | 73498 | 70985 | 2513 | 3.4% |
```

Reproduce with `npm run gas:compare`. How to read it:

* **`borrow` (-29%) and `withdrawCollateral` (-22%)** gain the most because they run the account-health loop, where packing and caching pay off.
* **`deposit`, `depositCollateral`, `repay`** are about equal (within 1%). They are dominated by token transfers and new-storage-slot writes that no optimization can avoid, and the optimized version spends a few hundred gas on `SafeCast`, the pause check and its extra bookkeeping. That is an honest result, not a bug.
* Numbers vary by compiler settings and token implementation. `gas-report/hardhat-gas-report.txt` has min/avg/max per function across the whole test suite (for example `liquidate` avg ≈ 123k, `borrow` avg ≈ 113k, `repay` avg ≈ 55k). Foundry's table: `npm run gas:foundry`.

## 7. Deploy locally

```bash
# terminal 1: start a local blockchain (prints 20 funded test accounts)
npx hardhat node

# terminal 2: deploy
npm run deploy:local
```

The script deploys the protocol and three mock tokens (mWETH 18 dec @ $2,000, mUSDC 6 dec @ $1, mDAI 18 dec @ $1), lists them with risk parameters (75/80%, 80/85%, 75/80% LTV/threshold), seeds the pool with 100,000 mUSDC and mDAI, prints every address, writes `deployments/localhost.json` and updates `frontend/deployments.json`.

## 8. Deploy to Sepolia

> Deployment to Sepolia has **not** been executed for this package (it needs your wallet and RPC key). The steps below are what you run yourself.

1. **Create a throwaway wallet** in MetaMask (never one holding real funds). Export its private key (MetaMask → account details → show private key).
2. **Get an RPC URL**: create a free account at Alchemy, Infura or QuickNode, create a Sepolia app and copy the HTTPS URL.
3. **Get Sepolia test ETH** from a faucet, for example the [Google Cloud Web3 Sepolia faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia), the [Alchemy Sepolia faucet](https://www.alchemy.com/faucets/ethereum-sepolia), or the [Infura Sepolia faucet](https://www.infura.io/faucet/sepolia). Faucet rules change (some require a small mainnet balance or a login), so try another if one refuses. You need roughly 0.05 test ETH.
4. **Fill `.env`** (copy from `.env.example`): `SEPOLIA_RPC_URL`, `PRIVATE_KEY`, and optionally `ETHERSCAN_API_KEY` (free at etherscan.io).
5. **Deploy**:
   ```bash
   npm run deploy:sepolia
   ```
   Optional: `SEED_LIQUIDITY=true npm run deploy:sepolia` also deposits 100k mUSDC/mDAI so borrowing works immediately.
6. The script prints addresses, saves `deployments/sepolia.json`, and, if `ETHERSCAN_API_KEY` is set, verifies all four contracts after 5 confirmations. If verification fails, re-run manually: `npx hardhat verify --network sepolia <address> <constructor args>`.
7. Look the addresses up on https://sepolia.etherscan.io to confirm the deployment really happened.

The mock tokens are deployed fresh (no real token addresses are hardcoded). Anyone can mint them.

## 9. Frontend

```bash
npm run deploy:local        # or deploy:sepolia, so frontend/deployments.json exists
npm run frontend            # serves http://localhost:8080
```

Open http://localhost:8080 (do not open `index.html` by double-clicking; the page needs a web server to read `deployments.json`).

* **Connect** MetaMask. For the local network use "Add network": RPC `http://127.0.0.1:8545`, chain id `31337`. Import a Hardhat test account using a private key printed by `npx hardhat node` (those keys are public; never use them anywhere real).
* The header shows which network the app targets and which network your wallet is on. If they differ, a red banner appears with a **Switch network** button.
* The **Markets** table shows prices, your wallet/deposit/collateral/debt per token and pool liquidity. **Your position** shows collateral value, debt, borrow limit, collateral ratio and a gauge (red = liquidation zone, amber = above borrow limit, green = safe).
* **Actions** has one tab per operation. ERC-20 approval happens automatically as a first transaction. Use **Mint** buttons to get free test tokens. The **Activity** list shows pending/confirmed transactions (with Etherscan links on Sepolia) and plain-English errors.
* **Live updates**: every 3 seconds the page checks for a new block and refreshes balances, prices, position and gauge automatically (see "Live · block N" under *Your position*). It pauses while a transaction is in progress or the tab is hidden.
* ethers v6 is bundled in `frontend/vendor/` so the page loads no third-party scripts.

## 10. Example transaction workflow

All amounts below were verified by the test suite. Prices: WETH $2,000, USDC $1.

1. **Alice (lender)** approves and calls `deposit(USDC, 100_000e6)`. Pool liquidity = 100,000 USDC.
2. **Bob (borrower)** approves and calls `depositCollateral(WETH, 10e18)`. Collateral value $20,000, borrow limit $15,000 (75%).
3. Bob calls `borrow(USDC, 10_000e6)`. Debt $10,000. Collateral ratio 200%, health factor 1.6.
4. Bob tries `borrow(USDC, 5_000e6 + 1)` → reverts `ExceedsBorrowLimit` (the exact limit, 5,000 USDC more, is allowed).
5. Bob tries `withdrawCollateral(WETH, 4e18)` → reverts (needs ≥ 6.67 WETH to secure $10,000). He may withdraw up to 3.333… WETH.
6. Bob borrows up to $15,000, then WETH drops to $1,800. Collateral $18,000, liquidation capacity $14,400 < debt $15,000 → liquidatable.
7. **Carol** calls `liquidate(Bob, USDC, WETH, 7_500e6)` (the 50% maximum). She pays 7,500 USDC and receives 4.375 WETH ($7,875 = 7,500 + 5%). Bob's debt is now $7,500 and he is healthy again.
8. Bob repays with `repay(USDC, 7_500e6)`, withdraws his remaining 5.625 WETH. Alice withdraws her USDC.

## 11. Security considerations and known limitations

Design measures: checks-effects-interactions plus OpenZeppelin `ReentrancyGuard` on every state-changing user function; `SafeERC20`; custom errors; `SafeCast` for narrowing; `Ownable2Step`; `Pausable`; conservative rounding (collateral rounds down, debt rounds up); parameter validation that keeps liquidation solvent; fee-on-transfer detection by balance difference; bounded loops.

**Known limitations (do not ignore):**

1. **Manual price oracle.** The owner sets prices. A malicious or mistaken owner can set a price that wipes out borrowers or lets someone borrow far too much. Real protocols use decentralized oracles (e.g. Chainlink) with staleness and sanity checks.
2. **Owner trust.** The owner can change prices, risk settings and pause. Use a multisig and timelock in anything real. Lowering a threshold can make existing loans instantly liquidatable.
3. **No interest.** Borrowers pay nothing; lenders earn nothing. Real pools need interest rate models.
4. **Bad debt is not handled.** If collateral value falls below debt faster than liquidators act, the unpaid remainder stays as debt and lenders may be unable to withdraw everything (the "short collateral" test demonstrates this).
5. **Unsupported tokens**: fee-on-transfer (rejected), rebasing, ERC-777/hook tokens, tokens with blocklists or pausing, and tokens with more than 18 decimals. Only list well-behaved ERC-20s.
6. **Asset list cap.** At most 16 assets; assets cannot be removed once listed (only their risk/price can change).
7. **Same-asset borrowing**: lenders can borrow from the pool they supplied to; the accounting stays correct but it is economically odd.
8. **Pausing** does not stop repay/withdraw by design; it also does not stop owner configuration.
9. **Rounding dust**: sub-wei rounding can leave tiny amounts; tests cover boundaries to one base unit.
10. **No audit, no formal verification**. Fuzzing and invariants increase confidence but cannot prove absence of bugs.
11. **Frontend** trusts `deployments.json` and the RPC your wallet uses; it shows values from the chain but is a demo, not a hardened app.

## 12. What was and was not verified

Checked in the build environment (Linux, Node 22, Solidity 0.8.24, forge 1.5.1):

* Contracts compile with no errors.
* `npm test`: **57 passing, 0 failing**.
* Foundry: **7 fuzz tests (1000 runs each) and 5 invariants (256 runs × depth 100) pass**. The invariant handler was checked to actually reach successful liquidations.
* Deployment script run against a local `hardhat node`: contracts deployed, configured, seeded, JSON files written.
* Frontend logic was driven end-to-end against that local node (connect, mint, collateral, rejected over-limit borrow, borrow, blocked collateral withdrawal, repay, withdraw) using **jsdom with a scripted wallet**.
* Live updates: with the page left idle, transactions sent from outside the page (collateral deposit, price change) appeared in the UI within seconds with no click or reload.

**Not done / could not be done here:**

* **No Sepolia deployment was executed** (needs your keys and test ETH), so nothing was verified on Etherscan.
* **The frontend was not opened in a real browser with real MetaMask.** Expect to fix small visual or wallet-prompt issues.
* Solidity compilers are normally downloaded by Hardhat from binaries.soliditylang.org, which was blocked in the build environment, so a locally supplied `solc 0.8.24` binary (from the official GitHub release) was used there. On your machine Hardhat/Foundry download it normally; the shipped config does not contain that workaround.
* No external audit, no mainnet fork tests, no static-analysis tools (Slither/Mythril) were run.
