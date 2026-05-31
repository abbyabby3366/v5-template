/**
 * demoLogin.js - Reusable utility to handle logging into Demo / restoring active lobby session.
 */

const { checkPageErrors } = require("../utils/launch_winbox");
const { verifyProxyIp } = require("../utils/proxy_verifier");

/**
 * Opens a new browser page, navigates to the Demo multiplay lobby, and checks for errors.
 * This effectively logs in/restores the session since cookies are persisted in the profile.
 * @param {object} browserContext
 * @param {object} [proxy]
 * @returns {Promise<object>} The fully loaded and validated Demo page instance
 */
async function loginToDemo(browserContext, proxy = null) {
  if (!browserContext) throw new Error("browserContext is required to login to Demo");
  const newPage = await browserContext.newPage();

  if (proxy && proxy.server && proxy.username && proxy.password) {
    console.log("[Demo Login] Applying proxy authentication to new demo session page...");
    await newPage.authenticate({
      username: proxy.username,
      password: proxy.password
    }).catch((e) => console.warn(`[Demo Login] Proxy authentication failed: ${e.message}`));
  }

  // --- VERIFY EXTERNAL PROXY IP ---
  if (proxy && proxy.server) {
    try {
      await verifyProxyIp({
        browser: browserContext,
        proxy,
        label: "Demo Login Swap",
        closeBrowserOnFailure: false
      });
    } catch (err) {
      // Close the newPage we just opened to prevent leak or zombie tabs
      if (newPage && !newPage.isClosed()) {
        await newPage.close().catch(() => {});
      }
      throw err;
    }
  }

  await newPage.goto("https://d3jai9eacl1740.cloudfront.net/lobby/multiplay", { 
    waitUntil: "networkidle2", 
    timeout: 30000 
  }).catch(() => {});
  
  await checkPageErrors(newPage, { log: console.log, warn: console.warn, error: console.error });

  // Start active network watchdog on the swapped page context
  const { startNetworkWatchdog } = require("../utils/network_watchdog");
  startNetworkWatchdog(newPage, { log: console.log, warn: console.warn, error: console.error });

  return newPage;
}

module.exports = {
  loginToDemo,
};
