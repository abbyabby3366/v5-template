/**
 * tableManager.js — Per-table state management and event dispatch
 *
 * Owns TableState lifecycle: creation, deck subtraction, shoe resets, and serialization.
 * Delegates all validation decisions to stateValidators.js.
 * Emits HAND_COMPLETE, SHOE_RESET, and STATE_CHANGE events for downstream consumers.
 */

const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
const {
  checkEventValidations,
  isResultState,
  checkBeadRoadMismatch,
  isInvalidStateReset,
  checkStaleRestoredState,
  checkImplicitOrExplicitNewShoe,
  checkMissedRounds,
  checkIsAlreadyFinalized,
  cardRankToIndex,
  processAndValidateCards,
  checkSpecificCardDepletion,
} = require("./stateValidators");

// ─── Fresh 8-Deck Shoe ──────────────────────────────────────────────────
// Each rank × 4 suits × 8 decks = 32 cards per rank slot. Total = 416.
function freshShoe() {
  return [32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32];
}

function deckRemaining(composition) {
  return composition.reduce((a, b) => a + b, 0);
}

function colorizeState(stateStr) {
  if (!stateStr) return stateStr;
  if (/player\s*win/i.test(stateStr)) {
    return `\x1b[94m${stateStr}\x1b[0m`; // Bright Blue
  } else if (/banker\s*win/i.test(stateStr)) {
    return `\x1b[31m${stateStr}\x1b[0m`; // Red
  } else if (/tie\s*win/i.test(stateStr)) {
    return `\x1b[32m${stateStr}\x1b[0m`; // Green
  }
  return stateStr;
}

function getBaccaratValue(cards) {
  if (!cards || cards.length === 0) return 0;
  let sum = 0;
  for (const card of cards) {
    if (!card) continue;
    const rank = card.slice(0, -1).toUpperCase();
    if (rank === "A") sum += 1;
    else if (rank === "10" || rank === "T" || rank === "J" || rank === "Q" || rank === "K") sum += 0;
    else {
      const val = parseInt(rank, 10);
      if (!isNaN(val)) sum += val;
    }
  }
  return sum % 10;
}


class TableState {
  constructor(tableName, tableId = null) {
    this.tableName = tableName;
    this.tableId = tableId;
    this.state = null;
    this.round = 0;
    this.deckComposition = freshShoe();
    this.lastFinalizedRound = 0;
    this.lastEvResult = null;
    this.currentBetId = null;
    this.restored = false;
    this.consecutiveZeroCardHands = 0;
    this.lastErrorResetReason = null;
    this.lastErrorResetTime = null;
    this.handHistory = [];
    this.lastAlertedMismatchRound = null;
    this.lastVerifiedMismatchRound = null;
    this.lastWarnedEvRound = null;
    this.lastWarnedMissedRound = null;
  }

  get remaining() {
    return deckRemaining(this.deckComposition);
  }

  /** Derive last hand's cards from handHistory */
  get lastHand() {
    if (this.handHistory.length === 0) return null;
    return this.handHistory[this.handHistory.length - 1];
  }
}

class TableStateManager {
  constructor() {
    /** @type {Map<string, TableState>} */
    this.tables = new Map();
  }

  getTable(tableName) {
    return this.tables.get(tableName) || null;
  }

  /**
   * Update table states from incoming interceptor events.
   * @param {Array} tableDataArray - Array of table objects pushed by the browser interceptor
   * @returns {Array} - List of state-change events
   */
  update(tableDataArray) {
    const events = [];

    for (const table of tableDataArray) {
      const name = table.tableName;
      if (!this.tables.has(name)) {
        this.tables.set(name, new TableState(name, table.tableId || null));
      }
      const ts = this.tables.get(name);
      const prevState = ts.state;
      const newState = table.state;
      const newRound = table.round;

      // Update tableId if provided
      if (table.tableId) ts.tableId = table.tableId;



      // 1. Handle stale restored state
      const staleReason = checkStaleRestoredState(ts, newRound);
      if (ts.restored) ts.restored = false;

      if (staleReason) {
        this.#resetShoe(ts, staleReason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: staleReason,
          finalRound: ts.round
        });
        ts.state = newState;
        ts.round = newRound;
        continue;
      }

