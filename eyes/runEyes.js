/**
 * runEyes.js — Event-Driven Game Engine for PG Eyes
 *
 * Pure game logic: state tracking, EV calculation, telemetry dispatch.
 * Receives real-time table updates pushed from the browser interceptor
 * via Puppeteer's exposeFunction bridge.
 */

const config = require("./config");
const { TableStateManager } = require("./tableManager");
const { processEVForEvents } = require("./evCalculator");
const { handleTelemetrySignals } = require("./telemetryClient");
const { loadState, saveState, writeDashboardJson } = require("./statePersistence");

// ─── State ───────────────────────────────────────────────────────────────
const stateManager = new TableStateManager();
const latestScrapedTables = new Map();
const eventLog = [];
const MAX_EVENT_LOG = 100;
const hookedPages = new Set();
let consecutiveErrors = 0;

// Initialize saved state on startup
loadState(stateManager, eventLog, config.stateMaxAgeMinutes);

// Persist on exit
process.on("SIGINT", () => { saveState(stateManager, eventLog); process.exit(0); });
process.on("SIGTERM", () => { saveState(stateManager, eventLog); process.exit(0); });

// ─── Event-Driven Engine ─────────────────────────────────────────────────

async function runEventBasedEyes(pageRef, extractorCode, acctConfig) {
  const currentPage = pageRef.current;

  // Inject interceptors
  if (!hookedPages.has(currentPage)) {
    hookedPages.add(currentPage);
    await currentPage.evaluate(extractorCode).catch(e => console.error("[runEyes] Eval failed:", e.message));
    await currentPage.evaluateOnNewDocument(extractorCode).catch(e => console.error("[runEyes] NavEval failed:", e.message));
    console.log("\x1b[36m[runEyes] Hooked event-interceptors.\x1b[0m");
  }

  // Prime initial table list once (reads directly from interceptor cache)
  try {
    const allParsed = await currentPage.evaluate(() => {
      const cache = window.__tableStatesCache || {};
      const rooms = Object.keys(cache);
      if (typeof getParsedTable !== "function" || rooms.length === 0) return [];
      return rooms.map(roomId => getParsedTable(roomId)).filter(Boolean);
    });
    for (const t of allParsed) latestScrapedTables.set(t.tableName, t);
    if (allParsed.length > 0) console.log(`[runEyes] Primed ${latestScrapedTables.size} active tables.`);
  } catch (err) {
    console.warn("[runEyes] Initial priming failed. Relying on live events.");
  }

  let processing = false;
  let runAgain = false;
  let eventQueue = [];

  async function triggerTick() {
    if (processing) { runAgain = true; return; }
    processing = true;

    try {
      do {
        runAgain = false;
        const batch = eventQueue.slice();
        eventQueue = [];
        if (batch.length === 0) continue;

        const { ignoredTables, config: dynamicConfig } = config.getDynamicConfig();
        const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];

        for (const table of batch) {
          latestScrapedTables.set(table.tableName, table);
          if (ignoredTables.includes(table.tableName)) continue;

          const events = stateManager.update([table]);
          if (events.length === 0) continue;

          processEVForEvents(events, dynamicConfig);

          for (const e of events) {
            if (e.type !== "HAND_COMPLETE" && e.type !== "STATE_CHANGE") continue;
            const ts = e.tableState;
            eventLog.unshift({
              time: new Date().toISOString(),
              type: e.type,
              table: e.tableName,
              round: e.round,
              winner: e.winner || null,
              playerCards: e.playerCards || [],
              bankerCards: e.bankerCards || [],
              cardsSubtracted: e.cardsSubtracted || 0,
              deckRemaining: ts.remaining,
              ev: ts.lastEvResult ? { player: ts.lastEvResult.ev_player, banker: ts.lastEvResult.ev_banker, best: ts.lastEvResult.best } : null,
            });
          }
          if (eventLog.length > MAX_EVENT_LOG) eventLog.length = MAX_EVENT_LOG;

          handleTelemetrySignals(events, stateManager);
        }

        // Dashboard snapshot
        const allTables = Array.from(latestScrapedTables.values());
        writeDashboardJson(allTables, stateManager, timestamp, [], Array.from(latestScrapedTables.keys()), ignoredTables, dynamicConfig, eventLog);

      } while (runAgain);

      saveState(stateManager, eventLog);
      consecutiveErrors = 0;
    } catch (err) {
      console.error("[runEyes] Tick error:", err.message);
      const isFatal = ["detached Frame", "destroyed", "Target closed", "timeout"].some(t => err.message.includes(t));
      if (isFatal && ++consecutiveErrors >= 3) {
        throw new Error(`Max crash recovery attempts reached. Last: ${err.message}`);
      }
    } finally {
      processing = false;
    }
  }

  // Bridge: browser → Node.js
  await currentPage.exposeFunction("onTableStateUpdate", async (table) => {
    if (table && table.tableName) {
      eventQueue.push(table);
      await triggerTick();
    }
  });

  // Stay alive until page closes
  await new Promise(resolve => currentPage.on("close", resolve));
  return false;
}

module.exports = { runEventBasedEyes, stateManager };
