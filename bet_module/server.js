const http = require("http");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { launchAccount, buildAccountConfig } = require("../utils/launch_winbox");
const { ensureMultiplayActive } = require("../utils/ensureMultiplayActive");
const { executeBetInBrowser } = require("./executeBet");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");

const os = require("os");

const PORT = parseInt(process.env.BET_PORT || "4001", 10);
const CENTRAL_URL = process.env.CENTRAL_URL || "http://127.0.0.1:3456";
const BASE_URL = process.env.BET_MODULE_BASE_URL || `http://127.0.0.1:${PORT}`;
// MODULE_ID must be globally unique across machines. Derive from BASE_URL so
// two computers both using port 4001 don't collide in the dashboard's Map.
const MODULE_ID = process.env.MODULE_ID || `bet-${os.hostname()}-${PORT}`;
const ACCOUNT_INDEX = parseInt(process.env.ACCOUNT_INDEX || "0", 10);

const betQueue = [];
let isBrowserReady = false;
let browserPage = null;
let browserInstance = null;
let multiplayInterval = null;
let latestBalance = null;
let isBetInProgress = false;
let sessionRestartTimer = null;
let isIntentionalRestart = false;
let consecutiveBetErrors = 0;

const initialAccountsPath = path.resolve(__dirname, "json", "bet_accounts.json");
const initialAcctConfig = buildAccountConfig(ACCOUNT_INDEX, initialAccountsPath);
let currentModuleLabel = `Node (${initialAcctConfig.platform})`;
let currentAccountLabel = initialAcctConfig.label || `Account_${PORT}`;

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendHeartbeat() {
  const payload = {
    moduleId: MODULE_ID,
    baseUrl: BASE_URL,
    label: currentModuleLabel,
    accounts: [{ label: currentAccountLabel, isAcceptingBets: isBrowserReady, balance: latestBalance }]
  };

  fetch(`${CENTRAL_URL}/api/bet-module/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {
    // silently fail if central is offline
  });
}

async function updateBalance() {
  if (isBrowserReady && browserPage) {
    try {
      const evaluatePromise = browserPage.evaluate(async () => {
        const API_BASE = "https://member-api.aghippo168.com";

        // Try getting balance from Pinia first (in-memory)
        try {
          let pinia = window.$nuxt?.$pinia || window.$pinia;
          if (!pinia) {
            const el = document.querySelector('#__nuxt') || document.querySelector('#app') || document.body;
            pinia = el?.__vue_app__?.$pinia || el?.__vue_app__?.config?.globalProperties?.$pinia;
          }
          if (pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
            const piniaBal = pinia.state.value.global.profile?.balance;
            if (piniaBal !== undefined && piniaBal !== null) {
              return String(piniaBal);
            }
          }
        } catch (e) {}

        // Fallback: direct REST call
        try {
          function getAuthToken() {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const val = localStorage.getItem(key);
              if (key.toLowerCase().includes('token') && val) {
                return val.replace(/^Bearer\s+/i, '');
              }
              if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
                return val;
              }
            }
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              const val = sessionStorage.getItem(key);
              if (key.toLowerCase().includes('token') && val) {
                return val.replace(/^Bearer\s+/i, '');
              }
              if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
                return val;
              }
            }
            const cookieMatch = document.cookie.match(/token=([^;]+)/i);
            if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
            return null;
          }

          const token = getAuthToken();
          if (token) {
            const headers = {
              "Content-Type": "application/json",
              "authorization": token
            };

            const profile = await fetch(`${API_BASE}/apiRoute/member/profile`, {
              method: "POST",
              headers: headers,
              body: JSON.stringify({ lang: "en" })
            }).then(r => r.json());

            if (profile && profile._id) {
              const balanceInfo = await fetch(`${API_BASE}/apiRoute/member/viewBalance/${profile._id}`, {
                method: "GET",
                headers: headers
              }).then(r => r.json());

              if (balanceInfo && typeof balanceInfo.balance !== 'undefined') {
                return String(balanceInfo.balance);
              }
            }
          }
        } catch (e) {}

        return null;
      });

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
      const balance = await Promise.race([evaluatePromise, timeoutPromise]);
      if (balance) {
        latestBalance = balance;
      }
    } catch (e) {}
  }
}

async function runBetPG() {
  while (true) {
    if (betQueue.length > 0) {
      const bet = betQueue.shift();
      console.log(`\n[${currentAccountLabel}] 📥 Received Bet: ${bet.uuid || bet.id} for ${bet.tableName} (${bet.target || bet.betType})`);
      
      let success = false;
      let reason = "Unknown error";
      
      isBetInProgress = true;
      
      if (!isBrowserReady || !browserPage) {
        reason = "Browser not ready for bet";
        console.error(`[Bet Module] ${reason}.`);
      } else {
        // Calculate clicks sequence
        const targetAmount = bet.recommendedBetAmount || bet.amount || bet.chipIndex || 0;
        const betConfig = {
          tableName: bet.tableName,
          betType: bet.target || bet.betType,
          targetAmount: targetAmount,
          betPlacementDelayMs: parseInt(process.env.BET_PLACEMENT_DELAY_MS || "150", 10),
          chipSettleDelayMs: parseInt(process.env.CHIP_SETTLE_DELAY_MS || "500", 10),
          chipSelector: ".chip",
        };

        const result = await executeBetInBrowser(browserPage, betConfig);
        success = result.success;
        reason = result.reason;
        if (result.betAmount) {
          bet.actualBetAmount = result.betAmount;
        }
        if (result.balance !== undefined && result.balance !== null) {
          latestBalance = result.balance;
        }
        bet.timer = result.timer != null ? result.timer : null;
      }
      
      isBetInProgress = false;
      
      const status = success ? "SUCCESS" : "FAILED";
      
      if (!success) {
        consecutiveBetErrors++;
        if (consecutiveBetErrors >= 3) {
          sendWhatsAppNotification(
            `[ALERT] Bet module "${currentAccountLabel}" encountered 3 consecutive bet errors. Last reason: ${reason || "None"}`
          ).catch(err => console.error("WhatsApp notification failed:", err.message));
          
          console.log(`[ALERT] 3 consecutive errors. Closing tab to force restart.`);
          isIntentionalRestart = true;
          if (browserPage && !browserPage.isClosed()) {
            browserPage.close().catch(() => {});
          }

          consecutiveBetErrors = 0;
        }
      } else {
        consecutiveBetErrors = 0;
      }

      const amountText = success && bet.actualBetAmount ? ` [Amount: ${bet.actualBetAmount}]` : "";
      const reasonText = success ? "" : ` (Reason: ${reason || "None given"})`;
      const timerText = bet.timer != null ? ` [Timer: ${bet.timer}s]` : "";
      console.log(`[${currentAccountLabel}] ${success ? '✅' : '❌'} Result: ${status}${amountText}${reasonText}${timerText}`);

      // Report result to central server
      fetch(`${CENTRAL_URL}/api/telemetry/bet-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betId: bet.uuid || bet.id,
          status: status,
          reason: reason,
          betAmount: bet.actualBetAmount,
          tableNumber: bet.tableName,
          betType: bet.target || bet.betType,
          timer: bet.timer
        })
      }).catch(err => {
        console.error(`[${currentAccountLabel}] Failed to report result to central:`, err.message);
      });
    } else {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/prettygaming/bet") {
    try {
      const payload = await parseJSONBody(req);
      if (!isBrowserReady) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "Browser not ready" }));
      }
      
      betQueue.push(payload);
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

