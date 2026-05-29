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
  checkShoeResetNeeded,
  isResultState,
  checkWarningNeeded,
  checkImpossibleCard,
  checkGhostHands,
  checkCardCount,
  checkBeadRoadMismatch,
  isInvalidStateReset,
} = require("./stateValidators");

// ─── Card Name → 13-slot Rank Index ─────────────────────────────────────
// Index: 0=A, 1=2, 2=3, 3=4, 4=5, 5=6, 6=7, 7=8, 8=9, 9=T, 10=J, 11=Q, 12=K
function cardRankToIndex(cardName) {
  if (!cardName) return -1;
  const rank = cardName.slice(0, -1).toUpperCase();

  switch (rank) {
    case "A":  return 0;
    case "2":  return 1;
    case "3":  return 2;
    case "4":  return 3;
    case "5":  return 4;
    case "6":  return 5;
    case "7":  return 6;
    case "8":  return 7;
    case "9":  return 8;
    case "10":
    case "T":  return 9;
    case "J":  return 10;
    case "Q":  return 11;
    case "K":  return 12;
    default:   return -1;
  }
}

// ─── Fresh 8-Deck Shoe ──────────────────────────────────────────────────
// Each rank × 4 suits × 8 decks = 32 cards per rank slot. Total = 416.
function freshShoe() {
  return [32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32];
}

function deckRemaining(composition) {
  return composition.reduce((a, b) => a + b, 0);
}