      // 2. Detect implicit or explicit new shoe
      const newShoeReason = checkImplicitOrExplicitNewShoe(ts, newRound, newState, prevState, table.statistics);
      if (newShoeReason) {
        this.#resetShoe(ts, newShoeReason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: newShoeReason,
          isActualShuffle: true,
          finalRound: ts.round
        });
        ts.state = newState;
        ts.round = newRound;
        ts.handHistory = [];
        continue;
      }

      // 3. Prevent minor out-of-order round backwards drops
      if (newRound < ts.round) {
        console.warn(`\x1b[33m[STATE] ${name}: Stale/out-of-order round drop ignored (live R${newRound} < current R${ts.round})\x1b[0m`);
        continue;
      }



      // Verify hand history outcomes match server statistics ONCE per round when in Waiting for Bets
      if (newState === "Waiting for Bets" && ts.lastFinalizedRound > 0 && ts.lastVerifiedMismatchRound !== ts.lastFinalizedRound) {
        if (table.statistics && table.statistics.length >= ts.lastFinalizedRound) {
          const { mismatchFound, mismatchDetails, mismatchRound } = checkBeadRoadMismatch(ts.handHistory, table.statistics);
          if (mismatchFound && ts.lastAlertedMismatchRound !== mismatchRound) {
            const msg = `[WARNING] ${ts.tableName} Hand History Discrepancy! ${mismatchDetails}`;
            console.log(`\x1b[31m${msg}\x1b[0m`);
            sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
            ts.lastAlertedMismatchRound = mismatchRound;
          }
          ts.lastVerifiedMismatchRound = ts.lastFinalizedRound;
        }
      }

      // 4. Missed Round (Gap) Detection
      if (checkMissedRounds(ts, newRound)) {
        if (ts.lastWarnedMissedRound !== newRound) {
          console.warn(`\x1b[33m[STATE] ${name}: Missed round(s) detected between last finalized R${ts.lastFinalizedRound} and live R${newRound}. Continuing as requested...\x1b[0m`);
          ts.lastWarnedMissedRound = newRound;
        }
      }

      // Process hand completion when server transitions to Result
      const isAlreadyFinalized = checkIsAlreadyFinalized(ts, newRound);
      const hasCards = (table.playerCards?.length > 0) || (table.bankerCards?.length > 0);

      if (isResultState(newState) && newRound > ts.lastFinalizedRound && newRound > 0 && hasCards) {
        if (isAlreadyFinalized) {
          const msg = `[WARNING] ${ts.tableName}: Double-deduction attempt guarded for completed round ${newRound}!`;
          console.log(`\x1b[31m${msg}\x1b[0m`);
          sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
        } else {
          // Extract, validate, and subtract cards via stateValidators
          const {
            corruptedReason,
            cardsSubtracted,
            newComposition,
            nextConsecutiveZeroCardHands
          } = processAndValidateCards(
            ts.deckComposition,
            table.playerCards,
            table.bankerCards,
            ts.consecutiveZeroCardHands,
            newRound
          );

          let finalCorruptedReason = corruptedReason;

          if (!finalCorruptedReason) {
            finalCorruptedReason = checkSpecificCardDepletion(ts.handHistory, table.playerCards, table.bankerCards);
          }

          ts.deckComposition = newComposition;
          ts.consecutiveZeroCardHands = nextConsecutiveZeroCardHands;
          ts.lastFinalizedRound = newRound;
          ts.lastWarnedMissedRound = null; // Reset warning state since we successfully completed a round

          if (finalCorruptedReason) {
            this.#resetShoe(ts, finalCorruptedReason);
            events.push({
              type: "SHOE_RESET",
              tableName: name,
              reason: finalCorruptedReason,
              finalRound: ts.round
            });
          } else {
            ts.lastErrorResetReason = null;
            ts.lastErrorResetTime = null;
            if (table.winner) {
              ts.handHistory.push({
                round: newRound,
                winner: table.winner,
                playerCards: table.playerCards || [],
                bankerCards: table.bankerCards || [],
                winPoints: table.winPoints !== undefined && table.winPoints !== null ? table.winPoints : null
              });
            }

            events.push({
              type: "HAND_COMPLETE",
              tableName: name,
              tableState: ts,
              round: newRound,
              playerCards: table.playerCards,
              bankerCards: table.bankerCards,
              cardsSubtracted: cardsSubtracted,
              deckRemaining: ts.remaining,
              deckComposition: [...ts.deckComposition],
              winner: table.winner,
            });
          }
        }
      }

      // External Validations
      const invalidReason = checkEventValidations(ts, newRound, newState, prevState);

      if (invalidReason) {
        this.#resetShoe(ts, invalidReason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: invalidReason,
          finalRound: ts.round
        });
      }

      // Log generic state changes if enabled in env
      if (newState !== prevState && (process.env.LOG_STATE_CHANGES === "true" || process.env.LOG_STATE_CHANGES === "TRUE")) {
        let cardInfo = "";
        if (isResultState(newState) && ((table.playerCards && table.playerCards.length > 0) || (table.bankerCards && table.bankerCards.length > 0))) {
          const pPoints = getBaccaratValue(table.playerCards);
          const bPoints = getBaccaratValue(table.bankerCards);
          const pScoreText = `\x1b[94mP${pPoints}\x1b[0m`;
          const bScoreText = `\x1b[31mB${bPoints}\x1b[0m`;
          const coloredP = `\x1b[94mPlayer: [${(table.playerCards || []).join(", ")}]\x1b[0m`;
          const coloredB = `\x1b[31mBanker: [${(table.bankerCards || []).join(", ")}]\x1b[0m`;
          cardInfo = ` | ${pScoreText} vs ${bScoreText} | ${coloredP} ${coloredB}`;
        }
        const coloredPrev = colorizeState(prevState || "None");
        const coloredNew = colorizeState(newState);
        console.log(`[STATE] ${name}: ${coloredPrev} -> ${coloredNew} (Round ${newRound})${cardInfo}`);
      }

      // Dispatch generic state transitions
      if (newState !== prevState && !events.some(e => e.tableName === name)) {
        events.push({
          type: "STATE_CHANGE",
          tableName: name,
          tableState: ts,
          from: prevState,
          to: newState,
          round: newRound,
          deckRemaining: ts.remaining,
          deckComposition: [...ts.deckComposition],
        });
      }

      ts.state = newState;
      ts.round = newRound;
    }

    return events;
  }



  #resetShoe(ts, reason) {
    const roundInfo = (ts.round > 0 && !reason.includes("decreased from") && !reason.includes("reset from"))
      ? `, last round was ${ts.round}`
      : "";
    const msg = `[SHOE] ${ts.tableName}: Reset to fresh shoe (Reason: ${reason}${roundInfo})`;

    ts.deckComposition = freshShoe();
    ts.lastFinalizedRound = 0;
    ts.consecutiveZeroCardHands = 0;
    ts.lastEvResult = null;
    ts.currentBetId = null;
    ts.handHistory = [];
    ts.lastAlertedMismatchRound = null;
    ts.lastVerifiedMismatchRound = null;
    ts.lastWarnedEvRound = null;
    ts.lastWarnedMissedRound = null;

    if (isInvalidStateReset(reason)) {
      ts.lastErrorResetReason = reason;
      ts.lastErrorResetTime = Date.now();
    } else {
      ts.lastErrorResetReason = null;
      ts.lastErrorResetTime = null;
    }

    console.log(`\x1b[33m${msg}\x1b[0m`);

    if (isInvalidStateReset(reason)) {
      sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
    }
  }

  serialize() {
    const data = {};
    for (const [name, ts] of this.tables) {
      data[name] = {
        tableName: ts.tableName,
        tableId: ts.tableId,
        state: ts.state,
        round: ts.round,
        deckComposition: ts.deckComposition,
        lastFinalizedRound: ts.lastFinalizedRound,
        lastEvResult: ts.lastEvResult,
        currentBetId: ts.currentBetId,
        consecutiveZeroCardHands: ts.consecutiveZeroCardHands,
        lastErrorResetReason: ts.lastErrorResetReason,
        lastErrorResetTime: ts.lastErrorResetTime,
        handHistory: ts.handHistory,
        lastAlertedMismatchRound: ts.lastAlertedMismatchRound,
        lastVerifiedMismatchRound: ts.lastVerifiedMismatchRound,
        lastWarnedEvRound: ts.lastWarnedEvRound,
        lastWarnedMissedRound: ts.lastWarnedMissedRound,
      };
    }
    return data;
  }

  restore(data) {
    if (!data || typeof data !== "object") return;
    const normalizeCard = (c) => {
      if (!c || c === "null") return c;
      if (c.startsWith("10")) return "T" + c.slice(2);
      return c;
    };

    for (const [name, saved] of Object.entries(data)) {
      const ts = new TableState(name, saved.tableId || null);
      ts.state = saved.state || null;
      ts.round = saved.round || 0;
      ts.deckComposition = saved.deckComposition || freshShoe();
      ts.lastFinalizedRound = saved.lastFinalizedRound || saved.round || 0;
      ts.lastEvResult = saved.lastEvResult || null;
      ts.currentBetId = saved.currentBetId || null;
      ts.consecutiveZeroCardHands = saved.consecutiveZeroCardHands || 0;
      ts.lastErrorResetReason = saved.lastErrorResetReason || null;
      ts.lastErrorResetTime = saved.lastErrorResetTime || null;
      ts.lastAlertedMismatchRound = saved.lastAlertedMismatchRound || null;
      ts.lastVerifiedMismatchRound = saved.lastVerifiedMismatchRound || null;
      ts.lastWarnedEvRound = saved.lastWarnedEvRound || null;
      ts.lastWarnedMissedRound = saved.lastWarnedMissedRound || null;

      // Support restoring from old format (deducedBeadRoad) or new (handHistory)
      const rawHistory = saved.handHistory || saved.deducedBeadRoad || [];
      ts.handHistory = rawHistory.map(item => {
        if (item && typeof item === "object") {
          return {
            ...item,
            playerCards: (item.playerCards || []).map(normalizeCard),
            bankerCards: (item.bankerCards || []).map(normalizeCard)
          };
        }
        return item;
      });

      ts.restored = true;
      this.tables.set(name, ts);
    }
    console.log(`\x1b[36m[STATE] Restored ${this.tables.size} tables from saved state\x1b[0m`);
  }
}

module.exports = {
  TableStateManager,
  cardRankToIndex,
  freshShoe,
  deckRemaining
};
