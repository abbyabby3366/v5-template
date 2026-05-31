const { sendWhatsAppNotification } = require("../../utils/whatsapp_notifier");

class TelemetryService {
  /**
   * @param {Object} config 
   * @param {string} config.baseUrl 
   * @param {string} config.centralUrl 
   */
  constructor(config) {
    this.baseUrl = config.baseUrl;
    this.centralUrl = config.centralUrl;
  }

  /**
   * Reports system status to the central dashboard server using the active accountLabel.
   * @param {string} accountLabel 
   * @param {boolean} isAccepting 
   * @param {string|null} latestBalance 
   * @param {string|null} currentIp
   * @param {string} betType
   * @param {number[]} allowedFixedAmounts
   */
  async sendHeartbeat(accountLabel, isAccepting, latestBalance, currentIp = null, betType = "variable", allowedFixedAmounts = []) {
    const payload = {
      moduleId: accountLabel, // Dynamic per active account label
      baseUrl: this.baseUrl,
      label: accountLabel,    
      accounts: [{ 
        label: accountLabel, 
        isAcceptingBets: isAccepting, 
        balance: latestBalance, 
        ip: currentIp || "Checking...",
        betType,
        allowedFixedAmounts
      }]
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
   * Explicitly unregisters an account module from the dashboard during rotation.
   * @param {string} moduleId 
   */
  async deregister(moduleId) {
    try {
      await fetch(`${this.centralUrl}/api/bet-module/deregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleId })
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
