/**
 * telemetryClient.js — Handles outgoing telemetry reports to the Central server
 */

const crypto = require("crypto");
const config = require("./config");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");

const API_BASE = "http://localhost:3456/api/telemetry";

/**
 * Dispatch shuffle events.
 * @param {string} tableName
 * @param {string} reason
 * @param {number} finalRound
 */
async function sendShuffle(tableName, reason, finalRound) {
  try {
    const res = await fetch(`${API_BASE}/shuffle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableName, reason, finalRound })
    });
    return await res.json();
  } catch (err) {
    console.log(`  \x1b[31m[SHUFFLE] Failed to send to Central: ${err.message}\x1b[0m`);
    return null;
  }
}

/**
 * General helper to post events to the eyes telemetry endpoint.
 * @param {object} payload - The structured payload
 * @param {string} typeLabel - Logging label
 */
async function sendTelemetry(payload, typeLabel = "TELEMETRY") {
  try {
    const res = await fetch(`${API_BASE}/eyes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.log(`  \x1b[31m[${typeLabel}] Failed to send to Central: ${err.message}\x1b[0m`);
    return null;
  }
}

/**
 * Report the outcome of a completed round to Central.
 * @param {string} betId - The UUID of the bet placed for this round
 * @param {string} tableName
 * @param {number} round
 * @param {string} winner - "P", "B", "T", or "UNKNOWN"
 * @param {number} deckRemaining
 */
function sendRoundOutcome(betId, tableName, round, winner, deckRemaining) {
  const payload = {
    uuid: betId,
    instanceID: "PG_Eyes",
    tableNumber: tableName,
    status: { setup: "READY", autoBet: true, gameState: "ROUND_COMPLETE" },
    ocr: { roundNumber: String(round), winner: winner || "UNKNOWN" },
    metrics: { deckRemaining },
    mathematics: {}
  };
  sendTelemetry(payload, "ROUND RESULTS");
}

/**
 * Dispatch a bet signal to Central.
 * @param {object} ts - Table state from stateManager
 * @param {string} tableName
 * @param {object} stateManager - For delayed supersede checks
 */
function sendBetSignal(ts, tableName, stateManager) {
  ts.currentBetId = crypto.randomUUID();

  const betPayload = {
    uuid: ts.currentBetId,
    instanceID: "PG_Eyes",
    tableNumber: tableName,
    status: { setup: "READY", autoBet: true, gameState: "WAITING_FOR_BETS" },
    ocr: { roundNumber: String(ts.round) },
    metrics: { deckRemaining: ts.remaining },
    mathematics: {
      deckComposition: ts.deckComposition,
      evSnapshot: {
        "PlayerBet": { ev: ts.lastEvResult.ev_player, prob: ts.lastEvResult.p_player },
        "BankerBet": { ev: ts.lastEvResult.ev_banker, prob: ts.lastEvResult.p_banker },
        "TieBet": { ev: ts.lastEvResult.ev_tie, prob: ts.lastEvResult.p_tie }
      }
    }
  };

  const delayMs = config.minBetDelayMs;
  if (delayMs > 0) {
    setTimeout(() => {
      const currentTs = stateManager.getTable(tableName);
      if (!currentTs || currentTs.currentBetId !== betPayload.uuid) {
        console.log(`  \x1b[33m[SIGNAL] Aborted dispatch to Central (BetId: ${betPayload.uuid} superseded or cleared)\x1b[0m`);
        return;
      }
      sendTelemetry(betPayload, "SIGNAL");
    }, delayMs);
  } else {
    sendTelemetry(betPayload, "SIGNAL");
  }
}

/**
 * Routes game events to the appropriate telemetry dispatchers.
 * @param {Array} events - Game events from the current update batch
 * @param {object} stateManager - TableStateManager instance
 */
function handleTelemetrySignals(events, stateManager) {
  for (const event of events) {
    const ts = stateManager.getTable(event.tableName);

    // 1. Shuffles
    if (event.type === "SHOE_RESET") {
      if (ts) ts.currentBetId = null;
      if (event.isActualShuffle) sendShuffle(event.tableName, event.reason, event.finalRound);
      continue;
    }

    if (event.type !== "HAND_COMPLETE" && event.type !== "STATE_CHANGE") continue;
    if (!ts) continue;

    const hasReset = events.some(e => e.type === "SHOE_RESET" && e.tableName === event.tableName);

    // 2. Round outcomes
    if (event.type === "HAND_COMPLETE" && ts.currentBetId) {
      sendRoundOutcome(ts.currentBetId, event.tableName, event.round, event.winner, event.deckRemaining || ts.remaining);
      ts.currentBetId = null;
    }

    if (hasReset) continue;

    // 3. Bet signals
    if (ts.state !== "Waiting for Bets") continue;
    if (!ts.lastEvResult || !ts.lastEvResult.best) continue;

    const maxEv = Math.max(
      ts.lastEvResult.ev_player || 0,
      ts.lastEvResult.ev_banker || 0,
      ts.lastEvResult.ev_tie || 0
    );

    // Warn if EV is abnormally high (potential deck sync issue)
    if (maxEv > 0.01 && ts.lastWarnedEvRound !== ts.round) {
      const remaining = event.deckRemaining !== undefined ? event.deckRemaining : ts.remaining;
      const msg = `[WARNING] ${event.tableName} (Round ${ts.round}): Abnormal EV detected (${(maxEv * 100).toFixed(3)}% > 1.0%). Deck size might be out of sync (Remaining: ${remaining})`;
      console.log(`\x1b[33m${msg}\x1b[0m`);
      sendWhatsAppNotification(msg).catch(() => {});
      ts.lastWarnedEvRound = ts.round;
    }

    if (ts.currentBetId) continue; // Already pending

    sendBetSignal(ts, event.tableName, stateManager);
  }
}

module.exports = {
  sendShuffle,
  sendTelemetry,
  sendRoundOutcome,
  sendBetSignal,
  handleTelemetrySignals
};
