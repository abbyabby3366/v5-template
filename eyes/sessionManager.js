/**
 * sessionManager.js — Session restart timer and login timestamp persistence
 *
 * Handles seamless page swaps (Hippo/DirectURL) and legacy Winbox restarts.
 * Extracted from launcher.js to keep the supervisor loop minimal.
 */

const fs = require("fs");
const path = require("path");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
const { loginToDemo } = require("./demoLogin");

const TS_FILE = path.resolve(__dirname, "..", "utils", "login_timestamps.json");

// ─── Login Timestamps ───────────────────────────────────────────────────

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
    console.error("[Session] Failed to update login timestamp:", e.message);
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

// ─── Session Restart ─────────────────────────────────────────────────────

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
    acctConfig.isPlannedRestart = true;
    console.log(`\x1b[33m[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Initiating restart sequence...\x1b[0m`);
    sendWhatsAppNotification(`[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Initiating restart sequence...`)
      .catch(err => console.error("WhatsApp notification failed:", err.message));

    const isHippoOrDirect = ["hippo", "directurl", "direct_url"].includes(acctConfig.platform);

    if (isHippoOrDirect && browserContext) {
      console.log(`[Session Restart] Performing SEAMLESS restart for Hippo... Preparing new page in background.`);
      try {
        const newPage = await loginToDemo(browserContext, acctConfig.proxy);
        console.log(`[Session Restart] New page fully loaded and prepared. Swapping seamlessly!`);
        
        const oldPage = pageRef.current;
        
        if (typeof onBeforeSwap === "function") {
          await onBeforeSwap(newPage);
        }
        
        pageRef.current = newPage;
        
        // Wait 1.5 seconds before closing oldPage so the swap is extremely smooth
        await new Promise(r => setTimeout(r, 1500));
        
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
    acctConfig.isPlannedRestart = true;
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

module.exports = {
  setupSessionRestart,
  updateLoginTimestamp,
};
