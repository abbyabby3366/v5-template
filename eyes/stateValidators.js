/**
 * stateValidators.js
 * Extracted validation checks for the Baccarat Table State.
 * These functions evaluate the state and return an "Invalid state: ..." string reason 
 * if a shoe reset is required, or null if the state is valid.
 */

function checkTickValidations(ts, newRound, newState, prevState) {
  // 1. Validate restored state round drop
  if (ts.restored && newRound < ts.lastRound) {
    return `Stale state: round went from ${ts.lastRound} → ${newRound} after restore`;
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

  return null; // State is valid
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

module.exports = {
  checkTickValidations,
  checkWarningNeeded,
  checkImpossibleCard,
  checkGhostHands
};
