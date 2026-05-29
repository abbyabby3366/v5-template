/**
 * tableStateManager.js — Per-table state tracking for Pretty Gaming lobby
 *
 * Tracks state transitions, deck composition, and card history for each table.
 * Detects state changes that trigger EV recalculation using clean, server-provided network telemetry.
 *
 * 13-slot composition: [A, 2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K]
 * Each slot = remaining count for that rank across all suits in the shoe.
 */

const { sendWhatsAppNotification } = require('../utils/whatsapp_notifier');
const { checkTickValidations, checkWarningNeeded, checkImpossibleCard, checkGhostHands } = require('./stateValidators');
function mapServerCodeToWinner(code) {
  if (!code) return null;
  if (code.startsWith('p')) return 'P';
  if (code.startsWith('b')) return 'B';
  if (code.startsWith('t')) return 'T';
  return null;
}

// ─── Card Name → 13-slot Rank Index ─────────────────────────────────────
// Index: 0=A, 1=2, 2=3, 3=4, 4=5, 5=6, 6=7, 7=8, 8=9, 9=T, 10=J, 11=Q, 12=K

function cardRankToIndex(cardName) {
  if (!cardName || cardName === "Red") return -1;

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

// ─── Per-Table State ─────────────────────────────────────────────────────

class TableState {
  constructor(tableName) {
    this.tableName = tableName;
    this.lastState = null;
    this.lastRound = 0;
    this.deckComposition = freshShoe(); // 13-slot
    this.handNumber = 0;
    this.lastFinalizedRound = 0;
    this.lastPlayerCards = [];
    this.lastBankerCards = [];
    this.lastEvResult = null;
    this.bufferedCards = { player: [], banker: [] };
    this.currentBetId = null;
    this.restored = false;
    this.hasWarnedAhead = false;
    this.consecutiveZeroCardHands = 0;
    this.handFinalizedForCycle = false;
    this.lastErrorResetReason = null;
    this.lastErrorResetTime = null;
    this.deducedBeadRoad = [];
  }

  get remaining() {
    return deckRemaining(this.deckComposition);
  }
}

// ─── State Manager ───────────────────────────────────────────────────────

class TableStateManager {
  constructor() {
    /** @type {Map<string, TableState>} */
    this.tables = new Map();
    this.lastResetNotificationTime = new Map();
  }

  /**
   * Update all table states from a scrape tick.
   * @param {Array} tableDataArray - Array of table objects from the new memory scraper
   * @returns {Array} - List of state-change events that need EV recalculation
   */
  update(tableDataArray) {
    const events = [];

    for (const table of tableDataArray) {
      const name = table.tableName;
      if (!this.tables.has(name)) {
        this.tables.set(name, new TableState(name));
      }
      const ts = this.tables.get(name);
      const prevState = ts.lastState;
      const newState = table.state;
      let newRound = table.round;

      // If a new shoe has officially started (round 1), clear the deduced bead road
      if (newRound === 1 && ts.lastRound !== 1) {
        ts.deducedBeadRoad = [];
      }
      // ── Verify deduced outcomes match server statistics history ──
      if (ts.deducedBeadRoad && ts.deducedBeadRoad.length > 0 && table.statistics && table.statistics.length > 0) {
        let mismatchFound = false;
        let mismatchDetails = "";

        for (const item of ts.deducedBeadRoad) {
          if (item && typeof item === 'object') {
            const rNum = item.round;
            if (rNum <= table.statistics.length) {
              const serverCode = table.statistics[rNum - 1];
              const serverWinner = mapServerCodeToWinner(serverCode);

              if (serverWinner && item.winner !== serverWinner) {
                mismatchFound = true;
                mismatchDetails = `Round ${rNum} mismatch: Deduced ${item.winner} vs Server ${serverWinner}`;
                break;
              }
            }
          }
        }

        if (mismatchFound) {
          const now = Date.now();
          const rateLimitKey = `${ts.tableName}:mismatch:${mismatchDetails}`;
          const lastSent = this.lastResetNotificationTime ? (this.lastResetNotificationTime.get(rateLimitKey) || 0) : 0;
          const isSpam = (now - lastSent) < 5 * 60 * 1000; // 5 min rate limit

          const msg = `[WARNING] ${ts.tableName} Bead Road Discrepancy! ${mismatchDetails}`;
          if (!isSpam) {
            console.log(`\x1b[31m${msg}\x1b[0m`);
            sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
            if (this.lastResetNotificationTime) {
              this.lastResetNotificationTime.set(rateLimitKey, now);
            }
          }
          
          // Do not auto-clear to allow dashboard visualization of the mismatch.
        }
      }



      // ── Bulletproof Shoe Reset Fallbacks (e.g. if we missed "Shuffling" state transition) ──
      let forceReset = false;
      let resetReason = "";

      if (newRound === 1 && ts.lastRound > 10) {
        forceReset = true;
        resetReason = `Round number decreased from ${ts.lastRound} to 1`;
      } else if (table.statistics && table.statistics.length === 0 && ts.lastRound > 1 && newState !== "Shuffling") {
        forceReset = true;
        resetReason = "Shuffling detected";
      }

      // ── Reset shoe instantly on Shuffling state or Fallback Triggers ──
      if (forceReset || (newState === "Shuffling" && prevState !== "Shuffling")) {
        const reason = resetReason || "Shuffling state detected";
        this._resetShoe(ts, reason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: reason,
          isActualShuffle: true,
          finalRound: ts.lastRound
        });
        ts.lastState = newState;
        ts.lastRound = 0; // Prevent second trigger when newRound transitions to 1 in the next tick
        continue;
      }

      // ── Process hand completion cleanly when server transitions to Result ──
      const isResultState = newState.startsWith("Result");
      const isAlreadyFinalized = ts.deducedBeadRoad && ts.deducedBeadRoad.some(item => item && item.round === newRound);
      const hasCards = (table.playerCards && table.playerCards.length > 0) || (table.bankerCards && table.bankerCards.length > 0);
      if (isResultState && newRound > ts.lastFinalizedRound && newRound > 0 && hasCards) {
        if (isAlreadyFinalized) {
          const msg = `[WARNING] ${ts.tableName}: Double-deduction attempt guarded for completed round ${newRound}! Round already present in deduced bead road.`;
          const rateLimitKey = `${ts.tableName}:double_deduct:${newRound}`;
          const now = Date.now();
          const lastSent = this.lastResetNotificationTime ? (this.lastResetNotificationTime.get(rateLimitKey) || 0) : 0;
          const isSpam = (now - lastSent) < 5 * 60 * 1000;

          if (!isSpam) {
            console.log(`\x1b[31m${msg}\x1b[0m`);
            sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
            if (this.lastResetNotificationTime) {
              this.lastResetNotificationTime.set(rateLimitKey, now);
            }
          }
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
            if ((cardsSubtracted < 4 || cardsSubtracted > 6) && !corruptedReason) {
              corruptedReason = `Invalid state: mathematically impossible cards count (${cardsSubtracted}) for completed round ${newRound}`;
            }
          }

          ts.handNumber++;
          ts.lastPlayerCards = table.playerCards.slice();
          ts.lastBankerCards = table.bankerCards.slice();
          ts.lastFinalizedRound = newRound;

          if (corruptedReason) {
            this._resetShoe(ts, corruptedReason);
            events.push({
              type: "SHOE_RESET",
              tableName: name,
              reason: corruptedReason,
              finalRound: ts.lastRound
            });
          } else {
            if (table.winner) {
              ts.deducedBeadRoad.push({ 
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

      // ── External Validations ──
      const tickInvalidReason = checkTickValidations(ts, newRound, newState, prevState);

      if (ts.restored) {
        ts.restored = false;
        if (!tickInvalidReason && newRound >= ts.lastRound) {
          console.log(`\x1b[36m[STATE] ${name}: Validated (saved R${ts.lastRound} → live R${newRound})\x1b[0m`);
        }
      }

      if (tickInvalidReason) {
        this._resetShoe(ts, tickInvalidReason);
        events.push({
          type: "SHOE_RESET",
          tableName: name,
          reason: tickInvalidReason,
          finalRound: ts.lastRound
        });
      } else {
        if (checkWarningNeeded(ts, newRound)) {
          if (!ts.hasWarnedAhead) {
            const msg = `[WARNING] ${name}: recorded hands (${ts.handNumber}) is ahead of table UI round (${newRound}). Awaiting correction.`;
            console.log(`\x1b[33m${msg}\x1b[0m`);
            sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
            ts.hasWarnedAhead = true;
          }
        } else if (ts.handNumber <= newRound) {
          ts.hasWarnedAhead = false;
        }
      }

      // ── Dispatch generic state transitions ──
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

      ts.lastState = newState;
      ts.lastRound = newRound;
    }

    return events;
  }

  _resetShoe(ts, reason) {
    // Append the last round if not already mentioned in the reason
    const roundInfo = (ts.lastRound > 0 && !reason.includes("decreased from") && !reason.includes("reset from"))
      ? `, last round was ${ts.lastRound}`
      : '';
    const msg = `[SHOE] ${ts.tableName}: Reset to fresh shoe (Reason: ${reason}${roundInfo})`;
    const rateLimitKey = `${ts.tableName}:${reason}`;
    const now = Date.now();
    const lastSent = this.lastResetNotificationTime ? (this.lastResetNotificationTime.get(rateLimitKey) || 0) : 0;
    const isSpam = (now - lastSent) < 15 * 60 * 1000;

    ts.deckComposition = freshShoe();
    ts.handNumber = 0;
    ts.lastFinalizedRound = 0;
    ts.hasWarnedAhead = false;
    ts.consecutiveZeroCardHands = 0;
    ts.handFinalizedForCycle = false;
    ts.bufferedCards = { player: [], banker: [] };
    ts.lastPlayerCards = [];
    ts.lastBankerCards = [];
    ts.lastEvResult = null;
    
    // Clear deduced road on manual resets, fresh shoe commands, shuffles, or server stats resets
    if (reason && (
      reason.includes("Manual reset") ||
      reason.includes("fresh shoe") ||
      reason.includes("starting fresh") ||
      reason.includes("Server statistics") ||
      reason.includes("Shuffling") ||
      reason.includes("Fresh round")
    )) {
      ts.deducedBeadRoad = [];
    }
    
    if (reason && reason.startsWith('Invalid state')) {
      ts.lastErrorResetReason = reason;
      ts.lastErrorResetTime = Date.now();
    } else {
      ts.lastErrorResetReason = null;
      ts.lastErrorResetTime = null;
    }

    if (!isSpam) {
      console.log(`\x1b[33m${msg}\x1b[0m`);
    }
    
    if (reason.startsWith('Invalid state')) {
      if (!isSpam) {
        sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
        if (this.lastResetNotificationTime) {
          this.lastResetNotificationTime.set(rateLimitKey, now);
        }
      }
    }
  }

  getTable(tableName) {
    return this.tables.get(tableName) || null;
  }

  serialize() {
    const data = {};
    for (const [name, ts] of this.tables) {
      data[name] = {
        tableName: ts.tableName,
        lastState: ts.lastState,
        lastRound: ts.lastRound,
        deckComposition: ts.deckComposition,
        handNumber: ts.handNumber,
        lastFinalizedRound: ts.lastFinalizedRound,
        lastPlayerCards: ts.lastPlayerCards,
        lastBankerCards: ts.lastBankerCards,
        lastEvResult: ts.lastEvResult,
        bufferedCards: ts.bufferedCards,
        currentBetId: ts.currentBetId,
        consecutiveZeroCardHands: ts.consecutiveZeroCardHands,
        lastErrorResetReason: ts.lastErrorResetReason,
        lastErrorResetTime: ts.lastErrorResetTime,
        deducedBeadRoad: ts.deducedBeadRoad,
      };
    }
    return data;
  }

  restore(data) {
    if (!data || typeof data !== "object") return;
    const normalizeCard = (c) => {
      if (!c || c === "null" || c === "Red") return c;
      if (c.startsWith("10")) return "T" + c.slice(2);
      return c;
    };

    for (const [name, saved] of Object.entries(data)) {
      const ts = new TableState(name);
      ts.lastState = saved.lastState || null;
      ts.lastRound = saved.lastRound || 0;
      ts.deckComposition = saved.deckComposition || freshShoe();
      ts.handNumber = saved.handNumber || 0;
      ts.lastFinalizedRound = saved.lastFinalizedRound || saved.lastRound || 0;
      ts.lastPlayerCards = (saved.lastPlayerCards || []).map(normalizeCard);
      ts.lastBankerCards = (saved.lastBankerCards || []).map(normalizeCard);
      ts.lastEvResult = saved.lastEvResult || null;
      ts.bufferedCards = saved.bufferedCards || { player: [], banker: [] };
      ts.currentBetId = saved.currentBetId || null;
      ts.consecutiveZeroCardHands = saved.consecutiveZeroCardHands || 0;
      ts.lastErrorResetReason = saved.lastErrorResetReason || null;
      ts.lastErrorResetTime = saved.lastErrorResetTime || null;
      
      ts.deducedBeadRoad = (saved.deducedBeadRoad || []).map(item => {
        if (item && typeof item === 'object') {
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

module.exports = { TableStateManager, cardRankToIndex, freshShoe, deckRemaining };
