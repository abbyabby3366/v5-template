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
const fetchAccountBalance = require("./fetchBalance");

const PORT = parseInt(process.env.BET_PORT || "4001", 10);
const CENTRAL_URL = process.env.CENTRAL_URL || "http://127.0.0.1:3456";
const BASE_URL = process.env.BET_MODULE_BASE_URL || `http://127.0.0.1:${PORT}`;
const MODULE_ID = process.env.MODULE_ID || `bet-${os.hostname()}-${PORT}`;
const INITIAL_ACCOUNT_INDEX = parseInt(process.env.ACCOUNT_INDEX || "0", 10);

const rotator = new AccountRotator(INITIAL_ACCOUNT_INDEX);
const browserController = new BrowserController();
const telemetry = new TelemetryService({ moduleId: MODULE_ID, baseUrl: BASE_URL, centralUrl: CENTRAL_URL });
const queueProcessor = new BetQueueProcessor(telemetry);

let latestBalance = null;
let sessionRestartTimer = null;
let isIntentionalRestart = false;

// Helpers to read active config names
function getModuleLabel() {
  const acctConfig = rotator.getCurrentConfig();
  return `Node (${acctConfig.platform})`;
}

function getAccountLabel() {
  const acctConfig = rotator.getCurrentConfig();
  return acctConfig.label || `Account_${PORT}`;
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
  telemetry.sendHeartbeat(
    getModuleLabel(),
    getAccountLabel(),
    browserController.isReady(),
    latestBalance
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

function scheduleSessionRestart(acctConfig) {
  const minutes = acctConfig.sessionRestartMinutes;
  if (!minutes || minutes <= 0) return;
  
  if (sessionRestartTimer) clearInterval(sessionRestartTimer);
  
  console.log(`[Session Restart] Polling enabled. Will restart ${minutes} minutes after login for ${acctConfig.label}.`);
  const launchTime = Date.now();
  
  sessionRestartTimer = setInterval(async () => {
    let loginTime = launchTime;
    try {
      const tsFile = path.resolve(__dirname, "..", "utils", "login_timestamps.json");
      const timestamps = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
      if (timestamps[acctConfig.label]) loginTime = timestamps[acctConfig.label];
    } catch (e) {}
    
    const elapsedMin = (Date.now() - loginTime) / 60000;
    if (elapsedMin < minutes) return;
    
    clearInterval(sessionRestartTimer);
    sessionRestartTimer = null;
    
    console.log(`\x1b[33m[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Graceful restart...\x1b[0m`);
    
    // Step 1: Temporarily signal unready to pull from dashboard RR pool
    browserController.isBrowserReady = false;
    sendHeartbeat();
    
    // Step 2: Wait for active bets to resolve
    const maxWaitMs = 60000;
    const startWait = Date.now();
    while (queueProcessor.isProcessing() && (Date.now() - startWait < maxWaitMs)) {
      console.log(`[Session Restart] Waiting for active bet to complete...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // Step 3: Trigger restart
    console.log(`[Session Restart] Closing browser to trigger rotator...`);
    isIntentionalRestart = true;
    await browserController.close();
  }, 30000);
}

async function initBrowserLifecycle() {
  while (true) {
    try {
      const acctConfig = rotator.getCurrentConfig();
      console.log(`\n[Bet Module] Initializing session lifecycle for ${acctConfig.label} (Index: ${rotator.getCurrentIndex()})...`);
      
      const { page } = await browserController.launch(acctConfig);
      
      // Sync initial telemetry balance & scheduling
      await updateBalance();
      sendHeartbeat();
      scheduleSessionRestart(acctConfig);
      
      // Wait until page is closed by crash or restart signal
      while (!page.isClosed()) {
        await new Promise(r => setTimeout(r, 2000));
      }
      
      if (sessionRestartTimer) {
        clearInterval(sessionRestartTimer);
        sessionRestartTimer = null;
      }
      
      console.log(`\x1b[31m[Bet Module] Session cycle ended. Advancing account...\x1b[0m`);
      if (!isIntentionalRestart) {
        telemetry.notifyAlert(
          `[RECOVERY] Bet module "${acctConfig.label}" relaunching. Reason: Browser closed unexpectedly.`
        ).catch(() => {});
      }
      
      isIntentionalRestart = false;
      await browserController.close();
      rotator.advanceToNext();
    } catch (err) {
      console.error("\x1b[31m[Bet Module] Lifecycle error:\x1b[0m", err.message);
      if (!isIntentionalRestart) {
        const acctConfig = rotator.getCurrentConfig();
        telemetry.notifyAlert(
          `[RECOVERY] Bet module "${acctConfig.label}" failed and is relaunching. Reason: ${err.message}`
        ).catch(() => {});
      }
      isIntentionalRestart = false;
      if (sessionRestartTimer) {
        clearInterval(sessionRestartTimer);
        sessionRestartTimer = null;
      }
      await browserController.close();
      rotator.advanceToNext();
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

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
      isIntentionalRestart = true;
      await browserController.close();
    }
  });

  // Start the background browser monitoring loop
  initBrowserLifecycle();
});

async function handleShutdown(signal) {
  console.log(`\n[Bet Module] Received ${signal}. Shutting down...`);
  browserController.isBrowserReady = false;
  
  try {
    await telemetry.sendHeartbeat(getModuleLabel(), getAccountLabel(), false, latestBalance);
    console.log(`[Bet Module] Successfully notified Central Server of shutdown.`);
  } catch (e) {
    console.error(`[Bet Module] Failed to notify Central:`, e.message);
  }

  await browserController.close();
  console.log(`[Bet Module] Offline. Goodbye!`);
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
