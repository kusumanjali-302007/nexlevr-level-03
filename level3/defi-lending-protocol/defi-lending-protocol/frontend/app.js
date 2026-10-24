/* Lending Protocol frontend. Plain JavaScript + ethers v6 (loaded from ./vendor/ethers.umd.min.js). */
"use strict";

// ---------------------------------------------------------------------------
// ABIs (human-readable). Error fragments are included so ethers can decode failures.
// ---------------------------------------------------------------------------
const PROTOCOL_ABI = [
  "function deposit(address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount)",
  "function depositCollateral(address asset, uint256 amount)",
  "function withdrawCollateral(address asset, uint256 amount)",
  "function borrow(address asset, uint256 amount)",
  "function repay(address asset, uint256 amount)",
  "function depositOf(address user, address asset) view returns (uint256)",
  "function collateralOf(address user, address asset) view returns (uint256)",
  "function debtOf(address user, address asset) view returns (uint256)",
  "function availableLiquidity(address asset) view returns (uint256)",
  "function maxBorrow(address user, address asset) view returns (uint256)",
  "function assetConfig(address asset) view returns (bool supported, uint8 decimals, uint16 ltvBps, uint16 liquidationThresholdBps, uint128 price)",
  "function getAccountData(address user) view returns (tuple(uint256 collateralValue, uint256 debtValue, uint256 borrowCapacity, uint256 liquidationCapacity, uint256 collateralRatioBps, uint256 healthFactor))",
  "error ZeroAmount()",
  "error AssetNotSupported(address asset)",
  "error InsufficientDeposit()",
  "error InsufficientCollateral()",
  "error InsufficientLiquidity()",
  "error ExceedsBorrowLimit()",
  "error NothingToRepay()",
  "error UnsupportedTokenBehavior()",
  "error EnforcedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];

const FRIENDLY_ERRORS = {
  ZeroAmount: "Enter an amount greater than zero.",
  InsufficientDeposit: "You have not deposited that much of this token.",
  InsufficientCollateral: "You have not added that much collateral of this token.",
  InsufficientLiquidity: "The pool does not have enough free tokens right now. Other users have borrowed them.",
  ExceedsBorrowLimit: "That would put your loan above your borrow limit. Add collateral, repay, or use a smaller amount.",
  NothingToRepay: "You do not owe any of this token.",
  UnsupportedTokenBehavior: "This token charges a fee on transfer and is not supported.",
  EnforcedPause: "The protocol is paused by its owner. Only repaying and withdrawing work.",
  ERC20InsufficientBalance: "Your wallet does not hold enough of this token.",
  ERC20InsufficientAllowance: "Token approval is too low. Try again and approve the transaction.",
  AssetNotSupported: "This token is not supported by the protocol.",
};

const NETWORK_INFO = {
  31337: { name: "Local Hardhat (31337)", rpc: "http://127.0.0.1:8545", currency: "ETH", explorer: null },
  11155111: { name: "Sepolia testnet", rpc: "https://rpc.sepolia.org", currency: "SepoliaETH", explorer: "https://sepolia.etherscan.io" },
};

const ACTIONS = {
  deposit: { label: "Deposit", hint: "Lend tokens to the pool. Others can borrow them and you can withdraw them later." },
  depositCollateral: { label: "Add collateral", hint: "Lock tokens as collateral so you can borrow. Collateral is not lent to others." },
  borrow: { label: "Borrow", hint: "Borrow tokens from the pool, up to your borrow limit." },
  repay: { label: "Repay", hint: "Pay back what you borrowed. Paying more than you owe only takes what you owe." },
  withdraw: { label: "Withdraw", hint: "Take back tokens you deposited, as long as the pool has free tokens." },
  withdrawCollateral: { label: "Remove collateral", hint: "Take collateral back. Blocked if it would put your loan above its borrow limit." },
};

// ---------------------------------------------------------------------------
// State and DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = {
  deployments: {}, // { chainId: {protocol, tokens:{KEY:{address,symbol,decimals,...}}} }
  targetChainId: null,
  provider: null,
  signer: null,
  account: null,
  walletChainId: null,
  action: "deposit",
  accountData: null, // result of getAccountData
  tokens: [], // [{key,address,symbol,decimals,price,ltvBps,wallet,deposited,collateral,debt,liquidity,maxBorrow}]
  busy: false,
  lastBlock: null,
};

