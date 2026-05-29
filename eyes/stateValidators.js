/**
 * stateValidators.js
 * Validation checks for the Baccarat Table State.
 * Pure check functions — no side effects, no mutations.
 */

/**
 * Check if a shoe reset is needed based on event validations.
 * @returns {string|null} Reset reason, or null if valid
 */
function checkEventValidations(ts, newRound, newState, prevState) {
  // 1. Validate restored state round drop
  if (ts.restored && newRound < ts.round) {
    return `Stale state: round went from ${ts.round} → ${newRound} after restore`;
  }

  // 2. Recorded hands significantly ahead of UI round
  if (ts.handNumber >= newRound + 3 && newRound > 0) {
    return `Invalid state: recorded hands (${ts.handNumber}) >= table round + 3 (${newRound + 3})`;
  }

  // 3. Mathematically invalid deck size or hard limit <= 16
  const effectiveRound = Math.max(newRound, ts.handNumber);
  const minExpectedCards = 416 - ((effectiveRound + 1) * 6);
  const adjustedMinCards = Math.max(0, minExpectedCards);

  if ((ts.remaining < adjustedMinCards || ts.remaining <= 16) && newState !== "Shuffling") {
    return `Invalid state: cards left (${ts.remaining}) critically low (<= 16) or < expected min (${adjustedMinCards}) for round ${newRound}`;
  }

  // 4. Hard Limit on Round Number (Mathematically improbable)
  if (newRound > 90 && newState !== "Shuffling") {
    return `Invalid state: round number (${newRound}) mathematically exceeds standard 8-deck shoe (> 90)`;
  }

  return null;
}

/**
 * Check if a forced shoe reset is needed (round drop or empty statistics).
 * @returns {{ forceReset: boolean, resetReason: string }}
 */
function checkShoeResetNeeded(ts, newRound, newState, statistics) {
  if (newRound === 1 && ts.round > 1) {
    return { forceReset: true, resetReason: `Round number decreased from ${ts.round} to 1` };
  }
  if (statistics && statistics.length === 0 && ts.round > 1 && newState !== "Shuffling") {
    return { forceReset: true, resetReason: "Shuffling detected" };
  }
  return { forceReset: false, resetReason: "" };
}

/**
 * Check if a state is a Result state.
 * @param {string} state
 * @returns {boolean}
 */
function isResultState(state) {
  return state === "Result" || state === "Result (Player Win)" || state === "Result (Banker Win)" || state === "Result (Tie Win)";
}

function checkWarningNeeded(ts, newRound) {
  return (ts.handNumber >= newRound + 2 && newRound > 0 && ts.handNumber < newRound + 3);
}

function checkImpossibleCard(deckComposition, rankIdx, cardName) {
  if (rankIdx >= 0 && deckComposition[rankIdx] <= 0) {
    return `Invalid state: mathematically impossible extra card detected (${cardName.toUpperCase()})`;
  }
  return null;
}

function checkGhostHands(consecutiveZeroCardHands) {
  if (consecutiveZeroCardHands >= 3) {
    return `Invalid state: 3 consecutive ghost hands (0 cards dealt) detected`;
  }
  return null;
}

/**
 * Validate card count for a completed hand (must be 4-6 cards).
 * @returns {string|null} Corruption reason, or null if valid
 */
function checkCardCount(cardsSubtracted, round) {
  if (cardsSubtracted < 4 || cardsSubtracted > 6) {
    return `Invalid state: mathematically impossible cards count (${cardsSubtracted}) for round ${round}`;
  }
  return null;
}

// ─── Server Code → Winner Letter ─────────────────────────────────────────
function mapServerCodeToWinner(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.startsWith('p')) return 'P';
  if (c.startsWith('b')) return 'B';
  if (c.startsWith('t')) return 'T';
  return null;
}

/**
 * Verify only the latest deduced hand history outcome matches server statistics.
 * @returns {{ mismatchFound: boolean, mismatchDetails: string, mismatchRound: number }}
 */
function checkBeadRoadMismatch(handHistory, statistics) {
  if (!handHistory?.length || !statistics?.length) {
    return { mismatchFound: false, mismatchDetails: "", mismatchRound: 0 };
  }

  // Check only the latest completed hand in history
  const lastItem = handHistory[handHistory.length - 1];
  if (lastItem && typeof lastItem === "object") {
    const rNum = lastItem.round;
    if (rNum <= statistics.length) {
      const serverCode = statistics[rNum - 1];
      const serverWinner = mapServerCodeToWinner(serverCode);

      if (serverWinner && lastItem.winner !== serverWinner) {
        return {
          mismatchFound: true,
          mismatchDetails: `Round ${rNum} mismatch: Deduced ${lastItem.winner} vs Server ${serverWinner}`,
          mismatchRound: rNum
        };
      }
    }
  }

  return { mismatchFound: false, mismatchDetails: "", mismatchRound: 0 };
}

/**
 * Classify whether a shoe reset reason indicates an invalid/corrupted state.
 * @param {string} reason
 * @returns {boolean}
 */
function isInvalidStateReset(reason) {
  return !!(reason && reason.startsWith("Invalid state"));
}

module.exports = {
  checkEventValidations,
  checkShoeResetNeeded,
  isResultState,
  checkWarningNeeded,
  checkImpossibleCard,
  checkGhostHands,
  checkCardCount,
  checkBeadRoadMismatch,
  isInvalidStateReset,
};
