const path = require("path");
const fs = require("fs");

/**
 * SessionManager - Manages the lifecycle of the Puppeteer/Chromium browser session,
 * handles automatic rotation, graceful session restarts, and error/crash recovery.
 */
class SessionManager {
  /**
   * @param {Object} params
   * @param {AccountRotator} params.rotator
   * @param {BrowserController} params.browserController
   * @param {TelemetryService} params.telemetry
   * @param {BetQueueProcessor} params.queueProcessor
   * @param {Function} params.updateBalanceFn
   * @param {Function} params.sendHeartbeatFn
   */
  constructor({
    rotator,
    browserController,
    telemetry,
    queueProcessor,
    updateBalanceFn,
    sendHeartbeatFn
  }) {
    this.rotator = rotator;
    this.browserController = browserController;
    this.telemetry = telemetry;
    this.queueProcessor = queueProcessor;
    this.updateBalanceFn = updateBalanceFn;
    this.sendHeartbeatFn = sendHeartbeatFn;

    this.sessionRestartTimer = null;
    this.isIntentionalRestart = false;
  }

  /**
   * Helper to retrieve the current active account's label
   * @returns {string}
   */
  getAccountLabel() {
    const acctConfig = this.rotator.getCurrentConfig();
    return acctConfig.label || `Account_${process.env.BET_PORT || 'unknown'}`;
  }

  /**
   * Schedules a graceful session restart after a configured period (sessionRestartMinutes)
   * @param {Object} acctConfig 
   */
  scheduleSessionRestart(acctConfig) {
    const minutes = acctConfig.sessionRestartMinutes;
    if (!minutes || minutes <= 0) return;
    
    if (this.sessionRestartTimer) clearInterval(this.sessionRestartTimer);
    
    console.log(`[Session Restart] Polling enabled. Will restart ${minutes} minutes after login for ${acctConfig.label}.`);
    const launchTime = Date.now();
    
    this.sessionRestartTimer = setInterval(async () => {
      let loginTime = launchTime;
      try {
        const tsFile = path.resolve(__dirname, "..", "..", "utils", "login_timestamps.json");
        if (fs.existsSync(tsFile)) {
          const timestamps = JSON.parse(fs.readFileSync(tsFile, 'utf8'));
          if (timestamps[acctConfig.label]) loginTime = timestamps[acctConfig.label];
        }
      } catch (e) {
        console.error("[Session Restart] Error reading login timestamp file:", e.message);
      }
      
      const elapsedMin = (Date.now() - loginTime) / 60000;
      if (elapsedMin < minutes) return;
      
      clearInterval(this.sessionRestartTimer);
      this.sessionRestartTimer = null;
      
      console.log(`\x1b[33m[Session Restart] ${elapsedMin.toFixed(1)} mins elapsed for ${acctConfig.label}. Graceful restart...\x1b[0m`);
      
      // Step 1: Temporarily signal unready to pull from dashboard RR pool
      this.browserController.isBrowserReady = false;
      this.sendHeartbeatFn();
      
      // Step 2: Wait for active bets in the queue to resolve
      const maxWaitMs = 60000;
      const startWait = Date.now();
      while (this.queueProcessor.isProcessing() && (Date.now() - startWait < maxWaitMs)) {
        console.log(`[Session Restart] Waiting for active bet to complete...`);
        await new Promise(r => setTimeout(r, 1000));
      }
      
      // Step 3: Trigger restart
      console.log(`[Session Restart] Closing browser to trigger rotator...`);
      await this.triggerRestart();
    }, 30000);
  }

  /**
   * Intentionally closes active browser instance to force session rotation
   */
  async triggerRestart() {
    this.isIntentionalRestart = true;
    await this.browserController.close();
  }

  /**
   * Background monitor loop managing browser creation, crash recovery, and rotation
   */
  async initBrowserLifecycle() {
    while (true) {
      try {
        const acctConfig = this.rotator.getCurrentConfig();
        console.log(`\n[Bet Module] Initializing session lifecycle for ${acctConfig.label} (Index: ${this.rotator.getCurrentIndex()})...`);
        
        const { page } = await this.browserController.launch(acctConfig);
        
        // Listen to page close event to immediately notify telemetry
        page.on('close', () => {
          console.log(`[SessionManager] Page close event detected. Informing telemetry immediately.`);
          this.browserController.isBrowserReady = false;
          this.sendHeartbeatFn();
        });
        
        // Sync initial telemetry balance & scheduling
        await this.updateBalanceFn();
        this.sendHeartbeatFn();
        this.scheduleSessionRestart(acctConfig);
        
        // Wait until page is closed by crash or restart signal
        while (!page.isClosed() && this.browserController.browserInstance) {
          await new Promise(r => setTimeout(r, 2000));
        }
        
        if (this.sessionRestartTimer) {
          clearInterval(this.sessionRestartTimer);
          this.sessionRestartTimer = null;
        }
        
        console.log(`\x1b[31m[Bet Module] Session cycle ended. Advancing account...\x1b[0m`);
        if (!this.isIntentionalRestart) {
          this.telemetry.notifyAlert(
            `[RECOVERY] Bet module "${acctConfig.label}" relaunching. Reason: Browser closed unexpectedly.`
          ).catch(() => {});
        }
        
        this.isIntentionalRestart = false;
        await this.browserController.close();
        await this.telemetry.deregister(acctConfig.label).catch(() => {});
        this.rotator.advanceToNext();
      } catch (err) {
        console.error("\x1b[31m[Bet Module] Lifecycle error:\x1b[0m", err.message);
        const acctConfig = this.rotator.getCurrentConfig();
        if (!this.isIntentionalRestart) {
          this.telemetry.notifyAlert(
            `[RECOVERY] Bet module "${acctConfig.label}" failed and is relaunching. Reason: ${err.message}`
          ).catch(() => {});
        }
        this.isIntentionalRestart = false;
        if (this.sessionRestartTimer) {
          clearInterval(this.sessionRestartTimer);
          this.sessionRestartTimer = null;
        }
        await this.browserController.close();
        await this.telemetry.deregister(acctConfig.label).catch(() => {});
        this.rotator.advanceToNext();
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

module.exports = SessionManager;
