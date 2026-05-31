const http = require("http");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const AccountRotator = require("./src/accountRotator");
const BrowserController = require("./src/browserController");
const TelemetryService = require("./src/telemetryService");
const BetQueueProcessor = require("./src/betQueueProcessor");
const SessionManager = require("./src/sessionManager");
const fetchAccountBalance = require("./fetchBalance");

const PORT = parseInt(process.env.BET_PORT || "4001", 10);
const CENTRAL_URL = process.env.CENTRAL_URL || "http://127.0.0.1:3456";
const BASE_URL = process.env.BET_MODULE_BASE_URL || `http://127.0.0.1:${PORT}`;
const INITIAL_ACCOUNT_INDEX = parseInt(process.env.ACCOUNT_INDEX || "0", 10);

const rotator = new AccountRotator(INITIAL_ACCOUNT_INDEX);
const browserController = new BrowserController();
const telemetry = new TelemetryService({ baseUrl: BASE_URL, centralUrl: CENTRAL_URL });
const queueProcessor = new BetQueueProcessor(telemetry);

let latestBalance = null;

const sessionManager = new SessionManager({
  rotator,
  browserController,
  telemetry,
  queueProcessor,
  updateBalanceFn: updateBalance,
  sendHeartbeatFn: sendHeartbeat
});

// Helper to read active account name
function getAccountLabel() {
  return sessionManager.getAccountLabel();
}

async function updateBalance() {
  if (browserController.isReady()) {
    try {
      const balance = await fetchAccountBalance(browserController.getPage());
      if (balance !== null) {
        latestBalance = String(balance);
      }
    } catch (e) {}
  }
}

function sendHeartbeat() {
  const currentConfig = rotator.getCurrentConfig() || {};
  telemetry.sendHeartbeat(
    getAccountLabel(),
    browserController.isReady(),
    latestBalance,
    browserController.currentIp,
    currentConfig.betType || "variable",
    currentConfig.allowedFixedAmounts || [5000, 10000, 15000, 20000]
  );
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/prettygaming/bet") {
    try {
      const payload = await parseJSONBody(req);
      if (!browserController.isReady()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "Browser not ready" }));
      }
      
      queueProcessor.queueBet(payload);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "queued", betId: payload.id || payload.uuid }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\x1b[31m[Bet Module] FATAL: Port ${PORT} is already in use. Set unique BET_PORT.\x1b[0m`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[Bet Module] 🟢 Online on ${BASE_URL} | Account: ${rotator.getCurrentIndex()} | Central: ${CENTRAL_URL}`);
  setInterval(sendHeartbeat, 5000);
  setInterval(updateBalance, 5000);
  sendHeartbeat();
  
  // Start the background FIFO bet execution loop
  queueProcessor.startProcessingLoop({
    isBrowserReadyFn: () => browserController.isReady(),
    getPageFn: () => browserController.getPage(),
    getAccountLabelFn: () => getAccountLabel(),
    onBalanceUpdatedFn: (bal) => { latestBalance = bal; },
    onForceTabRestartFn: async () => {
      await sessionManager.triggerRestart();
    }
  });

  // Start the background browser monitoring loop
  sessionManager.initBrowserLifecycle();
});

async function handleShutdown(signal) {
  console.log(`\n[Bet Module] Received ${signal}. Shutting down...`);
  browserController.isBrowserReady = false;
  
  try {
    await telemetry.deregister(getAccountLabel());
    console.log(`[Bet Module] Successfully deregistered from Central Server.`);
  } catch (e) {
    console.error(`[Bet Module] Failed to deregister from Central:`, e.message);
  }

  await browserController.close();
  console.log(`[Bet Module] Offline. Goodbye!`);
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
