const executeBet = require("../executeBet");

class BetQueueProcessor {
  /**
   * @param {Object} telemetryService 
   */
  constructor(telemetryService) {
    this.betQueue = [];
    this.telemetryService = telemetryService;
    this.isBetInProgress = false;
    this.consecutiveBetErrors = 0;
  }

  /**
   * Queues an incoming bet transaction.
   * @param {Object} betPayload 
   */
  queueBet(betPayload) {
    this.betQueue.push(betPayload);
  }

  getQueueLength() {
    return this.betQueue.length;
  }

  isProcessing() {
    return this.isBetInProgress;
  }

  /**
   * Main async processing loop that handles dequeuing bets and executing.
   * @param {Object} context 
   * @param {() => boolean} context.isBrowserReadyFn 
   * @param {() => import('puppeteer').Page} context.getPageFn 
   * @param {() => string} context.getAccountLabelFn 
   * @param {(balance: string) => void} context.onBalanceUpdatedFn 
   * @param {() => void} context.onForceTabRestartFn 
   */
  async startProcessingLoop(context) {
    while (true) {
      if (this.betQueue.length > 0) {
        const bet = this.betQueue.shift();
        const accountLabel = context.getAccountLabelFn();
        
        console.log(`\n[${accountLabel}] 📥 Received Bet: ${bet.uuid || bet.id} for ${bet.tableName} (${bet.target || bet.betType})`);
        
        let success = false;
        let reason = "Unknown error";
        
        this.isBetInProgress = true;
        
        if (!context.isBrowserReadyFn() || !context.getPageFn()) {
          reason = "Browser not ready for bet";
          console.error(`[Bet Module] ${reason}.`);
        } else {
          const targetAmount = bet.recommendedBetAmount || bet.amount || bet.chipIndex || 0;
          const betConfig = {
            tableName: bet.tableName,
            betType: bet.target || bet.betType,
            targetAmount: targetAmount,
            betPlacementDelayMs: parseInt(process.env.BET_PLACEMENT_DELAY_MS || "150", 10),
            chipSettleDelayMs: parseInt(process.env.CHIP_SETTLE_DELAY_MS || "500", 10),
            chipSelector: ".chip",
            betConfirmTimeoutMs: parseInt(process.env.BET_CONFIRM_TIMEOUT_MS || "2000", 10),
            maxAttempts: parseInt(process.env.BET_MAX_ATTEMPTS || "1", 10)
          };

          try {
            const result = await executeBet(context.getPageFn(), betConfig);
            success = result.success;
            reason = result.reason;
            
            if (result.betAmount) {
              bet.actualBetAmount = result.betAmount;
            }
            if (result.balance !== undefined && result.balance !== null) {
              context.onBalanceUpdatedFn(result.balance);
            }
            bet.timer = result.timer != null ? result.timer : null;
            bet.attempts = result.attempts || 1;
            bet.enterAttempts = result.enterAttempts || 1;
            bet.attemptOutcomes = result.attemptOutcomes || [];
          } catch (err) {
            reason = `Execution error: ${err.message}`;
          }
        }
        
        this.isBetInProgress = false;
        const status = success ? "SUCCESS" : "FAILED";
        
        if (!success) {
          this.consecutiveBetErrors++;
          const maxErrors = parseInt(process.env.MAX_CONSECUTIVE_BET_ERRORS || "3", 10);
          if (this.consecutiveBetErrors >= maxErrors) {
            this.telemetryService.notifyAlert(
              `[ALERT] Bet module "${accountLabel}" encountered ${maxErrors} consecutive bet errors. Last reason: ${reason || "None"}`
            ).catch(() => {});
            
            console.log(`[ALERT] ${maxErrors} consecutive errors. Triggering tab restart.`);
            context.onForceTabRestartFn();
            this.consecutiveBetErrors = 0;
          }
        } else {
          this.consecutiveBetErrors = 0;
        }

        const amountText = success && bet.actualBetAmount ? ` [Amount: ${bet.actualBetAmount}]` : "";
        const reasonText = success ? "" : ` (Reason: ${reason || "None given"})`;
        const timerText = bet.timer != null ? ` [Timer: ${bet.timer}s]` : "";
        console.log(`[${accountLabel}] ${success ? '✅' : '❌'} Result: ${status}${amountText}${reasonText}${timerText}`);

        // Report result to central server
        this.telemetryService.reportBetResult(
          accountLabel,
          bet.uuid || bet.id,
          status,
          reason,
          bet.actualBetAmount,
          bet.tableName,
          bet.target || bet.betType,
          bet.timer,
          bet.attempts,
          bet.enterAttempts,
          bet.attemptOutcomes
        ).catch(() => {});
        
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
}

module.exports = BetQueueProcessor;