const usd = (v) => "$" + Number(ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmt = (v, d) => {
  const n = Number(ethers.formatUnits(v, d));
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 2 : 4 });
};
const selectedDeployment = () => state.deployments[state.targetChainId];
const selectedToken = () => state.tokens.find((t) => t.address === $("assetSelect").value);

function log(message, kind = "", link = null) {
  const list = $("log");
  if (list.firstElementChild && list.firstElementChild.classList.contains("muted")) list.innerHTML = "";
  const li = document.createElement("li");
  if (kind) li.className = kind;
  li.textContent = message;
  if (link) {
    li.append(" ");
    const a = document.createElement("a");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "View transaction";
    li.append(a);
  }
  list.prepend(li);
  return li;
}

function explainError(err) {
  if (err && (err.code === "ACTION_REJECTED" || err.code === 4001)) return "You rejected the request in your wallet.";
  const name = err && err.revert && err.revert.name;
  if (name && FRIENDLY_ERRORS[name]) return FRIENDLY_ERRORS[name];
  if (name) return `The transaction was rejected by the contract (${name}).`;
  const msg = (err && (err.shortMessage || (err.info && err.info.error && err.info.error.message) || err.message)) || String(err);
  return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
}

// ---------------------------------------------------------------------------
// Network handling
// ---------------------------------------------------------------------------
function updateBanner() {
  const banner = $("banner");
  const pill = $("walletNet");
  banner.classList.remove("info");
  banner.innerHTML = "";

  if (!window.ethereum) {
    banner.hidden = false;
    banner.textContent = "No wallet found. Install MetaMask (metamask.io) and reload this page.";
    return;
  }
  if (!selectedDeployment()) {
    banner.hidden = false;
    banner.classList.add("info");
    banner.textContent = "No deployment found for this network. Run a deploy script first (see README), then reload.";
    return;
  }
  if (state.walletChainId === null) {
    pill.textContent = "Wallet: not connected";
    pill.className = "pill";
    banner.hidden = true;
    return;
  }
  const walletName = (NETWORK_INFO[state.walletChainId] || {}).name || `chain ${state.walletChainId}`;
  pill.textContent = `Wallet: ${walletName}`;
  if (state.walletChainId !== state.targetChainId) {
    pill.className = "pill bad";
    banner.hidden = false;
    const text = document.createElement("span");
    text.textContent = `Wrong network. Your wallet is on ${walletName} but this app is set to ${NETWORK_INFO[state.targetChainId].name}.`;
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = `Switch to ${NETWORK_INFO[state.targetChainId].name}`;
    btn.onclick = switchNetwork;
    banner.append(text, btn);
  } else {
    pill.className = "pill ok";
    banner.hidden = true;
  }
}

async function switchNetwork() {
  const id = state.targetChainId;
  const hexId = "0x" + id.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (err) {
    if (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902)) {
      const info = NETWORK_INFO[id];
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: info.name, rpcUrls: [info.rpc], nativeCurrency: { name: info.currency, symbol: info.currency, decimals: 18 } }],
      });
    } else {
      log(explainError(err), "err");
    }
  }
}

// ---------------------------------------------------------------------------
// Wallet connection
// ---------------------------------------------------------------------------
async function connect() {
  if (!window.ethereum) return updateBanner();
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await syncWallet();
    log("Wallet connected.", "ok");
  } catch (err) {
    log(explainError(err), "err");
  }
}

async function syncWallet() {
  state.provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await state.provider.send("eth_accounts", []);
  state.walletChainId = Number((await state.provider.getNetwork()).chainId);
  if (accounts.length) {
    state.account = ethers.getAddress(accounts[0]);
    state.signer = await state.provider.getSigner();
    $("connectBtn").textContent = state.account.slice(0, 6) + "…" + state.account.slice(-4);
  } else {
    state.account = null;
    state.signer = null;
    $("connectBtn").textContent = "Connect MetaMask";
  }
  updateBanner();
  await refresh();
}

