const config = require("./config");
const { TableStateManager } = require("./tableManager");
const { processEVForEvents } = require("./evCalculator");
const { handleTelemetrySignals } = require("./telemetryClient");
const { loadState, saveState, writeDashboardJson } = require("./statePersistence");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");

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
  let processing = false;
  let runAgain = false;
  let eventQueue = [];
  let activePage = null;

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

          await processEVForEvents(events, dynamicConfig);

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
        await writeDashboardJson(allTables, stateManager, timestamp, [], Array.from(latestScrapedTables.keys()), ignoredTables, dynamicConfig, eventLog);

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

  async function setupPage(page) {
    activePage = page;
    console.log(`[runEyes] Initializing interceptors on page: ${page.url()}`);

    // Bridge: browser → Node.js
    await page.exposeFunction("onTableStateUpdate", async (table) => {
      if (pageRef.current !== page) return; // Ignore updates from swapped/old pages
      if (table && table.tableName) {
        eventQueue.push(table);
        await triggerTick();
      }
    }).catch(() => {}); // Ignore if already exposed

    // Inject interceptors
    if (!hookedPages.has(page)) {
      hookedPages.add(page);
      await page.evaluate(extractorCode).catch(e => console.error("[runEyes] Eval failed:", e.message));
      await page.evaluateOnNewDocument(extractorCode).catch(e => console.error("[runEyes] NavEval failed:", e.message));
      console.log("\x1b[36m[runEyes] Hooked event-interceptors on page.\x1b[0m");
    }

    // Prime initial table list once (reads directly from interceptor cache)
    try {
      const allParsed = await page.evaluate(() => {
        const cache = window.__tableStatesCache || {};
        const rooms = Object.keys(cache);
        if (typeof getParsedTable !== "function" || rooms.length === 0) return [];
        return rooms.map(roomId => getParsedTable(roomId)).filter(Boolean);
      });
      for (const t of allParsed) latestScrapedTables.set(t.tableName, t);
      if (allParsed.length > 0) {
        console.log(`[runEyes] Primed ${latestScrapedTables.size} active tables from page.`);
        if (acctConfig && acctConfig.isPlannedRestart) {
          acctConfig.isPlannedRestart = false; // Reset flag
          sendWhatsAppNotification(`[RESTART] Eyes module "${acctConfig.label}" completed planned session restart and is now active.`)
            .catch(err => console.error("Notification failed:", err.message));
        }
      }
    } catch (err) {
      console.warn("[runEyes] Initial priming failed on page. Relying on live events.");
    }
  }

  // Setup initial page
  await setupPage(pageRef.current);

  // Monitor page close events and handle seamless page swaps
  let exitResolved = null;
  const exitPromise = new Promise((resolve) => { exitResolved = resolve; });

  function bindCloseListener(page) {
    page.on("close", async () => {
      console.log(`[runEyes] Page close event detected for: ${page.url()}`);
      // Short delay to let sessionManager update pageRef.current
      await new Promise(r => setTimeout(r, 2000));

      if (pageRef.current !== page && pageRef.current && !pageRef.current.isClosed()) {
        console.log("[runEyes] Seamless page swap detected. Swapping runners...");
        await setupPage(pageRef.current).catch(err => {
          console.error("[runEyes] Error swapping page setup:", err.message);
          exitResolved(err);
        });
        bindCloseListener(pageRef.current);
      } else {
        if (acctConfig && acctConfig.isPlannedRestart) {
          console.log("[runEyes] Planned restart in progress, waiting for swapped page...");
          let checks = 0;
          const interval = setInterval(async () => {
            checks++;
            if (pageRef.current !== page && pageRef.current && !pageRef.current.isClosed()) {
              clearInterval(interval);
              console.log("[runEyes] Swapped page located. Hooking runner...");
              await setupPage(pageRef.current).catch(err => {
                console.error("[runEyes] Swapped page setup failed:", err.message);
                exitResolved(err);
              });
              bindCloseListener(pageRef.current);
            } else if (checks > 15) { // 30s timeout
              clearInterval(interval);
              exitResolved(new Error("Timeout waiting for seamless page swap"));
            }
          }, 2000);
        } else {
          exitResolved(null); // Unplanned close, exit to let supervisor relaunch
        }
      }
    });
  }

  bindCloseListener(pageRef.current);

  await exitPromise;
  return false;
}

// ─── Local Loopback IPC Server ──────────────────────────────────────────
const http = require("http");

function startLoopbackServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/reset-all") {
      try {
        console.log("[IPC] Received manual /reset-all request from dashboard.");

        for (const ts of stateManager.tables.values()) {
          stateManager._resetShoe(ts, "Manual reset all from dashboard via loopback");
        }

        saveState(stateManager, eventLog);

        // Immediate push update to dashboard
        const allTables = Array.from(latestScrapedTables.values());
        const { ignoredTables, config: dynamicConfig } = config.getDynamicConfig();
        const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];

        await writeDashboardJson(
          allTables,
          stateManager,
          timestamp,
          [],
          Array.from(latestScrapedTables.keys()),
          ignoredTables,
          dynamicConfig,
          eventLog
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "All tables successfully reset in memory" }));
      } catch (err) {
        console.error("[IPC] Failed to reset all tables:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/reset?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const tableName = url.searchParams.get("table");

        if (!tableName) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing table param" }));
          return;
        }

        console.log(`[IPC] Received manual /reset request for table ${tableName} from dashboard.`);

        const ts = stateManager.getTable(tableName);
        if (!ts) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Table ${tableName} not found in stateManager` }));
          return;
        }

        stateManager._resetShoe(ts, "Manual reset from dashboard via loopback");
        saveState(stateManager, eventLog);

        // Immediate push update to dashboard
        const allTables = Array.from(latestScrapedTables.values());
        const { ignoredTables, config: dynamicConfig } = config.getDynamicConfig();
        const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];

        await writeDashboardJson(
          allTables,
          stateManager,
          timestamp,
          [],
          Array.from(latestScrapedTables.keys()),
          ignoredTables,
          dynamicConfig,
          eventLog
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, table: tableName, deckRemaining: ts.remaining }));
      } catch (err) {
        console.error("[IPC] Failed to reset table:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const IPC_PORT = 3455;
  server.listen(IPC_PORT, "127.0.0.1", () => {
    console.log(`[IPC] Loopback server listening on http://127.0.0.1:${IPC_PORT}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[IPC] Port ${IPC_PORT} already in use, loopback server might be already running.`);
    } else {
      console.error("[IPC] Server error:", err.message);
    }
  });

  // Graceful shutdown
  process.on("SIGINT", () => { server.close(() => {}); });
  process.on("SIGTERM", () => { server.close(() => {}); });
}

// Start loopback server immediately on module load
startLoopbackServer();

module.exports = { runEventBasedEyes, stateManager };
