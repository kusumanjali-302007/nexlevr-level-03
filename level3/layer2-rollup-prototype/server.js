/**
 * server.js - tiny web server for the dashboard (no extra dependencies).
 *
 * It holds one Rollup client in memory, exposes a small JSON API, and serves public/.
 * Run:  npm run frontend   then open http://localhost:3000
 */
require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider } = require("ethers");
const { Rollup } = require("./src/rollup");
const { loadDeployment, getContract, revertReason } = require("./src/verifier");

const PORT = Number(process.env.PORT || 3000);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  try {
    await provider.getBlockNumber();
  } catch {
    throw new Error(`Cannot reach a node at ${RPC_URL}. Start it with: npm run node`);
  }
  const deployment = loadDeployment();
  if ((await provider.getCode(deployment.address)) === "0x") {
    throw new Error("The saved contract address has no code (was the node restarted?). Run: npm run deploy");
  }
  const signer = await provider.getSigner(0);
  const contract = getContract(deployment.address, signer);
  const rollup = await new Rollup({ contract, maxBatchSize: 5 }).init();

  // All actions run one at a time, so manual clicks and auto mode never collide.
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  // Auto mode: every AUTO_INTERVAL_MS, batch and submit whatever is pending.
  const AUTO_INTERVAL_MS = 3000;
  const auto = { enabled: false, lastEvent: null };
  setInterval(() => {
    if (!auto.enabled) return;
    serialize(async () => {
      if (rollup.pending.length > 0) {
        const record = rollup.processBatch();
        await rollup.submitBatch(record.batch.batchNumber);
        auto.lastEvent = `Auto: batch #${record.batch.batchNumber} (${record.batch.txCount} txs) processed and submitted`;
      }
    }).catch((err) => {
      auto.lastEvent = `Auto error: ${revertReason(err)}`;
    });
  }, AUTO_INTERVAL_MS);

  // Route table: each handler returns JSON.
  const routes = {
    "GET /api/state": async () => ({ ...(await rollup.getView()), auto: { ...auto, intervalMs: AUTO_INTERVAL_MS } }),
    "POST /api/auto": async (body) => {
      auto.enabled = Boolean(body.enabled);
      auto.lastEvent = auto.enabled ? "Auto mode on" : "Auto mode off";
      return { ...auto };
    },
    "POST /api/sample": async (body) => ({ results: rollup.createSampleTransactions(clamp(body.count, 1, 10, 3)) }),
    "POST /api/transfer": async (body) => rollup.sendTokens(String(body.from), String(body.to), Number(body.amount)),
    "POST /api/invalid": async (body) => rollup.createInvalidSample(body.kind || "insufficient"),
    "POST /api/process": async () => {
      const record = rollup.processBatch();
      if (!record) throw new Error("No pending transactions to process");
      return { batchNumber: record.batch.batchNumber };
    },
    "POST /api/submit": async () => {
      const record = await rollup.submitNextBatch();
      if (!record) throw new Error("No validated batch is waiting to be submitted");
      return { batchNumber: record.batch.batchNumber, chain: record.chain };
    },
    "POST /api/verify": async (body) => rollup.verifyBatch(Number(body.batchNumber)),
    "POST /api/tamper": async (body) => rollup.tamperDemo(Number(body.batchNumber), Number(body.txIndex || 0)),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handler = routes[`${req.method} ${url.pathname}`];

    if (handler) {
      try {
        const body = req.method === "POST" ? await readJson(req) : {};
        sendJson(res, 200, req.method === "POST" ? await serialize(() => handler(body)) : await handler(body));
      } catch (err) {
        sendJson(res, 400, { error: revertReason(err) });
      }
      return;
    }

    // Static files (only from public/).
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, requested));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
    console.log(`Node: ${RPC_URL} | Contract: ${deployment.address}`);
  });
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e5) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
}

main().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
