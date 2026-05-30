/**
 * statePersistence.js — Handles loading, saving and formatting table states
 */

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "json");
fs.mkdirSync(STATE_DIR, { recursive: true });

const STATE_FILE = path.join(STATE_DIR, "eyes_state.json");
const DASHBOARD_FILE = path.join(STATE_DIR, "tables_state.json");

/**
 * Renames a file using a simple copy/delete fallback strategy if Windows file locks (EPERM / EBUSY) prevent standard renaming.
 */
function safeRename(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "ENOENT") {
      try {
        if (fs.existsSync(src)) {
          const data = fs.readFileSync(src);
          fs.writeFileSync(dest, data);
          try {
            fs.unlinkSync(src);
          } catch (unlinkErr) {
            // Ignore temporary file cleanup failure since the main write succeeded
          }
        }
      } catch (fallbackErr) {
        console.error(`[STATE] safeRename fallback failed: ${fallbackErr.message}`);
      }
    } else {
      throw err;
    }
  }
}

/**
 * Load saved table state from disk.
 * @param {object} stateManager - TableStateManager instance
 * @param {Array} eventLog - In-memory event log reference
 * @param {number} maxAgeMin - Staleness limit in minutes
 */
function loadState(stateManager, eventLog, maxAgeMin = 60) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const savedAt = raw.savedAt ? new Date(raw.savedAt).getTime() : 0;
      const ageMs = Date.now() - savedAt;
      const ageMin = Math.round(ageMs / 60000);

      if (ageMs > maxAgeMin * 60 * 1000) {
        console.log(`\x1b[33m[STATE] Saved state is ${ageMin}min old (>${maxAgeMin}min), starting fresh.\x1b[0m`);
        return;
      }

      console.log(`\x1b[36m[STATE] State is ${ageMin}min old, restoring...\x1b[0m`);
      stateManager.restore(raw.tables || {});

      if (raw.eventLog && Array.isArray(raw.eventLog)) {
        eventLog.length = 0; // Clear
        eventLog.push(...raw.eventLog);
      }
    }
  } catch (e) {
    console.log(`[STATE] No saved state found or corrupted, starting fresh.`);
  }
}

/**
 * Save current table state to disk (synchronous).
 * @param {object} stateManager - TableStateManager instance
 * @param {Array} eventLog - In-memory event log reference
 */
function saveState(stateManager, eventLog) {
  try {
    const tmpFile = STATE_FILE + ".tmp";
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        tables: stateManager.serialize(),
        eventLog: eventLog,
      })
    );
    safeRename(tmpFile, STATE_FILE);
  } catch (e) {
    // Silent fail
  }
}

/**
 * Writes the tables_state.json for dashboard usage.
 */
async function writeDashboardJson(tables, stateManager, timestamp, events, allScrapedTables = [], ignoredTables = [], dynamicConfig = {}, eventLog = []) {
  const stateSnapshot = tables.map((table) => {
    const ts = stateManager.getTable(table.tableName);
    const deck = ts?.deckComposition;

    return {
      tableName: table.tableName,
      tableId: ts?.tableId ?? null,
      state: table.state,
      timer: table.timer,
      round: table.round,
      wins: table.wins,
      previousState: ts?.state ?? null,
      deckRemaining: ts?.remaining ?? null,
      deckComposition: deck ?? null,
      deckLabelled: deck ? Object.fromEntries(
        ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"].map((r, i) => [r, deck[i]])
      ) : null,
      lastPlayerCards: ts?.lastHand?.playerCards ?? [],
      lastBankerCards: ts?.lastHand?.bankerCards ?? [],
      lastErrorResetReason: ts?.lastErrorResetReason ?? null,
      lastErrorResetTime: ts?.lastErrorResetTime ?? null,
      deducedBeadRoad: ts?.handHistory ?? [],
      sourceBeadRoad: table.statistics ?? [],
      ev: ts?.lastEvResult ? {
        player: { ev: ts.lastEvResult.ev_player, evBase: ts.lastEvResult.ev_player_base, prob: ts.lastEvResult.p_player },
        banker: { ev: ts.lastEvResult.ev_banker, evBase: ts.lastEvResult.ev_banker_base, prob: ts.lastEvResult.p_banker },
        tie: { ev: ts.lastEvResult.ev_tie, prob: ts.lastEvResult.p_tie },
        rebate: ts.lastEvResult.rebate,
        best: ts.lastEvResult.best,
      } : null
    };
  });

  const eventsSummary = events.map((e) => ({
    type: e.type,
    tableName: e.tableName,
    ...(e.winner ? { winner: e.winner } : {}),
    ...(e.cardsSubtracted ? { cardsSubtracted: e.cardsSubtracted } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
  }));

  const payload = {
    timestamp,
    totalTables: stateSnapshot.length,
    config: {
      minEvThreshold: dynamicConfig.minEvThreshold !== undefined ? parseFloat(dynamicConfig.minEvThreshold) : 0.0003,
      rebateRate: dynamicConfig.rebateRate !== undefined ? parseFloat(dynamicConfig.rebateRate) : 0.012,
    },
    allScrapedTables,
    ignoredTables,
    eventsThisTick: eventsSummary,
    eventLog: eventLog,
    tables: stateSnapshot,
  };

  try {
    const tmpFile = DASHBOARD_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    safeRename(tmpFile, DASHBOARD_FILE);
  } catch (e) {
    console.error(`[STATE] Failed to write tables_state.json: ${e.message}`);
  }

  // Push to Central Server via WebSockets (using dynamic import to prevent circular dependency)
  try {
    const { sendStateOverWS } = require("./runEyes");
    sendStateOverWS(payload);
  } catch (err) {
    // Ignore quietly
  }
}

module.exports = {
  loadState,
  saveState,
  writeDashboardJson,
};