/**
 * Schedules a session restart after the configured number of minutes.
 * Instead of killing Chrome, we close all game/winbox tabs while keeping
 * a blank tab alive. This makes page.isClosed() return true so the
 * initBrowser loop picks up and re-runs launchAccount, which reconnects
 * to the still-running Chrome and re-navigates through login.
 */
function scheduleSessionRestart(acctConfig) {
  const minutes = acctConfig.sessionRestartMinutes;
  if (!minutes || minutes <= 0) return;
  
  // Clear any existing timer
  if (sessionRestartTimer) clearInterval(sessionRestartTimer);
  
  console.log(`[Session Restart] Polling enabled. Will restart ${minutes} minutes after login for ${acctConfig.label}.`);
  const launchTime = Date.now();
  
  sessionRestartTimer = setInterval(async () => {
    let loginTime = launchTime;
    try {
      const timestampsStr = require('fs').readFileSync(require('path').resolve(__dirname, "..", "utils", "login_timestamps.json"), 'utf8');
      const timestamps = JSON.parse(timestampsStr);
      if (timestamps[acctConfig.label]) loginTime = timestamps[acctConfig.label];
    } catch (e) {}
    
    const elapsedMin = (Date.now() - loginTime) / 60000;
    if (elapsedMin < minutes) return;
    
    clearInterval(sessionRestartTimer);
    sessionRestartTimer = null;
    
    console.log(`\x1b[33m[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Initiating graceful restart...\x1b[0m`);
    
    // Step 1: Stop accepting new bets immediately
    isBrowserReady = false;
    sendHeartbeat(); // Immediately notify central that isAcceptingBets is now false
    
    // Step 2: Wait for any in-progress bet to complete
    const maxWaitMs = 60000; // Max 60s to wait for a bet to finish
    const startWait = Date.now();
    while (isBetInProgress && (Date.now() - startWait < maxWaitMs)) {
      console.log(`[Session Restart] Waiting for current bet to finish...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    if (isBetInProgress) {
      console.log(`\x1b[31m[Session Restart] Bet still in progress after ${maxWaitMs / 1000}s, forcing restart anyway.\x1b[0m`);
    }
    
    // Step 3: Close Winbox and Game pages, but leave the default about:blank to keep Chrome alive
    console.log(`[Session Restart] Closing Winbox and Game pages to force a fresh login...`);
    isIntentionalRestart = true;
    try {
      if (browserInstance) {
        const allPages = await browserInstance.pages();
        for (const p of allPages) {
          const url = p.url() || "";
          if (url !== "about:blank" && !url.startsWith("chrome://")) {
            await p.close().catch(() => {});
          }
        }
        console.log(`[Session Restart] Winbox and Game pages closed. Default page kept alive.`);
        
        // Update login timestamp to prevent immediate re-triggering in subsequent loops
        try {
          const fs = require('fs');
          const path = require('path');
          const tsFile = path.resolve(__dirname, "..", "utils", "login_timestamps.json");
          const timestampsStr = fs.readFileSync(tsFile, 'utf8');
          const timestamps = JSON.parse(timestampsStr);
          timestamps[acctConfig.label] = Date.now();
          fs.writeFileSync(tsFile, JSON.stringify(timestamps, null, 2));
        } catch (e) {
          console.error("[Session Restart] Failed to update login timestamp:", e.message);
        }
      }
    } catch (e) {
      console.error(`[Session Restart] Error closing pages:`, e.message);
    }
    
    // The initBrowser loop will detect page.isClosed() and relaunch via launchAccount
  }, 30000); // Poll every 30 seconds
}

async function initBrowser() {
  const accountsPath = path.resolve(__dirname, "json", "bet_accounts.json");
  
  // Reset the login timestamp for this account when the process first launches
  try {
    const acctConfig = buildAccountConfig(ACCOUNT_INDEX, accountsPath);
    const fs = require('fs');
    const tsFile = path.resolve(__dirname, "..", "utils", "login_timestamps.json");
    let timestamps = {};
    if (fs.existsSync(tsFile)) timestamps = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
    timestamps[acctConfig.label] = Date.now();
    fs.writeFileSync(tsFile, JSON.stringify(timestamps, null, 2));
  } catch (e) {}
  
  while (true) {
    let browserContext = null;
    try {
      const acctConfig = buildAccountConfig(ACCOUNT_INDEX, accountsPath); 
      currentModuleLabel = `Node (${acctConfig.platform})`;
      currentAccountLabel = acctConfig.label || `Account_${PORT}`;
      console.log(`\n[Bet Module] Starting browser launch sequence for ${currentAccountLabel} (Account Index: ${ACCOUNT_INDEX})...`);
      
      const { browser, page } = await launchAccount(acctConfig);
      browserContext = browser;
      browserInstance = browser;
      browserPage = page;
      isBrowserReady = true;

      // Inject the client-side state interceptor to intercept WebSocket messages for in-memory timers
      try {
        const interceptorPath = path.resolve(__dirname, "..", "eyes", "interceptor.js");
        const fs = require('fs');
        const interceptorCode = fs.readFileSync(interceptorPath, "utf8");
        await page.evaluate(interceptorCode).catch(() => {});
        await page.evaluateOnNewDocument(interceptorCode).catch(() => {});
        console.log(`[Bet Module] Injected WebSocket state interceptors successfully.`);
      } catch (e) {
        console.error(`[Bet Module] Failed to load/inject WebSocket interceptors:`, e.message);
      }

      console.log(`\x1b[32m[Bet Module] Winbox Launch Successful! Module is ready to accept bets.\x1b[0m`);
      
      // Get initial balance immediately and send update
      await updateBalance();
      sendHeartbeat();
      
      console.log(`[Bet Module] Starting periodic check to ensure Multiplay is active...`);
      multiplayInterval = setInterval(() => {
        if (isBrowserReady && browserPage) {
          ensureMultiplayActive(browserPage).catch(() => {});
        }
      }, 5000);
      
      // Schedule session restart if configured
      scheduleSessionRestart(acctConfig);
      
      // Wait until browser closes
      while (!page.isClosed()) {
         await new Promise(r => setTimeout(r, 2000));
      }
      
      if (multiplayInterval) {
        clearInterval(multiplayInterval);
        multiplayInterval = null;
      }
      if (sessionRestartTimer) {
        clearInterval(sessionRestartTimer);
        sessionRestartTimer = null;
      }
      
      console.log(`\x1b[31m[Bet Module] Browser closed or crashed. Relaunching...\x1b[0m`);
      if (!isIntentionalRestart) {
        sendWhatsAppNotification(
          `[RECOVERY] Bet module "${currentAccountLabel}" relaunching. Reason: Browser tab was closed unexpectedly.`
        ).catch(err => console.error("WhatsApp notification failed:", err.message));
      }
      isIntentionalRestart = false;

      isBrowserReady = false;
      browserPage = null;
      browserInstance = null;
      // Disconnect puppeteer from the browser (Chrome stays alive if session restart)
      if (browserContext) await browserContext.disconnect().catch(() => {});
    } catch (err) {
      console.error("\x1b[31m[Bet Module] Launch error:\x1b[0m", err.message);
      if (!isIntentionalRestart) {
        sendWhatsAppNotification(
          `[RECOVERY] Bet module "${currentAccountLabel}" failed and is relaunching. Reason: ${err.message}`
        ).catch(e => console.error("WhatsApp notification failed:", e.message));
      }
      isIntentionalRestart = false;

      isBrowserReady = false;
      browserPage = null;
      browserInstance = null;
      if (multiplayInterval) {
        clearInterval(multiplayInterval);
        multiplayInterval = null;
      }
      if (sessionRestartTimer) {
        clearInterval(sessionRestartTimer);
        sessionRestartTimer = null;
      }
      if (browserContext) await browserContext.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\x1b[31m[Bet Module] FATAL: Port ${PORT} is already in use. Set a unique BET_PORT env var for each module instance.\x1b[0m`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[Bet Module] 🟢 Online on ${BASE_URL} | Account Index: ${ACCOUNT_INDEX} | Targeting Central: ${CENTRAL_URL}`);
  setInterval(sendHeartbeat, 5000);
  setInterval(updateBalance, 5000); // Check balance periodically
  sendHeartbeat(); // initial heartbeat
  runBetPG(); // start processing loop
  initBrowser(); // start browser lifecycle loop
});

// --- GRACEFUL SHUTDOWN ---
// Catch Ctrl+C (SIGINT) and termination signals (SIGTERM)
async function handleShutdown(signal) {
  console.log(`\n[Bet Module] Received ${signal}. Initiating graceful shutdown...`);
  
  // 1. Instantly stop accepting bets locally
  isBrowserReady = false; 

  // 2. Send a final synchronous-like heartbeat to Central Server
  try {
    const payload = {
      moduleId: MODULE_ID,
      baseUrl: BASE_URL,
      label: currentModuleLabel,
      // Setting isAcceptingBets to false instantly pulls it out of the Round-Robin pool
      accounts: [{ label: currentAccountLabel, isAcceptingBets: false, balance: latestBalance }]
    };

    await fetch(`${CENTRAL_URL}/api/bet-module/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(`[Bet Module] Successfully notified Central Server of shutdown.`);
  } catch (e) {
    console.error(`[Bet Module] Failed to notify Central Server:`, e.message);
  }

  // 3. Cleanly close the browser if it's open
  if (browserInstance) {
    console.log(`[Bet Module] Closing browser...`);
    await browserInstance.close().catch(() => {});
  }

  // 4. Exit the process
  console.log(`[Bet Module] Offline. Goodbye!`);
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

