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
 * Renames a file using a retry loop and fallback strategy to handle Windows locking (EPERM / EBUSY).
 * If all retries fail, it falls back to a synchronous read/write to overwrite the destination.
 */
function safeRenameSync(src, dest, retries = 5, delay = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EBUSY") {
        if (i === retries - 1) {
          // Last retry failed, perform fallback copy/write operation
          try {
            const data = fs.readFileSync(src);
            fs.writeFileSync(dest, data);
            fs.unlinkSync(src);
            return;
          } catch (fallbackErr) {
            throw new Error(`safeRenameSync fallback failed: ${fallbackErr.message} (original error: ${err.message})`);
          }
        }
        // Synchronous sleep using high-resolution busy loop
        const start = Date.now();
        while (Date.now() - start < delay) {}
      } else {
        throw err;
      }
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
 * Save current table state to disk.
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
    safeRenameSync(tmpFile, STATE_FILE);
  } catch (e) {
    // Silent fail
  }
}

function mapTableToSnapshot(table, stateManager) {
  const ts = stateManager.getTable(table.tableName);
  const lastHand = ts ? ts.lastHand : null;
  return {
    tableName: table.tableName,
    tableId: ts ? ts.tableId : null,
    roundId: ts ? ts.roundId : null,
    state: table.state,
    timer: table.timer,
    round: table.round,
    wins: table.wins,
    previousState: ts ? ts.state : null,
    handNumber: ts ? ts.handNumber : 0,
    deckRemaining: ts ? ts.remaining : 416,
    deckComposition: ts ? ts.deckComposition : null,
    deckLabelled: ts ? {
      A: ts.deckComposition[0],
      "2": ts.deckComposition[1],
      "3": ts.deckComposition[2],
      "4": ts.deckComposition[3],
      "5": ts.deckComposition[4],
      "6": ts.deckComposition[5],
      "7": ts.deckComposition[6],
      "8": ts.deckComposition[7],
      "9": ts.deckComposition[8],
      T: ts.deckComposition[9],
      J: ts.deckComposition[10],
      Q: ts.deckComposition[11],
      K: ts.deckComposition[12],
    } : null,
    lastPlayerCards: ts && ts.lastHand ? ts.lastHand.playerCards : [],
    lastBankerCards: ts && ts.lastHand ? ts.lastHand.bankerCards : [],
    lastErrorResetReason: ts ? ts.lastErrorResetReason : null,
    lastErrorResetTime: ts ? ts.lastErrorResetTime : null,
    deducedBeadRoad: ts ? ts.handHistory : [],
    sourceBeadRoad: table.statistics || [],
    ev: ts && ts.lastEvResult ? {
      player: { ev: ts.lastEvResult.ev_player, evBase: ts.lastEvResult.ev_player_base, prob: ts.lastEvResult.p_player },
      banker: { ev: ts.lastEvResult.ev_banker, evBase: ts.lastEvResult.ev_banker_base, prob: ts.lastEvResult.p_banker },
      tie: { ev: ts.lastEvResult.ev_tie, prob: ts.lastEvResult.p_tie },
      rebate: ts.lastEvResult.rebate,
      best: ts.lastEvResult.best,
    } : null
  };
}

/**
 * Writes the tables_state.json for dashboard usage.
 */
function writeDashboardJson(tables, stateManager, timestamp, events, allScrapedTables = [], ignoredTables = [], dynamicConfig = {}, eventLog = []) {
  const stateSnapshot = [];
  
  for (const table of tables) {
    stateSnapshot.push(mapTableToSnapshot(table, stateManager));
  }

  const eventsSummary = events.map((e) => ({
    type: e.type,
    tableName: e.tableName,
    ...(e.winner ? { winner: e.winner } : {}),
    ...(e.cardsSubtracted ? { cardsSubtracted: e.cardsSubtracted } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
  }));

  try {
    const tmpFile = DASHBOARD_FILE + ".tmp";
    fs.writeFileSync(
      tmpFile,
      JSON.stringify(
        {
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
        },
        null,
        2
      )
    );
    safeRenameSync(tmpFile, DASHBOARD_FILE);
  } catch (e) {
    console.error(`[STATE] Failed to write tables_state.json: ${e.message}`);
  }
}

module.exports = {
  loadState,
  saveState,
  writeDashboardJson,
};
