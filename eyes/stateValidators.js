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
  // 1. Mathematically invalid deck size or hard limit <= 16
  const minExpectedCards = 416 - ((newRound + 1) * 6);
  const adjustedMinCards = Math.max(0, minExpectedCards);

  if ((ts.remaining < adjustedMinCards || ts.remaining <= 16) && newState !== "Shuffling") {
    return `Invalid state: cards left (${ts.remaining}) critically low (<= 16) or < expected min (${adjustedMinCards}) for round ${newRound}`;
  }

  // 2. Hard Limit on Round Number (Mathematically improbable)
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
  return typeof state === "string" && state.startsWith("Result");
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
    const roundNumber = lastItem.round;
    if (roundNumber === statistics.length) {
      const serverCode = statistics[roundNumber - 1];
      const serverWinner = mapServerCodeToWinner(serverCode);

      if (serverWinner && lastItem.winner !== serverWinner) {
        let serverScore = "";
        if (serverCode && serverCode.includes('_')) {
          const parts = serverCode.split('_');
          if (parts[1]) {
            const clean = parts[1].replace(/[^0-9]/g, '');
            if (clean) serverScore = clean;
          }
        }

        const deducedScore = (lastItem.winPoints !== undefined && lastItem.winPoints !== null) ? String(lastItem.winPoints) : "";

        const deducedStr = deducedScore ? `${lastItem.winner}${deducedScore}` : lastItem.winner;
        const serverStr = serverScore ? `${serverWinner}${serverScore}` : serverWinner;

        return {
          mismatchFound: true,
          mismatchDetails: `Round ${roundNumber} mismatch: Deduced ${deducedStr} vs Server ${serverStr}`,
          mismatchRound: roundNumber
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

/**
 * Check if the restored state is stale (e.g. round drop after restore).
 * @returns {string|null} Reset reason if stale, or null
 */
function checkStaleRestoredState(ts, newRound) {
  if (ts.restored) {
    const roundDrop = newRound < ts.round;
    // Only flag as stale if newRound is a valid positive round number (e.g., > 0).
    // Drops to 0/null are expected when a new shoe starts or is shuffling.
    if (roundDrop && newRound > 0) {
      return `Invalid state: Stale state restored (saved R${ts.round} -> live R${newRound})`;
    }
  }
  return null;
}

/**
 * Detects if a new shoe was implicitly or explicitly started.
 * @returns {string|null} Reset reason if a new shoe is detected, or null
 */
function checkImplicitOrExplicitNewShoe(ts, newRound, newState, prevState, statistics) {
  // 1. If newState is "Shuffling", detect "Shuffling state detected" first
  if (newState === "Shuffling" && prevState !== "Shuffling") {
    return "Shuffling state detected";
  }

  const significantRoundDrop = newRound < ts.round - 1 && ts.round > 1;
  const shoeChangedByRound = newRound === 1 && ts.round > 1;

  const { forceReset, resetReason } = checkShoeResetNeeded(ts, newRound, newState, statistics);
  const isImplicitShuffle = significantRoundDrop || shoeChangedByRound;

  if (forceReset || isImplicitShuffle) {
    return resetReason || `Implicit shoe change detected (R${ts.round} -> R${newRound})`;
  }
  return null;
}

/**
 * Check if any rounds were missed (gap between last finalized and current live round).
 * @returns {boolean}
 */
function checkMissedRounds(ts, newRound) {
  return ts.lastFinalizedRound > 0 && newRound > ts.lastFinalizedRound + 1;
}

/**
 * Check if the round is already finalized in hand history.
 * @returns {boolean}
 */
function checkIsAlreadyFinalized(ts, newRound) {
  return !!(ts.handHistory && ts.handHistory.some(item => item && item.round === newRound));
}

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

/**
 * Processes hand cards, checking for impossible cards, ghost hands, and incorrect card counts.
 * Returns the validation outcome, card count, and updated deck composition.
 *
 * @param {number[]} currentComposition - The current deck composition [13 ranks]
 * @param {string[]} playerCards - Player cards array
 * @param {string[]} bankerCards - Banker cards array
 * @param {number} consecutiveZeroCardHands - Current consecutive zero-card hands
 * @param {number} round - Current round number
 * @returns {{
 *   corruptedReason: string|null,
 *   cardsSubtracted: number,
 *   newComposition: number[],
 *   nextConsecutiveZeroCardHands: number
 * }}
 */
function processAndValidateCards(currentComposition, playerCards, bankerCards, consecutiveZeroCardHands, round) {
  let cardsSubtracted = 0;
  let corruptedReason = null;
  const newComposition = [...currentComposition];
  const allCards = [...(playerCards || []), ...(bankerCards || [])];

  for (const card of allCards) {
    const idx = cardRankToIndex(card);
    if (idx >= 0) {
      const impReason = checkImpossibleCard(newComposition, idx, card);
      if (impReason && !corruptedReason) {
        corruptedReason = impReason;
      }
      if (newComposition[idx] > 0) {
        newComposition[idx]--;
      }
      cardsSubtracted++;
    }
  }

  let nextConsecutiveZeroCardHands = consecutiveZeroCardHands;
  if (cardsSubtracted === 0) {
    nextConsecutiveZeroCardHands++;
    const ghostReason = checkGhostHands(nextConsecutiveZeroCardHands);
    if (ghostReason && !corruptedReason) {
      corruptedReason = ghostReason;
    }
  } else {
    nextConsecutiveZeroCardHands = 0;
    const countReason = checkCardCount(cardsSubtracted, round);
    if (countReason && !corruptedReason) {
      corruptedReason = countReason;
    }
  }

  return {
    corruptedReason,
    cardsSubtracted,
    newComposition,
    nextConsecutiveZeroCardHands
  };
}

/**
 * Normalizes card names (e.g. converting '10S' to 'TS') for consistent key lookup.
 * @param {string} card 
 * @returns {string}
 */
function normalizeCardName(card) {
  if (!card) return "";
  let u = card.toUpperCase();
  if (u.startsWith("10")) {
    u = "T" + u.slice(2);
  }
  return u;
}

/**
 * Validates that no single card (rank + suit) appears more than 8 times in the shoe history.
 * @param {Array} handHistory - The completed hands history for the current shoe
 * @param {string[]} playerCards - Current hand's player cards
 * @param {string[]} bankerCards - Current hand's banker cards
 * @returns {string|null} Error reason if limit (> 8) is exceeded, or null if valid.
 */
function checkSpecificCardDepletion(handHistory, playerCards, bankerCards) {
  const cardCounts = {};

  const addAndVerify = (card) => {
    if (!card) return null;
    const normalized = normalizeCardName(card);
    if (!normalized) return null;

    cardCounts[normalized] = (cardCounts[normalized] || 0) + 1;
    if (cardCounts[normalized] > 8) {
      return `Invalid state: card ${normalized} appeared ${cardCounts[normalized]} times (exceeds 8-deck limit)`;
    }
    return null;
  };

  // 1. Process all cards from previous hands in the current shoe
  if (handHistory) {
    for (const hand of handHistory) {
      if (hand) {
        const allHandCards = [...(hand.playerCards || []), ...(hand.bankerCards || [])];
        for (const card of allHandCards) {
          const err = addAndVerify(card);
          if (err) return err;
        }
      }
    }
  }

  // 2. Process current hand cards
  const currentHandCards = [...(playerCards || []), ...(bankerCards || [])];
  for (const card of currentHandCards) {
    const err = addAndVerify(card);
    if (err) return err;
  }

  return null;
}

module.exports = {
  checkEventValidations,
  checkShoeResetNeeded,
  isResultState,
  checkImpossibleCard,
  checkGhostHands,
  checkCardCount,
  checkBeadRoadMismatch,
  isInvalidStateReset,
  checkStaleRestoredState,
  checkImplicitOrExplicitNewShoe,
  checkMissedRounds,
  checkIsAlreadyFinalized,
  cardRankToIndex,
  processAndValidateCards,
  normalizeCardName,
  checkSpecificCardDepletion,
};