// ---------------------------------------------------------------------------
// Reading chain data
// ---------------------------------------------------------------------------
function readyForReads() {
  return state.provider && state.account && state.walletChainId === state.targetChainId && selectedDeployment();
}

async function refresh() {
  const dep = selectedDeployment();
  if (!dep) return renderAll();
  if (!readyForReads()) {
    // Show the token list without balances so the UI is still readable before connecting.
    state.tokens = Object.entries(dep.tokens).map(([key, t]) => ({
      key, address: t.address, symbol: t.symbol, decimals: t.decimals,
      price: ethers.parseUnits(String(t.priceUsd), 18), ltvBps: t.ltvBps,
      wallet: null, deposited: null, collateral: null, debt: null, liquidity: null, maxBorrow: null,
    }));
    state.accountData = null;
    return renderAll();
  }
  try {
    const protocol = new ethers.Contract(dep.protocol, PROTOCOL_ABI, state.provider);
    const rows = await Promise.all(Object.entries(dep.tokens).map(async ([key, t]) => {
      const token = new ethers.Contract(t.address, TOKEN_ABI, state.provider);
      const [cfg, wallet, deposited, collateral, debt, liquidity, maxBorrow] = await Promise.all([
        protocol.assetConfig(t.address),
        token.balanceOf(state.account),
        protocol.depositOf(state.account, t.address),
        protocol.collateralOf(state.account, t.address),
        protocol.debtOf(state.account, t.address),
        protocol.availableLiquidity(t.address),
        protocol.maxBorrow(state.account, t.address),
      ]);
      return { key, address: t.address, symbol: t.symbol, decimals: t.decimals, price: cfg.price, ltvBps: Number(cfg.ltvBps), wallet, deposited, collateral, debt, liquidity, maxBorrow };
    }));
    state.tokens = rows;
    state.accountData = await protocol.getAccountData(state.account);
  } catch (err) {
    log("Could not read from the contract. Is the node running and the address correct? " + explainError(err), "err");
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderPosition();
  renderMarkets();
  renderAssetSelect();
  renderActionState();
}

function renderPosition() {
  const d = state.accountData;
  const gauge = $("gauge");
  const marker = $("gaugeMarker");
  const note = $("gaugeNote");
  if (!d || !readyForReads()) {
    for (const id of ["sCollateral", "sDebt", "sLimit", "sRatio"]) $(id).textContent = "–";
    gauge.classList.add("empty");
    marker.hidden = true;
    note.textContent = state.account ? "Switch to the right network to see your position." : "Connect your wallet to see how safe your loan is.";
    return;
  }
  $("sCollateral").textContent = usd(d.collateralValue);
  $("sDebt").textContent = usd(d.debtValue);
  $("sLimit").textContent = usd(d.borrowCapacity);
  const hasDebt = d.debtValue > 0n;
  $("sRatio").textContent = hasDebt ? (Number(d.collateralRatioBps) / 100).toFixed(1) + "%" : "No debt";

  if (!hasDebt || d.collateralValue === 0n) {
    gauge.classList.add("empty");
    marker.hidden = true;
    note.textContent = hasDebt ? "You owe tokens but have no collateral. Repay as soon as possible." : "You have no debt, so there is nothing to liquidate.";
    return;
  }
  gauge.classList.remove("empty");

  // Gauge axis runs from 100% to 300% collateral ratio.
  const toPct = (ratio) => Math.min(100, Math.max(0, ((ratio - 1) / 2) * 100));
  const liqRatio = d.liquidationCapacity === 0n ? 3 : Number((d.collateralValue * 10000n) / d.liquidationCapacity) / 10000; // below this: liquidation
  const limitRatio = d.borrowCapacity === 0n ? 3 : Number((d.collateralValue * 10000n) / d.borrowCapacity) / 10000; // below this: over borrow limit
  const current = Number(d.collateralRatioBps) / 10000;
  const a = toPct(liqRatio), b = toPct(limitRatio);
  $("zoneDanger").style.width = a + "%";
  $("zoneWarn").style.width = Math.max(0, b - a) + "%";
  $("zoneSafe").style.width = Math.max(0, 100 - b) + "%";
  marker.hidden = false;
  marker.style.left = toPct(current) + "%";

  if (current < liqRatio) note.textContent = "Your loan can be liquidated. Repay or add collateral now.";
  else if (current < limitRatio) note.textContent = "You are above your borrow limit. Repay or add collateral to stay safe.";
  else {
    // Liquidation starts when the ratio falls to liqRatio, so this is how far collateral value can still drop.
    const dropPct = Math.round(100 * (1 - liqRatio / current));
    note.textContent = `Safe. Your collateral can lose about ${dropPct}% of its value before liquidation.`;
  }
}

function renderMarkets() {
  const body = $("marketRows");
  body.innerHTML = "";
  if (!state.tokens.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">No tokens found for this network.</td></tr>';
    return;
  }
  for (const t of state.tokens) {
    const tr = document.createElement("tr");
    const cells = [
      t.symbol,
      usd(t.price),
      (t.ltvBps / 100).toFixed(0) + "%",
      t.wallet === null ? "–" : fmt(t.wallet, t.decimals),
      t.deposited === null ? "–" : fmt(t.deposited, t.decimals),
      t.collateral === null ? "–" : fmt(t.collateral, t.decimals),
      t.debt === null ? "–" : fmt(t.debt, t.decimals),
      t.liquidity === null ? "–" : fmt(t.liquidity, t.decimals),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    body.append(tr);
  }
}

function renderAssetSelect() {
  const sel = $("assetSelect");
  const row = $("mintRow");
  const key = state.tokens.map((t) => t.address).join(",");
  // Only rebuild when the token list changes, so an open dropdown is not closed by live refreshes.
  if (sel.dataset.key !== key) {
    sel.innerHTML = "";
    row.innerHTML = "";
    const amounts = { WETH: "10", USDC: "10000", DAI: "10000" };
    for (const t of state.tokens) {
      const opt = document.createElement("option");
      opt.value = t.address;
      opt.textContent = t.symbol;
      sel.append(opt);
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = `Mint ${Number(amounts[t.key] || 100).toLocaleString()} ${t.symbol}`;
      btn.onclick = () => mint(t, amounts[t.key] || "100");
      row.append(btn);
    }
    sel.dataset.key = key;
  }
  for (const btn of row.children) btn.disabled = !readyForReads() || state.busy;
}

function renderActionState() {
  $("actionHint").textContent = ACTIONS[state.action].hint;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.action === state.action));
  const btn = $("submitBtn");
  if (!window.ethereum) { btn.textContent = "Install MetaMask"; btn.disabled = true; }
  else if (!state.account) { btn.textContent = "Connect wallet first"; btn.disabled = true; }
  else if (state.walletChainId !== state.targetChainId) { btn.textContent = "Switch network first"; btn.disabled = true; }
  else { btn.textContent = state.busy ? "Waiting…" : ACTIONS[state.action].label; btn.disabled = state.busy; }
  $("maxBtn").disabled = !readyForReads();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function maxFor(t, action) {
  switch (action) {
    case "deposit": case "depositCollateral": return t.wallet;
    case "borrow": return t.maxBorrow;
    case "repay": return t.debt < t.wallet ? t.debt : t.wallet;
    case "withdraw": return t.deposited < t.liquidity ? t.deposited : t.liquidity;
    case "withdrawCollateral": return t.collateral;
  }
  return 0n;
}

function setMax() {
  const t = selectedToken();
  if (t) $("amountInput").value = ethers.formatUnits(maxFor(t, state.action) || 0n, t.decimals);
}

async function track(tx, label) {
  const info = NETWORK_INFO[state.targetChainId] || {};
  const link = info.explorer ? `${info.explorer}/tx/${tx.hash}` : null;
  const li = log(`${label}: waiting for confirmation…`, "pending", link);
  const receipt = await tx.wait();
  li.className = receipt.status === 1 ? "ok" : "err";
  li.firstChild.textContent = `${label}: ${receipt.status === 1 ? "confirmed" : "failed"}`;
  return receipt;
}

async function submit() {
  const t = selectedToken();
  if (!t || !readyForReads()) return;
  let amount;
  try {
    amount = ethers.parseUnits($("amountInput").value.trim(), t.decimals);
  } catch (_) {
    return log("Enter a valid number, for example 1.5", "err");
  }
  if (amount <= 0n) return log("Enter an amount greater than zero.", "err");

  state.busy = true;
  renderActionState();
  const dep = selectedDeployment();
  try {
    const protocol = new ethers.Contract(dep.protocol, PROTOCOL_ABI, state.signer);
    const token = new ethers.Contract(t.address, TOKEN_ABI, state.signer);
    const needsApproval = ["deposit", "depositCollateral", "repay"].includes(state.action);
    if (needsApproval) {
      // Repay only ever takes up to the debt, so approve no more than that.
      const needed = state.action === "repay" && amount > t.debt ? t.debt : amount;
      const allowance = await token.allowance(state.account, dep.protocol);
      if (allowance < needed) {
        log(`Approve ${t.symbol} in your wallet (step 1 of 2).`, "pending");
        await track(await token.approve(dep.protocol, needed), `Approve ${t.symbol}`);
      }
    }
    // staticCall first: surfaces a readable error before MetaMask shows a confusing "gas estimation failed".
    await protocol[state.action].staticCall(t.address, amount);
    const label = `${ACTIONS[state.action].label} ${$("amountInput").value.trim()} ${t.symbol}`;
    await track(await protocol[state.action](t.address, amount), label);
    $("amountInput").value = "";
  } catch (err) {
    log(explainError(err), "err");
  } finally {
    state.busy = false;
    await refresh();
  }
}

async function mint(t, amountText) {
  state.busy = true;
  renderAssetSelect();
  try {
    const token = new ethers.Contract(t.address, TOKEN_ABI, state.signer);
    await track(await token.mint(state.account, ethers.parseUnits(amountText, t.decimals)), `Mint ${t.symbol}`);
  } catch (err) {
    log(explainError(err), "err");
  } finally {
    state.busy = false;
    await refresh();
  }
}

// ---------------------------------------------------------------------------
// Live updates: check for a new block every few seconds and refresh when one arrives.
// ---------------------------------------------------------------------------
const POLL_MS = 3000;
async function poll() {
  const label = $("liveBlock");
  if (!readyForReads()) { label.textContent = "Live updates: waiting for wallet"; return; }
  if (state.busy || document.hidden) return; // do not refresh in the middle of a transaction
  try {
    const block = await state.provider.getBlockNumber();
    label.textContent = `Live · block ${block}`;
    if (block !== state.lastBlock) {
      state.lastBlock = block;
      await refresh();
    }
  } catch (_) {
    label.textContent = "Live updates paused: cannot reach the network";
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function init() {
  try {
    const res = await fetch("deployments.json", { cache: "no-store" });
    if (!res.ok) throw new Error("not found");
    state.deployments = await res.json();
  } catch (_) {
    state.deployments = {};
  }

  const sel = $("networkSelect");
  const ids = Object.keys(state.deployments).map(Number);
  if (ids.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No deployments";
    sel.append(opt);
    sel.disabled = true;
    state.targetChainId = 31337;
    $("banner").hidden = false;
    $("banner").classList.add("info");
    $("banner").textContent = "No deployments found. Deploy first with `npm run deploy:local` or `npm run deploy:sepolia`, then reload.";
  } else {
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = (NETWORK_INFO[id] || { name: "Chain " + id }).name;
      sel.append(opt);
    }
    state.targetChainId = ids.includes(11155111) ? 11155111 : ids[0];
    sel.value = state.targetChainId;
  }

  sel.onchange = async () => { state.targetChainId = Number(sel.value); updateBanner(); await refresh(); };
  $("connectBtn").onclick = connect;
  $("submitBtn").onclick = submit;
  $("maxBtn").onclick = setMax;
  $("assetSelect").onchange = () => { $("amountInput").value = ""; };
  for (const b of document.querySelectorAll("#tabs button")) {
    b.onclick = () => { state.action = b.dataset.action; $("amountInput").value = ""; renderActionState(); };
  }

  setInterval(poll, POLL_MS);
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", syncWallet);
    window.ethereum.on("chainChanged", () => window.location.reload());
    await syncWallet(); // picks up an already-authorised account without a popup
  } else {
    updateBanner();
    await refresh();
  }
}

init();
