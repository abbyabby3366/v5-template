/**
 * network_watchdog.js - A general utility to check if network traffic is actively passing through
 * a Puppeteer page context. Can be used with or without proxy routing.
 * If the connection is lost for too long, triggers page reloads and tab closures to force recovery.
 */

/**
 * Periodically checks if network traffic is passing through the page context.
 * 
 * @param {import('puppeteer').Page} page
 * @param {Object} logger
 * @param {Object} options
 * @param {number} [options.intervalMs] - Watchdog ping interval (default: 15000ms)
 * @param {number} [options.timeoutMs] - Maximum silent duration before triggering reload/close (default: 30000ms)
 * @returns {NodeJS.Timeout} The interval ID
 */
function startNetworkWatchdog(page, logger = console, options = {}) {
  const intervalMs = options.intervalMs || 15000;
  const timeoutMs = options.timeoutMs || 30000;

  let lastSuccessfulPing = Date.now();

  const intervalId = setInterval(async () => {
    if (page.isClosed && page.isClosed()) {
      clearInterval(intervalId);
      return;
    }

    try {
      const pingOk = await page.evaluate(async () => {
        const servers = [
          "https://api.ipify.org?format=json",
          "https://httpbin.org/ip"
        ];
        for (const url of servers) {
          try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(id);
            if (res.ok) return true;
          } catch (e) {}
        }
        return false;
      }).catch(() => false);

      if (pingOk) {
        lastSuccessfulPing = Date.now();
      } else {
        logger.warn(`[NetworkWatchdog] Ping failed inside browser context.`);
      }

      if (Date.now() - lastSuccessfulPing > timeoutMs) {
        const elapsedS = Math.round((Date.now() - lastSuccessfulPing) / 1000);
        const reason = `No network traffic detected in browser context for ${elapsedS}s (VPN/Internet dropped)`;
        logger.error(`❌ [NetworkWatchdog] CRITICAL: ${reason}! Triggering recovery...`);
        
        // Tag the page with the custom close reason
        page.closeReason = reason;
        
        // Reset timestamp to prevent rapid triggers
        lastSuccessfulPing = Date.now();
        clearInterval(intervalId);

        logger.log("[NetworkWatchdog] Attempting page reload...");
        await page.reload({ waitUntil: "networkidle2", timeout: 20000 }).catch((e) => {
          logger.error(`[NetworkWatchdog] Page reload failed: ${e.message}`);
        });

        logger.log("[NetworkWatchdog] Force-closing page to trigger supervisor recovery/rotation...");
        await page.close().catch(() => {});
      }
    } catch (err) {
      if (err.message && (err.message.includes("Target closed") || err.message.includes("Session closed") || err.message.includes("detached Frame"))) {
        clearInterval(intervalId);
      }
    }
  }, intervalMs);

  return intervalId;
}

module.exports = {
  startNetworkWatchdog
};
