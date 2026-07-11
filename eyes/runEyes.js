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

// Negative cache: tracks rounds where peer lookup failed, to avoid re-querying.
// Value is { expiry: timestamp } — skip if Date.now() < expiry.
const reconcileNegativeCache = new Map();
const NEGATIVE_CACHE_NOT_FOUND_MS = 30 * 1000; // 30 seconds for confirmed "not found"
const NEGATIVE_CACHE_ERROR_MS = 60 * 1000;          // 60 seconds for timeout/connection errors
let reconcileRunning = false;

function mapServerCodeToWinner(code) {
  if (!code) return null;
  if (code.startsWith('p')) return 'P';
  if (code.startsWith('b')) return 'B';
  if (code.startsWith('t')) return 'T';
  return null;
}

async function checkAndReconcileTables(filteredTables, dynamicConfig) {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    for (const table of filteredTables) {
      const ts = stateManager.getTable(table.tableName);
      if (!ts) continue;

      // Skip reconciliation if table is currently shuffling
      const isShuffling = table.state && table.state.toLowerCase().includes("shuff");
      if (isShuffling) continue;

      // Skip reconciliation if statistics are from a previous shoe (out of sync)
      if (table.round && table.statistics && table.statistics.length > table.round) continue;

      const stats = table.statistics || [];

      for (let r = 1; r <= stats.length; r++) {
        const serverCode = stats[r - 1];
        const expectedWinner = mapServerCodeToWinner(serverCode);
        if (!expectedWinner) continue;

        // Only reconcile past rounds to let the local scraper process the current round naturally.
        const isPastRound = (table.round && r < table.round) || r < stats.length;
        if (!isPastRound) continue;

        const deducedItem = ts.handHistory.find(item => item && item.round === r);
        let needsReconciliation = false;

        if (!deducedItem) {
          needsReconciliation = true;
        } else if (!deducedItem.winner || deducedItem.winner !== expectedWinner) {
          needsReconciliation = true;
        } else if (!deducedItem.playerCards || deducedItem.playerCards.length < 2 || !deducedItem.bankerCards || deducedItem.bankerCards.length < 2) {
          needsReconciliation = true;
        }

        if (!needsReconciliation) continue;

        const key = `${table.tableName}:${r}`;

        // Check negative cache — skip if we recently failed for this round
        const cached = reconcileNegativeCache.get(key);
        if (cached && Date.now() < cached.expiry) {
          continue;
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
          const res = await fetch(
            `http://localhost:3456/api/reconcile-round?table=${encodeURIComponent(table.tableName)}&round=${r}`,
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);
          const data = await res.json();

          if (data.ok && data.cards) {
            const currentTs = stateManager.getTable(table.tableName);
            if (!currentTs) continue;

            const success = currentTs.reconcileRound(r, data.cards.playerCards, data.cards.bankerCards, serverCode);
            if (success) {
              // Recalculate EV since composition has changed
              const { calculateEV } = require("./evCalculator");
              const evResult = await calculateEV(currentTs.deckComposition, dynamicConfig);
              if (evResult) {
                currentTs.lastEvResult = evResult;
              }
              saveState(stateManager, eventLog);

              const fs = require("fs");
              const path = require("path");
              let ignoredTables = [];
              try {
                const cfgPath = path.join(__dirname, "..", "dashboard", "config.json");
                if (fs.existsSync(cfgPath)) {
                  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                  ignoredTables = cfg.ignoredTables || [];
                }
              } catch(e){}

              const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
              const allScrapedTables = filteredTables.map(t => t.tableName);
              await writeDashboardJson(filteredTables, stateManager, timestamp, [], allScrapedTables, ignoredTables, dynamicConfig, eventLog);
            } else {
              // Verification failed — peer likely returned cards from a different shoe.
              // Cache to avoid retrying every tick.
              reconcileNegativeCache.set(key, { expiry: Date.now() + NEGATIVE_CACHE_NOT_FOUND_MS });
            }
          } else {
            // Not found or error — add to negative cache
            const ttl = (data.reason === "peer_error") ? NEGATIVE_CACHE_ERROR_MS : NEGATIVE_CACHE_NOT_FOUND_MS;
            reconcileNegativeCache.set(key, { expiry: Date.now() + ttl });
          }
        } catch (err) {
          // Network error reaching local Central — cache briefly
          reconcileNegativeCache.set(key, { expiry: Date.now() + NEGATIVE_CACHE_ERROR_MS });
        }
      }
    }

    // Housekeep: prune expired entries from negative cache periodically
    if (reconcileNegativeCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of reconcileNegativeCache) {
        if (now >= v.expiry) reconcileNegativeCache.delete(k);
      }
    }
  } finally {
    reconcileRunning = false;
  }
}

async function runEventBasedEyes(pageRef, extractorCode, acctConfig) {
  let processing = false;
  let runAgain = false;
  let eventQueue = [];
  let activePage = null;
  let lastUpdateTime = Date.now();

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
          for (const e of events) {
            if (e.type === "SHOE_RESET" && e.tableName) {
              const prefix = `${e.tableName}:`;
              for (const key of reconcileNegativeCache.keys()) {
                if (key.startsWith(prefix)) reconcileNegativeCache.delete(key);
              }
            }
          }
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
        await checkAndReconcileTables(allTables, dynamicConfig);
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
      lastUpdateTime = Date.now(); // Reset staleness watchdog
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

    // Reset staleness watchdog after page setup/swap
    lastUpdateTime = Date.now();
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

  // ─── Staleness Watchdog ──────────────────────────────────────────────────
  // If no game state update received for 15 seconds, the interceptor has
  // likely disconnected. Trigger a full restart via the supervisor loop.
  const STALENESS_TIMEOUT_MS = 15000;
  const stalenessWatchdog = setInterval(() => {
    const silentMs = Date.now() - lastUpdateTime;
    if (silentMs >= STALENESS_TIMEOUT_MS) {
      const silentSec = (silentMs / 1000).toFixed(1);
      const msg = `[Staleness Watchdog] No game state updates for ${silentSec}s on "${acctConfig?.label || 'Eyes'}". Interceptor disconnected — restarting session.`;
      console.error(`\x1b[31m${msg}\x1b[0m`);
      sendWhatsAppNotification(msg).catch(err => console.error("Notification failed:", err.message));
      clearInterval(stalenessWatchdog);
      if (pageRef.current) pageRef.current.closeReason = msg;
      exitResolved(new Error(msg));
    }
  }, 5000);

  await exitPromise;
  clearInterval(stalenessWatchdog);
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

module.exports = { runEventBasedEyes, sendStateOverWS };
