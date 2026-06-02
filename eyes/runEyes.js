const config = require("./config");
const { TableStateManager, cardRankToIndex } = require("./tableManager");
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

async function syncActualDeckComposition(page, table) {
  if (!page || page.isClosed()) return;
  try {
    const history = await page.evaluate((id) => {
      if (typeof window.getActualDeckCompositionHistory === 'function') {
        return window.getActualDeckCompositionHistory(id);
      }
      return null;
    }, table.tableId || table.tableName);

    if (!history || !Array.isArray(history) || history.length === 0) return;

    const ts = stateManager.getTable(table.tableName);
    if (!ts) return;

    // 1. Filter out completed rounds (shoeNos < table.round)
    const validRounds = history.filter(r => {
      return r && r.shoeNos && r.cards &&
             (r.cards.player.length > 0 || r.cards.banker.length > 0) &&
             (table.round > 0 && r.shoeNos < table.round);
    });

    validRounds.sort((a, b) => a.shoeNos - b.shoeNos);

    // 2. Reconstruct actual composition by subtracting cards chronologically
    const fresh = [32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32];
    for (const r of validRounds) {
      const allCards = [...(r.cards.player || []), ...(r.cards.banker || [])];
      for (const card of allCards) {
        const idx = cardRankToIndex(card);
        if (idx >= 0 && fresh[idx] > 0) {
          fresh[idx]--;
        }
      }
    }

    ts.actualDeckComposition = [...fresh];

    // 3. Compute real-time composition by subtracting current active round cards
    const realTimeComp = [...fresh];
    const visibleCards = [...(table.playerCards || []), ...(table.bankerCards || [])].filter(c => c !== "Red");
    for (const card of visibleCards) {
      const idx = cardRankToIndex(card);
      if (idx >= 0 && realTimeComp[idx] > 0) {
        realTimeComp[idx]--;
      }
    }

    // 4. Auto-healing comparison: Check mismatch in "Waiting for Bets"
    const isTransitioning = ts.lastFinalizedRound > 0 && table.round > ts.lastFinalizedRound;
    const remainingCards = ts.deckComposition.reduce((a, b) => a + b, 0);

    if (table.state === "Waiting for Bets" && !isTransitioning && remainingCards < 416) {
      let isDiff = false;
      for (let i = 0; i < 13; i++) {
        if (ts.deckComposition[i] !== realTimeComp[i]) {
          isDiff = true;
          break;
        }
      }

      if (isDiff) {
        const oldComp = [...ts.deckComposition];
        ts.deckComposition = [...realTimeComp]; // Auto-heal!

        if (!ts.hasWarnedMismatch) {
          ts.hasWarnedMismatch = true;
          const msg = `[AUTO-HEAL] Table ${table.tableName}: Deck mismatch detected at round ${table.round}. Reactive composition: [${oldComp.join(', ')}] vs History composition: [${realTimeComp.join(', ')}]. Syncing deck.`;
          console.log(`\x1b[32m${msg}\x1b[0m`);
          sendWhatsAppNotification(msg).catch(err => console.error("WhatsApp Notification failed:", err));
        }
      } else {
        ts.hasWarnedMismatch = false;
      }
    }
  } catch (err) {
    console.error(`[syncActualDeckComposition] Error for ${table.tableName}:`, err.message);
  }
}

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

          // Align actual deck composition and run auto-healing check
          await syncActualDeckComposition(activePage, table);

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

// ─── WebSocket Telemetry Client ──────────────────────────────────────────
const WebSocket = require("ws");
let wsClient = null;
let wsActive = false;
let wsHeartbeatTimer = null;

function connectToCentralWS() {
  const wsUrl = "ws://127.0.0.1:3456/ws/telemetry?type=scraper";
  console.log(`[WS-Client] Connecting to Dashboard central server: ${wsUrl}`);

  wsClient = new WebSocket(wsUrl);

  wsClient.on("open", () => {
    console.log("\x1b[32m[WS-Client] Connected to Dashboard central server successfully.\x1b[0m");
    wsActive = true;

    // Start heartbeat pings
    if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 15000);

    // Proactively push current loaded state to populate dashboard instantly on connect
    pushCurrentState();
  });

  wsClient.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS-Client] Received message type: ${message.type}`);

      if (message.type === "reset-all") {
        console.log("[WS-Client] Triggering manual /reset-all Shoe Clear.");
        for (const ts of stateManager.tables.values()) {
          stateManager._resetShoe(ts, "Manual reset all from dashboard via WS");
        }
        saveState(stateManager, eventLog);
        await pushCurrentState();
      } else if (message.type === "reset") {
        const tableName = message.table;
        console.log(`[WS-Client] Triggering manual /reset Shoe Clear for table: ${tableName}`);
        const ts = stateManager.getTable(tableName);
        if (ts) {
          stateManager._resetShoe(ts, "Manual reset from dashboard via WS");
          saveState(stateManager, eventLog);
          await pushCurrentState();
        }
      }
    } catch (err) {
      console.error("[WS-Client] Error handling message:", err.message);
    }
  });

  wsClient.on("close", () => {
    console.warn("[WS-Client] Connection to Dashboard lost. Reconnecting in 5 seconds...");
    wsActive = false;
    if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
    wsClient = null;
    setTimeout(connectToCentralWS, 5000);
  });

  wsClient.on("error", (err) => {
    // Quietly catch errors when dashboard server is offline
  });
}

async function pushCurrentState() {
  try {
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
  } catch (err) {
    console.error("[WS-Client] Failed to push current state:", err.message);
  }
}

function sendStateOverWS(payload) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ type: "state", data: payload }));
  }
}

// Start WebSocket client immediately on module load
connectToCentralWS();

module.exports = { runEventBasedEyes, stateManager, sendStateOverWS };
