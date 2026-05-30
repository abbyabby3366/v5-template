const { sendWhatsAppNotification } = require("../../utils/whatsapp_notifier");

class TelemetryService {
  /**
   * @param {Object} config 
   * @param {string} config.moduleId 
   * @param {string} config.baseUrl 
   * @param {string} config.centralUrl 
   */
  constructor(config) {
    this.moduleId = config.moduleId;
    this.baseUrl = config.baseUrl;
    this.centralUrl = config.centralUrl;
  }

  /**
   * Reports system status to the central dashboard server.
   * @param {string} moduleLabel 
   * @param {string} accountLabel 
   * @param {boolean} isAccepting 
   * @param {string|null} latestBalance 
   */
  async sendHeartbeat(moduleLabel, accountLabel, isAccepting, latestBalance) {
    const payload = {
      moduleId: this.moduleId,
      baseUrl: this.baseUrl,
      label: moduleLabel,
      accounts: [{ label: accountLabel, isAcceptingBets: isAccepting, balance: latestBalance }]
    };

    try {
      await fetch(`${this.centralUrl}/api/bet-module/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      // Silently fail if central is offline
    }
  }

  /**
   * Submits transaction outcome logs to Central.
   */
  async reportBetResult(accountLabel, betId, status, reason, betAmount, tableNumber, betType, timer) {
    try {
      await fetch(`${this.centralUrl}/api/telemetry/bet-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          betId,
          status,
          reason,
          betAmount,
          tableNumber,
          betType,
          timer
        })
      });
    } catch (err) {
      console.error(`[${accountLabel}] Failed to report result to central:`, err.message);
    }
  }

  /**
   * Sends critical alert message using WhatsApp service.
   * @param {string} message 
   */
  async notifyAlert(message) {
    try {
      await sendWhatsAppNotification(message);
    } catch (err) {
      console.error("WhatsApp notification failed:", err.message);
    }
  }
}

module.exports = TelemetryService;
