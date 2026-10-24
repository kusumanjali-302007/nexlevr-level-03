/* Dashboard logic. All data comes from the local server (server.js), which talks to the chain.
   Text is always inserted with textContent (never innerHTML) so nothing can inject markup. */

const $ = (selector) => document.querySelector(selector);
const short = (hash) => (hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "");

/** Tiny helper to build DOM elements safely. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function say(text, isError = false) {
  const box = $("#message");
  box.textContent = text;
  box.className = "message " + (isError ? "err" : "ok");
}

function emptyRow(text) {
  return el("div", { class: "empty" }, text);
}

function renderTable(table, headers, rows, emptyText) {
  table.replaceChildren();
  if (!rows.length) {
    table.append(el("caption", { class: "empty", style: "text-align:left" }, emptyText));
    return;
  }
  table.append(el("thead", {}, el("tr", {}, headers.map((h) => el("th", {}, h)))));
  table.append(el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((c) => (c && c.nodeType ? c : el("td", {}, c)))))));
}

function renderChain(chain) {
  $("#chain").replaceChildren(
    el("div", {}, "Contract: ", el("b", { class: "mono" }, chain.contract)),
    el("div", {}, "Chain ID ", el("b", {}, chain.chainId), " · block ", el("b", {}, chain.blockNumber), " · batches on-chain ", el("b", {}, chain.batchCountOnChain)),
    el("div", {}, "Sequencer: ", el("span", { class: "mono" }, short(chain.sequencer)))
  );
}

function renderBalances(view) {
  const rows = Object.keys(view.balances).sort().map((name) => {
    const pendingDiff = (view.projectedBalances[name] ?? 0) - view.balances[name];
    return [name, el("td", { class: "num" }, view.balances[name]), el("td", { class: "num" }, view.nonces[name] || 0), pendingDiff ? (pendingDiff > 0 ? "+" : "") + pendingDiff + " pending" : "—"];
  });
  renderTable($("#balances"), ["Account", "Balance", "Nonce", "Pending change"], rows, "No accounts");
}

function renderPending(view) {
  $("#maxBatch").textContent = view.maxBatchSize;
  renderTable($("#pending"), ["#", "From", "To", "Amount", "Nonce"], view.pending.map((tx, i) => [i + 1, tx.from, tx.to, el("td", { class: "num" }, tx.amount), tx.nonce]), "No pending transactions. Click “Create sample transactions”.");
  const list = $("#rejected");
  list.replaceChildren();
  view.rejected.forEach((r) => list.append(el("li", {}, `${JSON.stringify(r.tx)} → ${r.errors.join("; ")}`)));
  if (!view.rejected.length) list.append(el("li", { class: "empty" }, "None"));
}

function statusBadge(batch) {
  const good = batch.status === "submitted";
  return el("span", { class: "badge " + (batch.status === "invalid" ? "bad" : good ? "good" : "") }, batch.status);
}

function renderBatches(view) {
  const box = $("#batches");
  box.replaceChildren();
  if (!view.batches.length) return box.append(emptyRow("No batches yet. Create transactions, then click “Process batch”."));

  [...view.batches].reverse().forEach((batch) => {
    const result = el("div", { class: "result", id: `result-${batch.batchNumber}`, hidden: "" });
    const v = batch.verification;
    if (v) showVerification(result, v);

    box.append(
      el("div", { class: "batch" },
        el("div", { class: "batch-head" },
          el("h3", {}, `Batch #${batch.batchNumber} · ${batch.txCount} transactions`),
          el("span", {}, statusBadge(batch), " ", el("span", { class: "badge " + (batch.validation.valid ? "good" : "bad") }, batch.validation.valid ? "validation: passed" : "validation: failed"))
        ),
        el("div", { class: "kv" },
          el("span", {}, "Commitment"), el("span", { class: "mono" }, batch.commitment),
          el("span", {}, "txRoot"), el("span", { class: "mono" }, batch.txRoot),
          el("span", {}, "prev state root"), el("span", { class: "mono" }, batch.prevStateRoot),
          el("span", {}, "new state root"), el("span", { class: "mono" }, batch.newStateRoot)
        ),
        el("table", {}, ...txTable(batch)),
        el("div", { class: "batch-actions" },
          el("button", { class: "small", onclick: () => run(() => verify(batch.batchNumber)) }, "Verify against chain"),
          el("button", { class: "small secondary", onclick: () => run(() => tamper(batch.batchNumber)) }, "Tamper demo")
        ),
        result
      )
    );
  });
}

function txTable(batch) {
  return [
    el("thead", {}, el("tr", {}, ["#", "From", "To", "Amount", "Nonce"].map((h) => el("th", {}, h)))),
    el("tbody", {}, batch.transactions.map((tx, i) => el("tr", {}, [i, tx.from, tx.to, tx.amount, tx.nonce].map((c) => el("td", {}, c))))),
  ];
}

function showVerification(box, v) {
  box.hidden = false;
  box.replaceChildren(
    el("div", {}, el("b", {}, v.verified ? "✔ Verified: " : "✘ Not verified: "), v.verified ? "the recomputed commitment matches the on-chain record." : "see details below."),
    el("div", {}, `On-chain: ${v.existsOnChain ? "recorded" : "not recorded yet"} · local validation: ${v.locallyValid ? "passed" : "failed"} · matches on-chain: ${v.matchesOnChain}`),
    ...v.localErrors.map((e) => el("div", { class: "empty" }, e))
  );
}

function renderHistory(view) {
  const rows = view.batches
    .filter((b) => b.chain)
    .map((b) => [`#${b.batchNumber}`, el("td", { class: "mono" }, b.commitment), b.txCount, b.chain.blockNumber, el("td", { class: "mono" }, short(b.chain.txHash)), b.chain.gasUsed]);
  renderTable($("#history"), ["Batch", "Commitment", "Txs", "Block", "Tx hash", "Gas"], rows, "Nothing submitted yet.");
}

async function refresh() {
  try {
    const view = await api("/api/state");
    renderChain(view.chain);
    renderBalances(view);
    renderPending(view);
    renderBatches(view);
    renderHistory(view);
    $("#autoToggle").checked = view.auto.enabled;
    if (view.auto.lastEvent && view.auto.enabled) say(view.auto.lastEvent, view.auto.lastEvent.startsWith("Auto error"));
    setLive(true);
  } catch (err) {
    setLive(false);
  }
}

function setLive(ok) {
  const badge = $("#live");
  badge.textContent = ok ? "● live" : "● disconnected";
  badge.className = "live" + (ok ? "" : " off");
}

// Real-time updates: poll the server every 2 seconds (skipped while a button action is running).
let busy = false;
setInterval(() => { if (!busy) refresh(); }, 2000);

$("#autoToggle").addEventListener("change", (e) => run(() => api("/api/auto", { enabled: e.target.checked }).then((r) => say(r.lastEvent))));

// ----------------------------------------------------------------- actions
async function verify(batchNumber) {
  const v = await api("/api/verify", { batchNumber });
  await refresh();
  const box = $(`#result-${batchNumber}`);
  showVerification(box, v);
  say(v.verified ? `Batch #${batchNumber} verified against the chain.` : `Batch #${batchNumber} could not be verified: ${v.existsOnChain ? "mismatch" : "not on-chain yet"}.`, !v.verified);
}

async function tamper(batchNumber) {
  const t = await api("/api/tamper", { batchNumber, txIndex: 0 });
  const box = $(`#result-${batchNumber}`);
  box.hidden = false;
  const fixed = t.withFixedHashes || {};
  box.replaceChildren(
    el("div", {}, el("b", {}, "Tamper demo "), `(copy only): changed tx #0 amount ${t.originalAmount} → ${t.tamperedAmount}`),
    el("div", {}, "Edit only: ", el("b", {}, t.naive.valid ? "NOT detected" : "detected"), " — ", t.naive.errors[0] || ""),
    fixed.error
      ? el("div", {}, fixed.error)
      : el("div", {}, "Edit + recomputed hashes → new commitment ", el("span", { class: "mono" }, short(fixed.newCommitment)), " vs original ", el("span", { class: "mono" }, short(t.originalCommitment)), ". Matches on-chain record? ", el("b", {}, String(fixed.matchesOnChain)))
  );
  say("Tamper demo finished. Nothing real was changed.");
}

const actions = {
  sample: async () => {
    const { results } = await api("/api/sample", { count: 3 });
    say(`Created ${results.filter((r) => r.accepted).length} valid transactions.`);
  },
  invalid: async () => {
    const kinds = ["insufficient", "nonce", "self", "amount"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const r = await api("/api/invalid", { kind });
    say(r.accepted ? "Unexpected: invalid transaction accepted" : `Rejected as expected: ${r.errors.join("; ")}`, r.accepted);
  },
  process: async () => {
    const r = await api("/api/process", {});
    say(`Batch #${r.batchNumber} executed off-chain and validated.`);
  },
  submit: async () => {
    const r = await api("/api/submit", {});
    say(`Batch #${r.batchNumber} commitment recorded in block ${r.chain.blockNumber}.`);
  },
  verifyAll: async () => {
    const view = await api("/api/state");
    const submitted = view.batches.filter((b) => b.status === "submitted");
    if (!submitted.length) throw new Error("No submitted batches to verify yet");
    let ok = 0;
    for (const b of submitted) if ((await api("/api/verify", { batchNumber: b.batchNumber })).verified) ok++;
    say(`${ok} of ${submitted.length} submitted batches verified against the chain.`, ok !== submitted.length);
  },
};

async function run(fn) {
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (err) {
    say(err.message, true);
  } finally {
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    busy = false;
    await refresh();
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => run(actions[button.dataset.action]));
});

refresh();
