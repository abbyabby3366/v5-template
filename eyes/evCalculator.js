/**
 * evCalculator.js — Bridge to the Rust analyzer_bin binary
 *
 * Spawns the compiled Rust binary with 13-slot deck composition,
 * parses the JSON probability output, and computes EV metrics.
 *
 * Input:  13-slot composition [A, 2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K]
 * Output: { p_player, p_banker, p_tie, ev_player, ev_banker, ev_tie, best }
 */

const { execFile } = require("child_process");
const util = require("util");
const path = require("path");

const execFilePromise = util.promisify(execFile);

let lastEvErrorNotificationTime = 0;

const ANALYZER_BIN = path.join(
  __dirname,
  "..",
  "baccarat_analyzer_v3",
  "target",
  "release",
  "analyzer_bin.exe"
);

// Remove default process.env readings at top level, or keep them as fallbacks
const DEFAULT_REBATE_RATE = 0.012;
const DEFAULT_MIN_EV_THRESHOLD = 0.0003;

/**
 * Calculate EV for a given 13-slot deck composition.
 * @param {number[]} composition - 13-element array [A,2,3,...,K] remaining counts
 * @param {object} config - { rebateRate, minEvThreshold }
 * @returns {Promise<object>} EV results with probabilities and best bet recommendation
 */
async function calculateEV(composition, config = {}) {
  const REBATE_RATE = config.rebateRate !== undefined ? parseFloat(config.rebateRate) : DEFAULT_REBATE_RATE;
  const MIN_EV_THRESHOLD = config.minEvThreshold !== undefined ? parseFloat(config.minEvThreshold) : DEFAULT_MIN_EV_THRESHOLD;

  if (!composition || composition.length !== 13) {
    throw new Error(`Expected 13-slot composition, got ${composition?.length}`);
  }

  const total = composition.reduce((a, b) => a + b, 0);
  if (total < 4) {
    return null; // Not enough cards for a hand
  }

  try {
    const args = composition.map(String);
    const { stdout } = await execFilePromise(ANALYZER_BIN, args, {
      timeout: 5000,
    });

    const probs = JSON.parse(stdout.trim());
    const pp = probs.p_player;
    const pb = probs.p_banker;
    const pt = probs.p_tie;
    const nonTie = pp + pb;

    if (nonTie === 0) return null;

    // EV on effective turnover basis (tie = push)
    const evPlayerBase = (pp - pb) / nonTie;
    const evBankerBase = (pb * 0.95 - pp) / nonTie;
    const evTieBase = pt * 8.0 - (1.0 - pt);

    // With rebate applied
    const evPlayerAdj = evPlayerBase + REBATE_RATE;
    const evBankerAdj = evBankerBase + REBATE_RATE;
    const evTieAdj = evTieBase + REBATE_RATE;

    // Find best bet
    let best = null;
    let bestEv = MIN_EV_THRESHOLD;

    if (evPlayerAdj > bestEv) {
      best = { target: "Player", ev: evPlayerAdj, prob: pp };
      bestEv = evPlayerAdj;
    }
    if (evBankerAdj > bestEv) {
      best = { target: "Banker", ev: evBankerAdj, prob: pb };
      bestEv = evBankerAdj;
    }

    return {
      p_player: pp,
      p_banker: pb,
      p_tie: pt,
      ev_player_base: evPlayerBase,
      ev_banker_base: evBankerBase,
      ev_player: evPlayerAdj,
      ev_banker: evBankerAdj,
      ev_tie: evTieAdj,
      rebate: REBATE_RATE,
      remaining: total,
      best, // null if no edge, or { target, ev, prob }
    };
  } catch (err) {
    console.error(`[EV] Analyzer error: ${err.message}`);
    const now = Date.now();
    if (now - lastEvErrorNotificationTime > 15 * 60 * 1000) {
      lastEvErrorNotificationTime = now;
      const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
      sendWhatsAppNotification(`[CRITICAL] EV Analyzer failed to execute: ${err.message}`)
        .catch(wErr => console.error("EV Error Notification failed:", wErr.message));
    }
    return null;
  }
}

async function processEVForEvents(events, dynamicConfig = {}) {
  const useActual = String(process.env.USE_ACTUAL_DECK_COMPOSITION).toLowerCase() === 'true';
  for (const event of events) {
    if (event.type !== "HAND_COMPLETE" && event.type !== "STATE_CHANGE") continue;

    // Skip EV calculation if shoe was reset in the same tick
    const hasReset = events.some(e => e.type === "SHOE_RESET" && e.tableName === event.tableName);
    if (hasReset) continue;

    const ts = event.tableState;
    const compToUse = useActual && ts.actualDeckComposition ? ts.actualDeckComposition : event.deckComposition;

    const evResult = await calculateEV(compToUse, dynamicConfig);
    if (evResult) {
      ts.lastEvResult = evResult;
    }
  }
}

module.exports = { calculateEV, processEVForEvents };
