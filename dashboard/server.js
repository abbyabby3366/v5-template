const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { MongoClient } = require("mongodb");
const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const MONGODB_NAME = process.env.MONGODB_NAME || "neuron_baccarat";
let dbCollection = null;
let dbCollectionShuffles = null;

let betConfig = {
  mode: 'round_robin',
  startingBankroll: 1000,
  method: 'kelly',
  kellyFraction: 1.0,
  flatRatio: 0.01,
  rounding: 10,
  maxBet: 500,
  autoBetEnabled: true,
  minAccountBalance: 1000
};

try {
  const cfgPath = path.join(__dirname, "config.json");
  if (fs.existsSync(cfgPath)) {
    betConfig = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  }
} catch (e) { }

function saveConfig() {
  fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(betConfig, null, 2));
}

const PORT = 3456;
const ROOT = path.join(__dirname, "..");

let _stateManager = null;
const betLog = [];
const centralBetQueue = [];
const MAX_BET_LOG = 1000;

let cachedSuccessRates = {
  last100: null,
  last1000: null,
  last10000: null,
  allTime: null,
  moduleLast1000: {}
};

async function updateSuccessRates() {
  if (!dbCollection) return;
  try {
    const validOutcomes = ["SUCCESS", "WRONG_AMOUNT", "UNPLACED", "NETWORK_ERROR", "DISPATCH_FAILED", "FAILED"];
    const successOutcomes = ["SUCCESS"];

    const bets = await dbCollection.find({ outcome: { $in: validOutcomes } })
      .sort({ time: -1 })
      .limit(10000)
      .project({ outcome: 1 })
      .toArray();

    let s100 = 0, t100 = 0;
    let s1000 = 0, t1000 = 0;
    let s10000 = 0, t10000 = bets.length;

    for (let i = 0; i < bets.length; i++) {
      const b = bets[i];
      const isSuccess = successOutcomes.includes(b.outcome);
      if (isSuccess) s10000++;
      if (i < 100) { t100++; if (isSuccess) s100++; }
      if (i < 1000) { t1000++; if (isSuccess) s1000++; }
    }

    const allTimeAgg = await dbCollection.aggregate([
      { $match: { outcome: { $in: validOutcomes } } },
      {
        $group: {
          _id: { $in: ["$outcome", successOutcomes] },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    let allSuccess = 0;
    let allTotal = 0;
    for (const r of allTimeAgg) {
      allTotal += r.count;
      if (r._id === true) allSuccess += r.count;
    }

    let moduleRates = {};
    for (const m of activeModules.values()) {
      let headerLabel = m.label;
      if (m.accounts && m.accounts.length > 0 && m.accounts[0].label) {
        headerLabel = m.accounts[0].label;
      }

      const modBets = await dbCollection.find({
        outcome: { $in: validOutcomes },
        $or: [
          { targetModuleId: m.moduleId },
          { targetModule: headerLabel },
          { targetModule: m.label }
        ]
      }).sort({ time: -1 }).limit(1000).project({ outcome: 1 }).toArray();

      let ms = 0;
      let mt = modBets.length;
      for (const mb of modBets) {
        if (successOutcomes.includes(mb.outcome)) ms++;
      }
      moduleRates[headerLabel] = mt > 0 ? (ms / mt) : null;
    }

    cachedSuccessRates = {
      last100: t100 > 0 ? (s100 / t100) : null,
      last1000: t1000 > 0 ? (s1000 / t1000) : null,
      last10000: t10000 > 0 ? (s10000 / t10000) : null,
      allTime: allTotal > 0 ? (allSuccess / allTotal) : null,
      moduleLast1000: moduleRates
    };
  } catch (e) {
    console.error("[Stats] Failed to update success rates:", e.message);
  }
}

// Track active bet modules via heartbeat
const activeModules = new Map(); // moduleId -> { moduleId, baseUrl, lastHeartbeat, label, isBusy, busySince }
const cumulativeProfitMap = {}; // keyed by moduleId (stable)
const todayProfitMap = {};       // keyed by moduleId (stable)
const STALE_THRESHOLD_MS = 12000;

// Periodically purge stale modules and send WhatsApp alerts
setInterval(() => {
  const now = Date.now();
  for (const [moduleId, m] of activeModules) {
    if (now - m.lastHeartbeat >= STALE_THRESHOLD_MS) {
      const label = (m.accounts && m.accounts[0] && m.accounts[0].label) || m.label || moduleId;
      console.log(`\x1b[31m[Central] Module ${label} (${moduleId}) went stale — removing.\x1b[0m`);
      activeModules.delete(moduleId);
      sendWhatsAppNotification(`[ALERT] Bet module "${label}" (${moduleId}) went offline — no heartbeat for ${Math.round(STALE_THRESHOLD_MS / 1000)}s.`)
        .catch(err => console.error("WhatsApp notification failed:", err.message));
    }
  }
}, 5000);

function getTodayStart() {
  const now = new Date();
  const today12pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  if (now < today12pm) {
    const yesterday12pm = new Date(today12pm);
    yesterday12pm.setDate(yesterday12pm.getDate() - 1);
    return yesterday12pm;
  }
  return today12pm;
}

let lastRoundRobinIndex = -1;
let lastRoundRobinModuleIds = []; // track the ordered list of module IDs for stable cycling
let lastUsedModuleId = null;      // track which module was last dispatched to

function resolveBetModuleTarget() {
  const now = Date.now();
  // Filter modules that sent a heartbeat in the last 12 seconds AND are not busy
  let online = Array.from(activeModules.values()).filter(m => {
    // Timeout stuck busy modules (e.g. > 60s)
    if (m.isBusy && m.busySince && now - m.busySince > 60000) {
      m.isBusy = false;
      m.busySince = null;
    }
    return now - m.lastHeartbeat < 12000 && !m.isBusy;
  });

  if (betConfig.minAccountBalance != null && betConfig.minAccountBalance > 0) {
    online = online.filter(m => {
      if (m.accounts && m.accounts.length > 0) {
        // If ANY account has balance < minAccountBalance, exclude this module
        const hasLowBalance = m.accounts.some(acc => {
          if (acc.balance != null) {
            const cleanBalance = String(acc.balance).replace(/[^0-9.]/g, '');
            const parsedBalance = parseFloat(cleanBalance);
            if (!isNaN(parsedBalance)) {
              return parsedBalance < betConfig.minAccountBalance;
            }
          }
          return false;
        });
        return !hasLowBalance;
      }
      return true; // Keep modules with no reported account balances just in case
    });
  }

  // ONLY allow modules that are fully launched and accepting bets
  online = online.filter(m => {
    if (m.accounts && m.accounts.length > 0) {
      return m.accounts.some(acc => acc.isAcceptingBets === true);
    }
    return false; // If no accounts reported, don't blindly route to it
  });

  if (online.length === 0) return null;

  if (betConfig.mode === 'round_robin' || !betConfig.mode) {
    // Build a stable sorted list of module IDs to cycle through
    const currentIds = online.map(m => m.moduleId).sort();
    const idsChanged = JSON.stringify(currentIds) !== JSON.stringify(lastRoundRobinModuleIds);

    if (idsChanged) {
      lastRoundRobinModuleIds = currentIds;
      // When modules change, find where the last-used module sits in the new list
      // and continue from the NEXT one to avoid double-picking
      if (lastUsedModuleId) {
        const lastPos = currentIds.indexOf(lastUsedModuleId);
        lastRoundRobinIndex = lastPos >= 0 ? lastPos : -1;
      } else {
        lastRoundRobinIndex = -1;
      }
    }

    // Advance to next module
    lastRoundRobinIndex = (lastRoundRobinIndex + 1) % currentIds.length;
    const targetModuleId = currentIds[lastRoundRobinIndex];
    const targetModule = online.find(m => m.moduleId === targetModuleId);

    if (targetModule) {
      lastUsedModuleId = targetModuleId;
      return { baseUrl: targetModule.baseUrl, moduleId: targetModule.moduleId };
    }
    return null;
  }

  // Default fallback if mode isn't recognized or we add others later
  const fallback = online[0];
  lastUsedModuleId = fallback.moduleId;
  return { baseUrl: fallback.baseUrl, moduleId: fallback.moduleId };
}

function processCentralQueue() {
  if (centralBetQueue.length === 0) return;

  // ─── STALE BET PURGE (QUEUE TTL) ───
  const now = Date.now();
  const QUEUE_TTL_MS = 15000; // Max 15 seconds allowed in queue

  while (centralBetQueue.length > 0) {
    const oldestBet = centralBetQueue[0];
    const betAge = now - new Date(oldestBet.time).getTime();

    if (betAge > QUEUE_TTL_MS) {
      console.log(
        `\x1b[33m[Central] Purged stale bet ${oldestBet.id} (Age: ${Math.round(betAge / 1000)}s > ${QUEUE_TTL_MS / 1000}s)\x1b[0m`
      );
      // Remove from the queue
      centralBetQueue.shift();

      // Update outcome to EXPIRED in-memory and in DB
      oldestBet.outcome = "EXPIRED";
      oldestBet.executionState = {
        status: "EXPIRED",
        reason: `Queue TTL exceeded (${Math.round(betAge / 1000)}s)`,
      };

      if (dbCollection) {
        dbCollection
          .updateOne(
            { id: oldestBet.id },
            {
              $set: {
                outcome: oldestBet.outcome,
                executionState: oldestBet.executionState,
              },
            },
          )
          .catch(() => {});
      }
    } else {
      // The oldest bet is still fresh, so all subsequent bets are also fresh
      break;
    }
  }

  if (centralBetQueue.length === 0) return;

  const targetResult = resolveBetModuleTarget();
  if (!targetResult) {
    // Debug logging to understand why targetResult is null
    const now = Date.now();
    console.log(`[Central] processCentralQueue: No target found! Queue length: ${centralBetQueue.length}. Active modules: ${activeModules.size}`);
    for (const [id, m] of activeModules) {
      console.log(` - Module ${id}: isBusy=${m.isBusy}, heartbeatAge=${now - m.lastHeartbeat}ms, accounts=${m.accounts ? m.accounts.length : 0}`);
      if (m.accounts && m.accounts.length > 0) {
        console.log(`   - Acc[0]: isAcceptingBets=${m.accounts[0].isAcceptingBets}, balance=${m.accounts[0].balance}`);
      }
    }
    return; // no available modules right now
  }

  const betEntry = centralBetQueue.shift();
  const targetModuleId = targetResult.moduleId;
  const targetBaseUrl = targetResult.baseUrl;

  const mod = activeModules.get(targetModuleId);
  if (mod) {
    mod.isBusy = true;
    mod.busySince = Date.now();
  }

  let targetModuleLabel = mod && mod.label ? mod.label : targetModuleId;
  if (mod && mod.accounts && mod.accounts.length > 0 && mod.accounts[0].label) {
    targetModuleLabel = mod.accounts[0].label;
  }

  betEntry.targetModuleId = targetModuleId;
  betEntry.targetModule = targetModuleLabel;
  betEntry.outcome = "PENDING";

  if (dbCollection) {
    dbCollection.updateOne(
      { id: betEntry.id },
      { $set: { targetModuleId: betEntry.targetModuleId, targetModule: betEntry.targetModule, outcome: betEntry.outcome } }
    ).catch(() => { });
  }

  fetch(targetBaseUrl + "/prettygaming/bet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(betEntry)
  }).then(async (resp) => {
    if (!resp.ok) {
      // Non-2xx response (e.g. 503 "Browser not ready" during session restart)
      let errMsg = `HTTP ${resp.status}`;
      try { const body = await resp.json(); errMsg = body.error || errMsg; } catch (e) { }
      console.error(`[Central] Bet dispatch to ${targetModuleLabel} rejected: ${errMsg}`);
      betEntry.outcome = "DISPATCH_FAILED";
      betEntry.executionState = { status: "DISPATCH_FAILED", reason: errMsg };
      if (mod) {
        mod.isBusy = false;
        mod.busySince = null;
      }
      if (dbCollection) {
        dbCollection.updateOne(
          { id: betEntry.id },
          { $set: { outcome: betEntry.outcome, executionState: betEntry.executionState } }
        ).catch(() => { });
      }
    }
  }).catch(err => {
    console.error("[Central] Failed to dispatch bet:", err.message);
    betEntry.outcome = "NETWORK_ERROR";
    betEntry.executionState = { status: "NETWORK_ERROR", reason: err.message };
    if (mod) {
      mod.isBusy = false;
      mod.busySince = null;
    }
    if (dbCollection) {
      dbCollection.updateOne(
        { id: betEntry.id },
        { $set: { outcome: betEntry.outcome, executionState: betEntry.executionState } }
      ).catch(() => { });
    }
    processCentralQueue(); // try next bet
  });

  if (centralBetQueue.length > 0) {
    processCentralQueue();
  }
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function startDashboard(stateManager) {
  _stateManager = stateManager;

  // Initialize MongoDB connection
  (async function initDB() {
    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      const db = client.db(MONGODB_NAME);
      dbCollection = db.collection("PRETTYGAMING_BETS");
      dbCollectionShuffles = db.collection("PRETTYGAMING_SHUFFLES");

      const recentBets = await dbCollection.find().sort({ time: -1 }).limit(MAX_BET_LOG).toArray();
      for (const b of recentBets) {
        // If a bet was queued or pending when the server died/restarted, it's stale now.
        if (b.outcome === "QUEUED" || b.outcome === "PENDING") {
          b.outcome = "CANCELLED";
          b.executionState = { status: "CANCELLED", reason: "Server restarted" };
          dbCollection.updateOne({ id: b.id }, { $set: { outcome: b.outcome, executionState: b.executionState } }).catch(() => { });
        }

        if (!betLog.find(existing => existing.id === b.id)) betLog.push(b);
      }
      betLog.sort((a, b) => new Date(b.time) - new Date(a.time));
      console.log(`[MongoDB] Connected. Loaded ${recentBets.length} recent bets from PRETTYGAMING_BETS.`);

      const agg = await dbCollection.aggregate([
        { $match: { profit: { $ne: null } } },
        { $group: { _id: { $ifNull: ["$targetModuleId", "$targetModule"] }, total: { $sum: "$profit" } } }
      ]).toArray();
      for (const r of agg) {
        cumulativeProfitMap[r._id] = r.total;
      }

      // Populate today's profit immediately
      try {
        const todayStartStr = getTodayStart().toISOString();
        const todayAgg = await dbCollection.aggregate([
          { $match: { profit: { $ne: null }, time: { $gte: todayStartStr } } },
          { $group: { _id: { $ifNull: ["$targetModuleId", "$targetModule"] }, total: { $sum: "$profit" } } }
        ]).toArray();
        for (const r of todayAgg) todayProfitMap[r._id] = r.total;
      } catch (e) {
        console.error("[MongoDB] Failed to initialize today profit:", e.message);
      }

      // Periodically update today's profit
      setInterval(async () => {
        try {
          const todayStartStr = getTodayStart().toISOString();
          const todayAgg = await dbCollection.aggregate([
            { $match: { profit: { $ne: null }, time: { $gte: todayStartStr } } },
            { $group: { _id: { $ifNull: ["$targetModuleId", "$targetModule"] }, total: { $sum: "$profit" } } }
          ]).toArray();
          for (const k of Object.keys(todayProfitMap)) todayProfitMap[k] = 0;
          for (const r of todayAgg) todayProfitMap[r._id] = r.total;
        } catch (e) { }
      }, 5000);

      updateSuccessRates();
    } catch (err) {
      console.error("[MongoDB] Failed to connect:", err.message);
    }

  })();

  async function compileStatsJSON(range = "all_time") {
    if (!dbCollection) throw new Error("DB not connected");

    let startStr = null;
    let endStr = null;
    let dateInfo = "All Time";

    if (range !== "all_time") {
      const now = new Date();
      const today12pm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
      let currentPeriodStart = new Date(today12pm);
      if (now < today12pm) {
        currentPeriodStart.setDate(currentPeriodStart.getDate() - 1);
      }

      let startDate = null;
      let endDate = null;

      if (range === 'today') {
        startDate = new Date(currentPeriodStart);
        endDate = new Date(currentPeriodStart);
        endDate.setDate(endDate.getDate() + 1);
      } else if (range === 'yesterday') {
        startDate = new Date(currentPeriodStart);
        startDate.setDate(startDate.getDate() - 1);
        endDate = new Date(currentPeriodStart);
      } else if (range === 'last_7_days') {
        startDate = new Date(currentPeriodStart);
        startDate.setDate(startDate.getDate() - 6);
        endDate = new Date(currentPeriodStart);
        endDate.setDate(endDate.getDate() + 1);
      }

      if (startDate && endDate) {
        startStr = startDate.toISOString();
        endStr = endDate.toISOString();
        const options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
        dateInfo = `${startDate.toLocaleString('en-GB', options)} to ${endDate.toLocaleString('en-GB', options)}`;
      }
    }

    const matchQ = { outcome: { $in: ["SUCCESS", "WRONG_AMOUNT"] } };
    if (startStr && endStr) {
      matchQ.time = { $gte: startStr, $lt: endStr };
    }

    const bets = await dbCollection.find(matchQ).toArray();

    const statsMap = {};
    let totalStats = { pnl: 0, turnover: 0, effTurnover: 0, expValue: 0, bal: 0, betCount: 0 };

    for (const b of bets) {
      const modId = b.targetModuleId || b.targetModule || "UNKNOWN";
      const modLabel = b.targetModule || modId;
      if (!statsMap[modLabel]) statsMap[modLabel] = { pnl: 0, turnover: 0, effTurnover: 0, expValue: 0, bal: 0, displayLabel: modLabel, betCount: 0 };

      let amt = parseFloat(b.actualBetAmount);
      if (isNaN(amt)) continue;

      statsMap[modLabel].betCount += 1;
      totalStats.betCount += 1;

      const profit = b.profit || 0;
      const ev = b.ev || 0;

      statsMap[modLabel].pnl += profit;
      totalStats.pnl += profit;

      statsMap[modLabel].turnover += amt;
      totalStats.turnover += amt;

      if (b.roundOutcome !== "T") {
        statsMap[modLabel].effTurnover += amt;
        totalStats.effTurnover += amt;

        const evAmt = ev * amt;
        statsMap[modLabel].expValue += evAmt;
        totalStats.expValue += evAmt;
      }
    }

    for (const m of activeModules.values()) {
      let label = m.label;
      if (m.accounts && m.accounts.length > 0 && m.accounts[0].label) {
        label = m.accounts[0].label;
      }
      if (!statsMap[label]) {
        statsMap[label] = { pnl: 0, turnover: 0, effTurnover: 0, expValue: 0, bal: 0, displayLabel: label, betCount: 0 };
      } else {
        statsMap[label].displayLabel = label;
      }
      if (m.accounts && m.accounts[0] && m.accounts[0].balance != null) {
        const cleanBalance = String(m.accounts[0].balance).replace(/[^0-9.-]/g, '');
        const bval = parseFloat(cleanBalance);
        if (!isNaN(bval)) {
          statsMap[label].bal = bval;
          totalStats.bal += bval;
        }
      }
    }

    const formatStats = (st) => {
      const effRebate = st.effTurnover * 0.012;
      const avgEv = st.effTurnover > 0 ? (st.expValue / st.effTurnover) : 0;
      return {
        pnl: st.pnl,
        turnover: st.turnover,
        effTurnover: st.effTurnover,
        effRebate: effRebate,
        expLoss: st.expValue - effRebate,
        expValue: st.expValue,
        avgEv: avgEv,
        bal: st.bal,
        betCount: st.betCount || 0,
        avgBet: st.betCount > 0 ? (st.turnover / st.betCount) : 0
      };
    };

    const result = {
      nodes: {},
      total: formatStats(totalStats)
    };
    for (const [mod, st] of Object.entries(statsMap)) {
      const displayName = st.displayLabel || mod;
      result.nodes[displayName] = formatStats(st);
    }

    return { ok: true, stats: result, dateInfo };
  }

  function reportStatsToCentral() {
    if (!dbCollection) return;
    const ranges = ["today", "yesterday", "last_7_days", "all_time"];
    const reportData = {
      platform: "PG",
      label: "Pretty Gaming",
      timestamp: new Date().toISOString(),
      ranges: {}
    };

    Promise.all(ranges.map(async (r) => {
      try {
        const statsData = await compileStatsJSON(r);
        reportData.ranges[r] = statsData;
      } catch (err) { }
    })).then(() => {
      const payload = JSON.stringify(reportData);
      const options = {
        hostname: "statsdashboard.onrender.com",
        port: 443,
        path: "/api/report-stats",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 5000
      };

      const req = require("https").request(options, (res) => {
        res.resume();
      });

      req.on("error", (e) => {
        // Quietly consume connection errors to avoid printing spam
      });

      req.write(payload);
      req.end();
    }).catch(() => { });
  }

  // Ping every 10 seconds
  setInterval(reportStatsToCentral, 10000);

  const server = http.createServer(async (req, res) => {
    // API endpoints
    if (req.method === "POST" && req.url.startsWith("/api/bet-module/heartbeat")) {
      try {
        const body = await parseJSONBody(req);
        if (body.moduleId && body.baseUrl) {
          const existing = activeModules.get(body.moduleId);
          activeModules.set(body.moduleId, {
            moduleId: body.moduleId,
            baseUrl: body.baseUrl,
            label: body.label || body.moduleId,
            accounts: body.accounts || [],
            lastHeartbeat: Date.now(),
            isBusy: existing ? existing.isBusy : false,
            busySince: existing ? existing.busySince : null
          });

          // If any bets are queued, try to process them now that a module is checking in
          processCentralQueue();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/telemetry/eyes")) {
      try {
        const body = await parseJSONBody(req);

        if (body.status && body.status.gameState === "ROUND_COMPLETE") {
          const betId = body.uuid;
          const existingBet = betLog.find(b => b.id === betId);
          if (existingBet) {
            const newWinner = body.ocr?.winner || "UNKNOWN";
            if (['B', 'P', 'T'].includes(newWinner) && existingBet.roundOutcome !== newWinner) {
              existingBet.roundOutcome = newWinner;
              existingBet.outcomeState = body;

              let profit = 0;
              const amt = parseFloat(existingBet.actualBetAmount);
              if ((existingBet.outcome === 'SUCCESS' || existingBet.outcome === 'WRONG_AMOUNT') && !isNaN(amt)) {
                let targetSide = '';
                if (existingBet.target.includes('Banker')) targetSide = 'B';
                else if (existingBet.target.includes('Player')) targetSide = 'P';
                else if (existingBet.target.includes('Tie')) targetSide = 'T';

                if (existingBet.roundOutcome === 'T' && targetSide !== 'T') {
                  profit = 0;
                } else if (existingBet.roundOutcome === targetSide) {
                  if (targetSide === 'B') profit = amt * 0.95;
                  else if (targetSide === 'P') profit = amt * 1;
                  else if (targetSide === 'T') profit = amt * 8;
                } else {
                  profit = -amt;
                }
              }
              existingBet.profit = profit;
              if (existingBet.targetModuleId) {
                cumulativeProfitMap[existingBet.targetModuleId] = (cumulativeProfitMap[existingBet.targetModuleId] || 0) + profit;
                todayProfitMap[existingBet.targetModuleId] = (todayProfitMap[existingBet.targetModuleId] || 0) + profit;
              }

              if (dbCollection) {
                dbCollection.updateOne(
                  { id: existingBet.id },
                  { $set: { roundOutcome: existingBet.roundOutcome, outcomeState: existingBet.outcomeState, profit: existingBet.profit } }
                ).catch(() => { });
              }
            } else if (!['B', 'P', 'T'].includes(existingBet.roundOutcome)) {
              existingBet.outcomeState = body;
              if (dbCollection) {
                dbCollection.updateOne(
                  { id: existingBet.id },
                  { $set: { outcomeState: existingBet.outcomeState } }
                ).catch(() => { });
              }
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, action: "OUTCOME_RECORDED", betId }));
          return;
        }

        // Find best target
        let bestTarget = "None";
        let bestEv = -999;
        const evSnapshot = body.mathematics?.evSnapshot || {};
        for (const [target, metricsMap] of Object.entries(evSnapshot)) {
          if (metricsMap.ev && metricsMap.ev > bestEv) {
            bestEv = metricsMap.ev;
            bestTarget = target;
          }
        }

        const betId = body.uuid || ("bet_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5));

        let payout = 1;
        if (bestTarget === "BankerBet" || bestTarget === "Banker") payout = 0.95;
        if (bestTarget === "TieBet" || bestTarget === "Tie") payout = 8;

        let recommendedBetAmount = 0;
        if (bestEv > 0) {
          let amount = 0;
          if (betConfig.method === 'flat') {
            amount = betConfig.startingBankroll * betConfig.flatRatio;
          } else {
            // Kelly
            let rawKelly = bestEv / payout;
            amount = betConfig.startingBankroll * betConfig.kellyFraction * rawKelly;
          }

          if (betConfig.rounding > 0) amount = Math.round(amount / betConfig.rounding) * betConfig.rounding;
          if (amount > betConfig.maxBet) amount = betConfig.maxBet;
          if (amount < betConfig.rounding && amount > 0) amount = betConfig.rounding;
          recommendedBetAmount = amount;
        }

        const betEntry = {
          id: betId,
          time: new Date().toISOString(),
          tableName: body.tableNumber,
          round: body.ocr?.roundNumber,
          target: bestTarget,
          ev: bestEv,
          targetModuleId: null,
          targetModule: "NONE",
          reasonState: body,
          executionState: null,
          outcomeState: null,
          outcome: !betConfig.autoBetEnabled ? "AUTOBET_OFF" : "QUEUED",
          recommendedBetAmount: recommendedBetAmount,
          actualBetAmount: "-",
          roundOutcome: "WAITING",
          profit: null
        };

        betLog.unshift(betEntry);
        if (betLog.length > MAX_BET_LOG) betLog.length = MAX_BET_LOG;

        if (dbCollection) {
          dbCollection.insertOne(betEntry).catch(() => { });
        }

        if (!betConfig.autoBetEnabled) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, action: "SKIPPED", reason: "Auto Bet is disabled", betId }));
          return;
        }

        centralBetQueue.push(betEntry);
        processCentralQueue();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, action: "QUEUED_CENTRALLY", betId }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/telemetry/shuffle")) {
      try {
        const body = await parseJSONBody(req);
        if (dbCollectionShuffles) {
          const shuffleEntry = {
            id: "shuffle_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
            time: new Date().toISOString(),
            tableName: body.tableName,
            reason: body.reason || "Shuffling detected",
            finalRound: body.finalRound || 0
          };
          dbCollectionShuffles.insertOne(shuffleEntry).catch(() => { });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, action: "SHUFFLE_RECORDED" }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/telemetry/bet-result")) {
      try {
        const body = await parseJSONBody(req);
        const bet = betLog.find(b => b.id === body.betId);
        if (bet) {
          bet.executionState = body;

          let placedAmtStr = String(body.betAmount || "").replace(/,/g, '');
          let placedAmt = parseFloat(placedAmtStr);
          let targetAmt = parseFloat(bet.recommendedBetAmount);

          if (body.status === "SUCCESS") {
            if (isNaN(placedAmt) || placedAmt <= 0) {
              bet.outcome = "UNPLACED";
            } else if (placedAmt !== targetAmt) {
              bet.outcome = "WRONG_AMOUNT";
            } else {
              bet.outcome = "SUCCESS";
            }
          } else {
            bet.outcome = "UNPLACED";
          }

          bet.actualBetAmount = body.betAmount || "-";
          bet.timer = body.timer != null ? body.timer : null;

          if (dbCollection) {
            dbCollection.updateOne(
              { id: bet.id },
              { $set: { outcome: bet.outcome, actualBetAmount: bet.actualBetAmount, executionState: bet.executionState, timer: bet.timer } }
            ).catch(() => { });
          }

          if (bet.targetModuleId) {
            const mod = activeModules.get(bet.targetModuleId);
            if (mod) {
              mod.isBusy = false;
              mod.busySince = null;
            }
          }

          processCentralQueue();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/clear-bet-logs")) {
      betLog.length = 0;
      if (dbCollection) {
        dbCollection.deleteMany({}).catch(() => { });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Cleared all bets" }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/config")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, config: betConfig }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/config")) {
      try {
        const body = await parseJSONBody(req);
        betConfig = { ...betConfig, ...body };
        saveConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, config: betConfig }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }


    if (req.method === "GET" && req.url.startsWith("/api/stats")) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const range = url.searchParams.get("range") || "all_time";
        const result = await compileStatsJSON(range);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/shuffles")) {
      try {
        if (!dbCollectionShuffles) throw new Error("DB not connected");

        const shuffles = await dbCollectionShuffles.find({}).sort({ time: 1 }).toArray();
        const dailyCounts = {};

        shuffles.forEach(s => {
          const t = new Date(s.time);
          let dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0, 0);
          if (t < dayStart) {
            dayStart.setDate(dayStart.getDate() - 1);
          }
          let dayEnd = new Date(dayStart);
          dayEnd.setDate(dayEnd.getDate() + 1);

          const options = { weekday: 'short', day: 'numeric', month: 'short' };
          const label = `${dayStart.toLocaleDateString('en-GB', options)}, 12:00 pm to ${dayEnd.toLocaleDateString('en-GB', options)}, 12:00 pm`;

          if (!dailyCounts[label]) dailyCounts[label] = { count: 0, finalRounds: [] };
          dailyCounts[label].count++;
          if (s.finalRound) dailyCounts[label].finalRounds.push(s.finalRound);
        });

        const sortedDays = Object.keys(dailyCounts).map(k => ({
          label: k,
          count: dailyCounts[k].count,
          finalRounds: dailyCounts[k].finalRounds
        })).reverse();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stats: sortedDays }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/api/refresh-success-rate")) {
      try {
        await updateSuccessRates();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, successRates: cachedSuccessRates }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/bets")) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const page = parseInt(url.searchParams.get("page")) || 1;
        const limit = parseInt(url.searchParams.get("limit")) || 100;
        const statusFilter = url.searchParams.get("status") || "ALL";
        const outcomeFilter = url.searchParams.get("outcome") || "ALL";
        const startFilter = url.searchParams.get("start");
        const endFilter = url.searchParams.get("end");

        const matchQ = {};
        if (statusFilter !== "ALL") {
          if (statusFilter === "NON_SUCCESS") {
            matchQ.outcome = { $ne: "SUCCESS" };
          } else {
            matchQ.outcome = statusFilter;
          }
        }
        if (outcomeFilter !== "ALL") {
          matchQ.roundOutcome = outcomeFilter;
        }
        if (startFilter || endFilter) {
          matchQ.time = {};
          if (startFilter) matchQ.time.$gte = startFilter;
          if (endFilter) matchQ.time.$lte = endFilter;
        }

        const skip = (page - 1) * limit;

        let lastUpdated = null;
        try {
          const stats = fs.statSync(path.join(ROOT, "eyes", "json", "tables_state.json"));
          lastUpdated = stats.mtime.toISOString();
        } catch (e) { }

        const onlineModules = Array.from(activeModules.values()).map(m => {
          const mid = m.moduleId;
          return {
            ...m,
            cumulativeProfit: cumulativeProfitMap[mid] || 0,
            todayProfit: todayProfitMap[mid] || 0
          };
        });

        let totalBets = 0;
        let paginatedBets = [];
        if (!dbCollection) {
          throw new Error("DB not connected yet");
        }

        totalBets = await dbCollection.countDocuments(matchQ);
        paginatedBets = await dbCollection.find(matchQ).sort({ time: -1 }).skip(skip).limit(limit).toArray();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          betLog: paginatedBets,
          totalBets: totalBets,
          activeModules: onlineModules,
          lastUpdated,
          successRates: cachedSuccessRates
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/reset-all") {
      if (!_stateManager) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No state manager" }));
        return;
      }
      for (const ts of _stateManager.tables.values()) {
        _stateManager._resetShoe(ts, "Manual reset all from dashboard");
      }

      sendWhatsAppNotification("[DASHBOARD] User manually reset ALL tables to fresh shoes.")
        .catch(err => console.error("WhatsApp Notification failed:", err));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "All tables reset" }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/reset?")) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const tableName = url.searchParams.get("table");

      if (!tableName || !_stateManager) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing table param" }));
        return;
      }

      const ts = _stateManager.getTable(tableName);
      if (!ts) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Table ${tableName} not found` }));
        return;
      }

      _stateManager._resetShoe(ts, "Manual reset from dashboard");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, table: tableName, deckRemaining: ts.remaining }));
      return;
    }

    // GET routes
    let filePath;
    if (req.url === "/" || req.url === "/index.html") {
      filePath = path.join(__dirname, "index.html");
    } else if (req.url === "/bets.html" || req.url === "/bets") {
      filePath = path.join(__dirname, "bets.html");
    } else if (req.url === "/stats.html" || req.url === "/stats") {
      filePath = path.join(__dirname, "stats.html");
    } else if (req.url.startsWith("/tables_state.json")) {
      filePath = path.join(ROOT, "eyes", "json", "tables_state.json");
    } else if (req.url === "/favicon.ico") {
      filePath = path.join(__dirname, "favicon.ico");
    } else {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    let contentType = "application/json";
    if (ext === ".html") contentType = "text/html";
    else if (ext === ".ico") contentType = "image/x-icon";

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("File not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  });

  server.listen(PORT, () => {
    console.log(`Dashboard → http://localhost:${PORT}`);
  });
}

module.exports = { startDashboard };

if (require.main === module) {
  startDashboard(null);
}
