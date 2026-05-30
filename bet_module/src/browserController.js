const path = require("path");
const fs = require("fs");
const { launchAccount } = require("../../utils/launch_winbox");

class BrowserController {
  constructor() {
    this.browserInstance = null;
    this.browserPage = null;
    this.isBrowserReady = false;
  }

  /**
   * Helper checking if the browser tab is fully initialized and open.
   * @returns {boolean}
   */
  isReady() {
    return this.isBrowserReady && this.browserPage && !this.browserPage.isClosed();
  }

  getPage() {
    return this.browserPage;
  }

  getBrowser() {
    return this.browserInstance;
  }

  /**
   * Spawns Chromium session for the specified account config and injects state interceptors.
   * @param {Object} acctConfig 
   * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page}>}
   */
  async launch(acctConfig) {
    this.isBrowserReady = false;
    this.browserPage = null;

    // Reset/update login timestamp
    try {
      const tsFile = path.resolve(__dirname, "..", "..", "utils", "login_timestamps.json");
      let timestamps = {};
      if (fs.existsSync(tsFile)) {
        timestamps = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
      }
      timestamps[acctConfig.label] = Date.now();
      fs.writeFileSync(tsFile, JSON.stringify(timestamps, null, 2));
    } catch (e) {
      console.error("[Browser] Failed to write login timestamp:", e.message);
    }

    console.log(`\n[Browser] Starting winbox browser sequence for ${acctConfig.label}...`);
    const { browser, page } = await launchAccount(acctConfig);

    this.browserInstance = browser;
    this.browserPage = page;
    this.isBrowserReady = true;

    // Inject standard client state WebSocket interceptor
    try {
      const interceptorPath = path.resolve(__dirname, "..", "..", "eyes", "interceptor.js");
      const interceptorCode = fs.readFileSync(interceptorPath, "utf8");
      await page.evaluate(interceptorCode).catch(() => {});
      await page.evaluateOnNewDocument(interceptorCode).catch(() => {});
      console.log(`[Browser] Injected WebSocket interceptors successfully.`);
    } catch (e) {
      console.error(`[Browser] Failed to load/inject WebSocket interceptors:`, e.message);
    }

    console.log(`\x1b[32m[Browser] Launch Successful! Tab is ready to place bets.\x1b[0m`);
    return { browser, page };
  }

  async close() {
    this.isBrowserReady = false;
    const browser = this.browserInstance;
    this.browserInstance = null;
    this.browserPage = null;

    if (browser) {
      console.log(`[Browser] Closing active browser instance...`);
      try {
        await Promise.race([
          browser.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close() timeout")), 5000))
        ]);
      } catch (err) {
        console.warn(`[Browser] browser.close() did not complete in 5s, forcing disconnect as fallback:`, err.message);
        try {
          await browser.disconnect();
        } catch (e) {}
      }
    }
  }
}

module.exports = BrowserController;
