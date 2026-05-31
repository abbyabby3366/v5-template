/**
 * launcher.js — Browser lifecycle supervisor and crash recovery
 *
 * This is the process entry point. It launches the browser, wires up the
 * event-driven game engine from runEyes.js, and automatically recovers
 * from crashes, tab closures, and session expiry.
 *
 * Session restart logic lives in sessionManager.js.
 */

const fs = require("fs");
const path = require("path");
const { launchAccount } = require("../utils/launch_any");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
const config = require("./config");
const { runEventBasedEyes } = require("./runEyes");
const { setupSessionRestart, updateLoginTimestamp } = require("./sessionManager");
const { startNetworkWatchdog } = require("../utils/network_watchdog");

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
        startNetworkWatchdog(newPage, console);
      });

      console.log("[Launcher] Initializing event-driven engine...");
      await runEventBasedEyes(pageRef, extractorCode, acctConfig);

      if (restartTimer) clearInterval(restartTimer);
      console.log("\x1b[31m[Launcher] Engine exited. Disconnecting browser...\x1b[0m");

      if (acctConfig && acctConfig.isPlannedRestart) {
        console.log(`[Launcher] Planned restart active. Rebuilding browser session...`);
      } else {
        const reason = pageRef.current?.closeReason || "Page closed or loop exited.";
        sendWhatsAppNotification(`[RECOVERY] Eyes module "${acctConfig.label}" relaunching. Reason: ${reason}`)
          .catch(err => console.error("Notification failed:", err.message));
      }

      if (browserContext) await browserContext.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 15000));

    } catch (err) {
      console.error("\x1b[31m[Supervisor] Recovery trigger:\x1b[0m", err.message);
      if (restartTimer) clearInterval(restartTimer);

      const label = acctConfig?.label || "PG Eyes";
      sendWhatsAppNotification(`[RECOVERY] Eyes module "${label}" failed and is relaunching. Reason: ${err.message}`)
        .catch(e => console.error("Notification failed:", e.message));

      if (browserContext) await browserContext.disconnect().catch(() => {});
      await new Promise(r => setTimeout(r, 30000));
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
};
