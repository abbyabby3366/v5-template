/**
 * launcher.js — Browser lifecycle supervisor, crash recovery, and seamless restarts
 *
 * This is the process entry point. It launches the browser, wires up the
 * event-driven game engine from runEyes.js, and automatically recovers
 * from crashes, tab closures, and session expiry.
 */

const fs = require("fs");
const path = require("path");
const { launchAccount } = require("../utils/launch_winbox");
const { checkPageErrors } = require("../utils/check_page_interval");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
const config = require("./config");
const { runEventBasedEyes } = require("./runEyes");

const TS_FILE = path.resolve(__dirname, "..", "utils", "login_timestamps.json");

/**
 * Updates the login timestamp for an account
 * @param {string} label
 */
function updateLoginTimestamp(label) {
  try {
    let timestamps = {};
    if (fs.existsSync(TS_FILE)) {
      timestamps = JSON.parse(fs.readFileSync(TS_FILE, "utf8"));
    }
    timestamps[label] = Date.now();
    fs.writeFileSync(TS_FILE, JSON.stringify(timestamps, null, 2));
  } catch (e) {
    console.error("[Launcher] Failed to update login timestamp:", e.message);
  }
}

/**
 * Gets the current login timestamp for an account
 * @param {string} label
 * @param {number} fallback
 */
function getLoginTimestamp(label, fallback) {
  try {
    if (fs.existsSync(TS_FILE)) {
      const timestamps = JSON.parse(fs.readFileSync(TS_FILE, "utf8"));
      if (timestamps[label]) return timestamps[label];
    }
  } catch (e) {}
  return fallback;
}

/**
 * Standard browser launcher for the eyes module.
 * @param {object} acctConfig
 * @returns {Promise<{browser: object, page: object}>}
 */
async function launchBrowserSession(acctConfig) {
  console.log(`[Launcher] Launching account "${acctConfig.label}"...`);
  updateLoginTimestamp(acctConfig.label);

  const { browser, page } = await launchAccount(acctConfig);
  console.log("[Launcher] Page loaded successfully.");
  return { browser, page };
}

/**
 * Sets up session restart checking.
 * Handles seamless background swaps for Hippo/DirectURL, or closes pages for Winbox.
 * @param {object} browserContext
 * @param {object} pageRef - Reference container containing { current: Page }
 * @param {object} acctConfig
 * @param {function} onBeforeSwap - Callback invoked before page swap
 */
function setupSessionRestart(browserContext, pageRef, acctConfig, onBeforeSwap) {
  const restartMinutes = acctConfig.sessionRestartMinutes;
  if (!restartMinutes || restartMinutes <= 0) return null;

  console.log(`[Session Restart] Polling enabled. Will restart ${restartMinutes} minutes after login for ${acctConfig.label}.`);
  const launchTime = Date.now();
  let isRestarting = false;

  const timer = setInterval(async () => {
    if (isRestarting) return;

    const loginTime = getLoginTimestamp(acctConfig.label, launchTime);
    const elapsedMin = (Date.now() - loginTime) / 60000;
    if (elapsedMin < restartMinutes) return;

    isRestarting = true;
    console.log(`\x1b[33m[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Initiating restart sequence...\x1b[0m`);
    sendWhatsAppNotification(`[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Initiating restart sequence...`)
      .catch(err => console.error("WhatsApp notification failed:", err.message));

    const isHippoOrDirect = ["hippo", "directurl", "direct_url"].includes(acctConfig.platform);

    if (isHippoOrDirect && browserContext) {
      console.log(`[Session Restart] Performing SEAMLESS restart for Hippo... Preparing new page in background.`);
      try {
        const newPage = await browserContext.newPage();
        await newPage.goto("https://d3jai9eacl1740.cloudfront.net/lobby/multiplay", { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
        
        await checkPageErrors(newPage, { log: console.log, warn: console.warn, error: console.error });
        console.log(`[Session Restart] New page fully loaded and prepared. Swapping seamlessly!`);
        
        const oldPage = pageRef.current;
        
        if (typeof onBeforeSwap === "function") {
          await onBeforeSwap(newPage);
        }
        
        pageRef.current = newPage;
        
        if (oldPage && !oldPage.isClosed()) {
          await oldPage.close().catch(() => {});
        }
        
        updateLoginTimestamp(acctConfig.label);
      } catch (err) {
        console.error("[Session Restart] Seamless restart failed:", err.message);
      } finally {
        isRestarting = false;
      }
      return;
    }

    // Legacy Winbox behavior
    clearInterval(timer);
    console.log(`[Session Restart] Closing Winbox and Game pages to force a fresh login...`);
    try {
      if (browserContext) {
        const allPages = await browserContext.pages();
        for (const p of allPages) {
          const url = p.url() || "";
          if (url !== "about:blank" && !url.startsWith("chrome://")) {
            await p.close().catch(() => {});
          }
        }
        console.log(`[Session Restart] Winbox and Game pages closed. Default page kept alive.`);
        updateLoginTimestamp(acctConfig.label);
      }
    } catch (e) {
      console.error(`[Session Restart] Error closing pages:`, e.message);
    } finally {
      isRestarting = false;
    }
  }, 30000); // Check every 30 seconds

  return timer;
}

// ─── Process Supervisor ──────────────────────────────────────────────────

async function start() {
  const extractorPath = path.join(__dirname, "interceptor.js");
  const extractorCode = fs.readFileSync(extractorPath, "utf8");

  while (true) {
    let browserContext = null;
    let restartTimer = null;
    const pageRef = { current: null };
    let acctConfig = null;

    try {
      acctConfig = config.getAccountConfig(0);
      const { browser, page } = await launchBrowserSession(acctConfig);
      browserContext = browser;
      pageRef.current = page;

      // Set up the Hippo session restart timer
      restartTimer = setupSessionRestart(browser, pageRef, acctConfig, async (newPage) => {
        await newPage.evaluate(extractorCode).catch(() => {});
        await newPage.evaluateOnNewDocument(extractorCode).catch(() => {});
      });

      console.log("[Launcher] Initializing event-driven engine...");
      await runEventBasedEyes(pageRef, extractorCode, acctConfig);

      if (restartTimer) clearInterval(restartTimer);
      console.log("\x1b[31m[Launcher] Engine exited. Disconnecting browser...\x1b[0m");

      sendWhatsAppNotification(`[RECOVERY] Eyes module "${acctConfig.label}" relaunching. Reason: Page closed or loop exited.`)
        .catch(err => console.error("Notification failed:", err.message));

      if (browserContext) await browserContext.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      console.error("\x1b[31m[Supervisor] Recovery trigger:\x1b[0m", err.message);
      if (restartTimer) clearInterval(restartTimer);

      const label = acctConfig?.label || "PG Eyes";
      sendWhatsAppNotification(`[RECOVERY] Eyes module "${label}" failed and is relaunching. Reason: ${err.message}`)
        .catch(e => console.error("Notification failed:", e.message));

      if (browserContext) await browserContext.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Automatically start if executed directly
if (require.main === module) {
  start();
}

module.exports = {
  start,
  launchBrowserSession,
  setupSessionRestart,
  updateLoginTimestamp
};