class TableState {
  constructor(tableName, tableId = null) {
    this.tableName = tableName;
    this.tableId = tableId;
    this.roundId = null;
    this.state = null;
    this.round = 0;
    this.deckComposition = freshShoe();
    this.handNumber = 0;
    this.lastFinalizedRound = 0;
    this.lastEvResult = null;
    this.currentBetId = null;
    this.restored = false;
    this.hasWarnedAhead = false;
    this.consecutiveZeroCardHands = 0;
    this.lastErrorResetReason = null;
    this.lastErrorResetTime = null;
    this.handHistory = [];
    this.lastAlertedMismatchRound = null;
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
    this.lastResetNotificationTime = new Map();
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
      const newRoundId = table.roundId || null;

      // Update tableId if provided
      if (table.tableId) ts.tableId = table.tableId;

      // 1. Handle stale restored state
      if (ts.restored) {
        ts.restored = false;
        const roundIdMismatch = ts.roundId && newRoundId && ts.roundId !== newRoundId;
        const roundDrop = newRound < ts.round;
        if (roundDrop || roundIdMismatch) {
          const reason = `Invalid state: Stale state restored (saved R${ts.round}/ID ${ts.roundId || "N/A"} -> live R${newRound}/ID ${newRoundId || "N/A"})`;
          this.#resetShoe(ts, reason);
          events.push({
            type: "SHOE_RESET",
            tableName: name,
            reason: reason,
            finalRound: ts.round
          });
          ts.state = newState;
          ts.round = newRound;
          if (newRoundId) ts.roundId = newRoundId;
          continue;
        } else {
          console.log(`\x1b[36m[STATE] ${name}: Validated restored state (saved R${ts.round} → live R${newRound})\x1b[0m`);
        }
      }

      // 2. Detect implicit or explicit new shoe
      const significantRoundDrop = newRound < ts.round - 1 && ts.round > 1;
      const shoeChangedByRound = newRound === 1 && ts.round > 1;
      const shoeChangedByRoundId = newRoundId && ts.roundId && newRoundId !== ts.roundId && newRound <= 1;

      const { forceReset, resetReason } = checkShoeResetNeeded(ts, newRound, newState, table.statistics);
      const isImplicitShuffle = significantRoundDrop || shoeChangedByRound || shoeChangedByRoundId;

      if (forceReset || isImplicitShuffle || (newState === "Shuffling" && prevState !== "Shuffling")) {
        const reason = resetReason || (newState === "Shuffling" ? "Shuffling state detected" : `Implicit shoe change detected (R${ts.round} -> R${newRound})`);
        this.#resetShoe(ts, reason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: reason,
          isActualShuffle: true,
          finalRound: ts.round
        });
        ts.state = newState;
        ts.round = newRound;
        if (newRoundId) ts.roundId = newRoundId;
        ts.handHistory = [];
        continue;
      }

      // 3. Prevent minor out-of-order round backwards drops
      if (newRound < ts.round) {
        console.warn(`\x1b[33m[STATE] ${name}: Stale/out-of-order round drop ignored (live R${newRound} < current R${ts.round})\x1b[0m`);
        continue;
      }

      // Update roundId tracking
      if (newRoundId) ts.roundId = newRoundId;

      // Verify hand history outcomes match server statistics
      const { mismatchFound, mismatchDetails, mismatchRound } = checkBeadRoadMismatch(ts.handHistory, table.statistics);
      if (mismatchFound && ts.lastAlertedMismatchRound !== mismatchRound) {
        const msg = `[WARNING] ${ts.tableName} Hand History Discrepancy! ${mismatchDetails}`;
        console.log(`\x1b[31m${msg}\x1b[0m`);
        sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
        ts.lastAlertedMismatchRound = mismatchRound;
      }

      // 4. Missed Round (Gap) Detection
      if (ts.lastFinalizedRound > 0 && newRound > ts.lastFinalizedRound + 1) {
        console.warn(`\x1b[33m[STATE] ${name}: Missed round(s) detected between last finalized R${ts.lastFinalizedRound} and live R${newRound}. Continuing as requested...\x1b[0m`);
      }

      // Process hand completion when server transitions to Result
      const isAlreadyFinalized = ts.handHistory?.some(item => item && item.round === newRound);
      const hasCards = (table.playerCards?.length > 0) || (table.bankerCards?.length > 0);

      if (isResultState(newState) && newRound > ts.lastFinalizedRound && newRound > 0 && hasCards) {
        if (isAlreadyFinalized) {
          this.#rateLimitedWarning(
            `${ts.tableName}:double_deduct:${newRound}`,
            `[WARNING] ${ts.tableName}: Double-deduction attempt guarded for completed round ${newRound}!`
          );
        } else {
          // Extract cards and subtract them from deck composition
          let cardsSubtracted = 0;
          let corruptedReason = null;
          const allCards = [...table.playerCards, ...table.bankerCards];

          for (const card of allCards) {
            const idx = cardRankToIndex(card);
            if (idx >= 0) {
              const impReason = checkImpossibleCard(ts.deckComposition, idx, card);
              if (impReason && !corruptedReason) {
                corruptedReason = impReason;
              }
              if (ts.deckComposition[idx] > 0) {
                ts.deckComposition[idx]--;
              }
              cardsSubtracted++;
            }
          }

          if (cardsSubtracted === 0) {
            ts.consecutiveZeroCardHands++;
            const ghostReason = checkGhostHands(ts.consecutiveZeroCardHands);
            if (ghostReason && !corruptedReason) {
              corruptedReason = ghostReason;
            }
          } else {
            ts.consecutiveZeroCardHands = 0;
            const countReason = checkCardCount(cardsSubtracted, newRound);
            if (countReason && !corruptedReason) {
              corruptedReason = countReason;
            }
          }

          ts.handNumber++;
          ts.lastFinalizedRound = newRound;

          if (corruptedReason) {
            this.#resetShoe(ts, corruptedReason);
            events.push({
              type: "SHOE_RESET",
              tableName: name,
              reason: corruptedReason,
              finalRound: ts.round
            });
          } else {
            if (table.winner) {
              ts.handHistory.push({
                round: newRound,
                winner: table.winner,
                playerCards: table.playerCards || [],
                bankerCards: table.bankerCards || []
              });
            }

            events.push({
              type: "HAND_COMPLETE",
              tableName: name,
              tableState: ts,
              handNumber: ts.handNumber,
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
      } else {
        if (checkWarningNeeded(ts, newRound)) {
          if (!ts.hasWarnedAhead) {
            const msg = `[WARNING] ${name}: recorded hands (${ts.handNumber}) is ahead of table UI round (${newRound}). Awaiting correction.`;
            this.#rateLimitedWarning(`${ts.tableName}:ahead_warning`, msg, 10 * 60 * 1000);
            ts.hasWarnedAhead = true;
          }
        } else if (ts.handNumber <= newRound) {
          ts.hasWarnedAhead = false;
        }
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

  #rateLimitedWarning(rateLimitKey, msg, cooldownMs = 5 * 60 * 1000) {
    const now = Date.now();
    const lastSent = this.lastResetNotificationTime.get(rateLimitKey) || 0;
    if (now - lastSent >= cooldownMs) {
      console.log(`\x1b[31m${msg}\x1b[0m`);
      sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
      this.lastResetNotificationTime.set(rateLimitKey, now);
    }
  }

  #resetShoe(ts, reason) {
    const roundInfo = (ts.round > 0 && !reason.includes("decreased from") && !reason.includes("reset from"))
      ? `, last round was ${ts.round}`
      : "";
    const msg = `[SHOE] ${ts.tableName}: Reset to fresh shoe (Reason: ${reason}${roundInfo})`;

    ts.deckComposition = freshShoe();
    ts.handNumber = 0;
    ts.lastFinalizedRound = 0;
    ts.hasWarnedAhead = false;
    ts.consecutiveZeroCardHands = 0;
    ts.lastEvResult = null;
    ts.handHistory = [];
    ts.lastAlertedMismatchRound = null;

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
        roundId: ts.roundId,
        state: ts.state,
        round: ts.round,
        deckComposition: ts.deckComposition,
        handNumber: ts.handNumber,
        lastFinalizedRound: ts.lastFinalizedRound,
        lastEvResult: ts.lastEvResult,
        currentBetId: ts.currentBetId,
        consecutiveZeroCardHands: ts.consecutiveZeroCardHands,
        lastErrorResetReason: ts.lastErrorResetReason,
        lastErrorResetTime: ts.lastErrorResetTime,
        handHistory: ts.handHistory,
        hasWarnedAhead: ts.hasWarnedAhead,
        lastAlertedMismatchRound: ts.lastAlertedMismatchRound,
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
      ts.roundId = saved.roundId || null;
      ts.state = saved.state || saved.lastState || null;
      ts.round = saved.round || saved.lastRound || 0;
      ts.deckComposition = saved.deckComposition || freshShoe();
      ts.handNumber = saved.handNumber || 0;
      ts.lastFinalizedRound = saved.lastFinalizedRound || saved.round || saved.lastRound || 0;
      ts.lastEvResult = saved.lastEvResult || null;
      ts.currentBetId = saved.currentBetId || null;
      ts.consecutiveZeroCardHands = saved.consecutiveZeroCardHands || 0;
      ts.lastErrorResetReason = saved.lastErrorResetReason || null;
      ts.lastErrorResetTime = saved.lastErrorResetTime || null;
      ts.hasWarnedAhead = saved.hasWarnedAhead || false;
      ts.lastAlertedMismatchRound = saved.lastAlertedMismatchRound || null;

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
