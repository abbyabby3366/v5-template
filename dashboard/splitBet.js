/**
 * splitBet.js — Split Bet Resolution & Dispatch for Pretty Gaming
 *
 * This module handles the logic for splitting a single bet signal across
 * two different bet accounts simultaneously: a "Fixed" account and a "Variable" account.
 *
 * ─────────────────────────────────────────────────────────────
 * ACCOUNT TYPES (configured per account in bet_accounts.json):
 * ─────────────────────────────────────────────────────────────
 *
 *   "fixed"    — Can only bet pre-set chip amounts (e.g. [5000, 10000, 15000, 20000]).
 *                Configured via "betType": "fixed" + "allowedFixedAmounts": [...].
 *
 *   "variable" — Bets whatever amount is instructed (default if no betType is set).
 *
 * ─────────────────────────────────────────────────────────────
 * SPLIT FLOW:
 * ─────────────────────────────────────────────────────────────
 *
 *   1. Central receives a bet with a recommended total stake (e.g. 23,500)
 *   2. resolveReadyModules() filters online, non-busy, accepting modules
 *   3. resolveSplitBetTargets() separates modules into Fixed & Variable pools:
 *
 *      a) BOTH pools have modules → SPLIT the bet:
 *         - Pick a Fixed module (round-robin)
 *         - Pick a Variable module (round-robin)
 *         - Randomly select a fixed amount from allowedFixedAmounts (≤ totalStake)
 *         - Variable gets the rounded remainder
 *         - Example: Total=23500 → Fixed picks 10000 → Variable gets 13500
 *
 *      b) Only ONE pool online → NO SPLIT, send full amount to that module
 *
 *   4. dispatchBet() handles the actual HTTP dispatch:
 *      - Split: creates sub-bets with IDs {parentId}_0 (fixed) and {parentId}_1 (variable)
 *        - Fixed sub-bet dispatched immediately
 *        - Variable sub-bet dispatched after a random jitter delay (SPLIT_BET_DELAY_MS env)
 *        - Parent bet marked outcome="SPLIT"
 *      - Single: dispatched directly, no splitting
 *
 * ─────────────────────────────────────────────────────────────
 * USAGE:
 * ─────────────────────────────────────────────────────────────
 *
 *   const { resolveSplitBetTargets, dispatchBet } = require("./splitBet");
 *
 *   const splitResult = resolveSplitBetTargets(totalStake, activeModules, betConfig);
 *   if (splitResult) {
 *     dispatchBet(splitResult, betEntry, { activeModules, betLog, MAX_BET_LOG, dbCollection, onRetry });
 *   }
 */

// ─────────────────────────────────────────────────────────────
// Round-Robin State (module-scoped, persists across calls)
// ─────────────────────────────────────────────────────────────

let lastFixedRoundRobinIndex = -1;
let lastFixedRoundRobinModuleIds = [];
let lastUsedFixedModuleId = null;

let lastVariableRoundRobinIndex = -1;
let lastVariableRoundRobinModuleIds = [];
let lastUsedVariableModuleId = null;

// ─────────────────────────────────────────────────────────────
// resolveReadyModules()
// ─────────────────────────────────────────────────────────────
// Filters the active modules map down to only those that are:
//   - Heartbeat received within last 12s
//   - Not currently busy (or busy-stuck > 60s → auto-cleared)
//   - Balance above betConfig.minAccountBalance (if set)
//   - At least one account is accepting bets
// ─────────────────────────────────────────────────────────────

function resolveReadyModules(activeModules, betConfig) {
  const now = Date.now();

  let online = Array.from(activeModules.values()).filter((m) => {
    // Timeout stuck busy modules (e.g. > 60s)
    if (m.isBusy && m.busySince && now - m.busySince > 60000) {
      m.isBusy = false;
      m.busySince = null;
    }
    return now - m.lastHeartbeat < 12000 && !m.isBusy;
  });

  if (betConfig.minAccountBalance != null && betConfig.minAccountBalance > 0) {
    online = online.filter((m) => {
      if (m.accounts && m.accounts.length > 0) {
        const hasLowBalance = m.accounts.some((acc) => {
          if (acc.balance != null) {
            const cleanBalance = String(acc.balance).replace(/[^0-9.]/g, "");
            const parsedBalance = parseFloat(cleanBalance);
            if (!isNaN(parsedBalance)) {
              return parsedBalance < betConfig.minAccountBalance;
            }
          }
          return false;
        });
        return !hasLowBalance;
      }
      return true;
    });
  }

  // ONLY allow modules that are fully launched and accepting bets
  online = online.filter((m) => {
    if (m.accounts && m.accounts.length > 0) {
      return m.accounts.some((acc) => acc.isAcceptingBets === true);
    }
    return false;
  });

  return online;
}

// ─────────────────────────────────────────────────────────────
// resolveSplitBetTargets(totalStake, activeModules, betConfig)
// ─────────────────────────────────────────────────────────────
// Returns one of:
//
//   { isSplit: true, fixedTarget, fixedAmount, variableTarget, variableAmount }
//     → Both Fixed and Variable modules are online. Bet is split.
//
//   { isSplit: false, target, amount }
//     → Only one pool type is online. No split, single dispatch.
//
//   null
//     → No modules available at all.
// ─────────────────────────────────────────────────────────────

function resolveSplitBetTargets(totalStake, activeModules, betConfig) {
  const online = resolveReadyModules(activeModules, betConfig);
  if (online.length === 0) return null;

  // Debug: log what betType each ready module is reporting
  console.log(`\x1b[90m[SplitBet] Ready modules (${online.length}):${online.map(m => {
    const acc = m.accounts[0];
    return ` ${m.moduleId} [betType=${acc ? acc.betType : 'NONE'}]`;
  }).join(',')}\x1b[0m`);

  // Separate online modules into Fixed and Variable pools
  const fixedModules = online.filter((m) => {
    const acc = m.accounts[0];
    return acc && acc.betType === "fixed";
  });

  const variableModules = online.filter((m) => {
    const acc = m.accounts[0];
    return !acc || acc.betType !== "fixed"; // default is variable
  });

  console.log(`\x1b[90m[SplitBet] Pools → Fixed: ${fixedModules.length}, Variable: ${variableModules.length} | Stake: ${totalStake}\x1b[0m`);

  // ── Case 1: Both Fixed AND Variable modules are online → SPLIT ──
  if (fixedModules.length > 0 && variableModules.length > 0) {
    // Pick a Fixed module using Round-Robin
    const fixedTarget = pickRoundRobin(fixedModules, {
      getIndex: () => lastFixedRoundRobinIndex,
      setIndex: (i) => { lastFixedRoundRobinIndex = i; },
      getIds: () => lastFixedRoundRobinModuleIds,
      setIds: (ids) => { lastFixedRoundRobinModuleIds = ids; },
      getLastUsed: () => lastUsedFixedModuleId,
      setLastUsed: (id) => { lastUsedFixedModuleId = id; },
    });

    // Pick a Variable module using Round-Robin
    const variablePickTarget = pickRoundRobin(variableModules, {
      getIndex: () => lastVariableRoundRobinIndex,
      setIndex: (i) => { lastVariableRoundRobinIndex = i; },
      getIds: () => lastVariableRoundRobinModuleIds,
      setIds: (ids) => { lastVariableRoundRobinModuleIds = ids; },
      getLastUsed: () => lastUsedVariableModuleId,
      setLastUsed: (id) => { lastUsedVariableModuleId = id; },
    });

    // Perform split allocation
    const allowedFixed =
      (fixedTarget.module.accounts[0] && fixedTarget.module.accounts[0].allowedFixedAmounts) || [
        5000, 10000, 15000, 20000,
      ];

    // Find valid fixed steps that are ≤ totalStake
    const validSteps = allowedFixed.filter((val) => val <= totalStake);

    if (validSteps.length > 0) {
      const randomIndex = Math.floor(Math.random() * validSteps.length);
      const fixedAmount = validSteps[randomIndex];

      let variableRemainder = totalStake - fixedAmount;

      const rounding = betConfig.rounding || 100;
      if (variableRemainder > 0 && rounding > 0) {
        variableRemainder = Math.round(variableRemainder / rounding) * rounding;
      }

      const minBet = betConfig.minBet || 0;

      // If variable remainder is 0 or below minBet, skip the variable leg entirely
      if (variableRemainder <= 0 || (minBet > 0 && variableRemainder < minBet)) {
        console.log(`\x1b[33m[SplitBet] Variable remainder ${variableRemainder} is below minBet (${minBet}). Sending only fixed leg to ${fixedTarget.module.accounts[0].label || fixedTarget.module.moduleId}.\x1b[0m`);
        return {
          isSplit: false,
          target: {
            baseUrl: fixedTarget.module.baseUrl,
            moduleId: fixedTarget.module.moduleId,
            label: fixedTarget.module.accounts[0].label || fixedTarget.module.moduleId,
          },
          amount: fixedAmount,
        };
      }

      return {
        isSplit: true,
        fixedTarget: {
          baseUrl: fixedTarget.module.baseUrl,
          moduleId: fixedTarget.module.moduleId,
          label: fixedTarget.module.accounts[0].label || fixedTarget.module.moduleId,
        },
        fixedAmount: fixedAmount,
        variableTarget: {
          baseUrl: variablePickTarget.module.baseUrl,
          moduleId: variablePickTarget.module.moduleId,
          label: variablePickTarget.module.accounts[0].label || variablePickTarget.module.moduleId,
        },
        variableAmount: variableRemainder,
      };
    } else {
      // No fixed step is ≤ totalStake → send all to variable
      return {
        isSplit: false,
        target: {
          baseUrl: variablePickTarget.module.baseUrl,
          moduleId: variablePickTarget.module.moduleId,
          label: variablePickTarget.module.accounts[0].label || variablePickTarget.module.moduleId,
        },
        amount: totalStake,
      };
    }
  }

  // ── Case 2: Only Fixed modules are online ──
  if (fixedModules.length > 0 && variableModules.length === 0) {
    const picked = pickRoundRobin(fixedModules, {
      getIndex: () => lastFixedRoundRobinIndex,
      setIndex: (i) => { lastFixedRoundRobinIndex = i; },
      getIds: () => lastFixedRoundRobinModuleIds,
      setIds: (ids) => { lastFixedRoundRobinModuleIds = ids; },
      getLastUsed: () => lastUsedFixedModuleId,
      setLastUsed: (id) => { lastUsedFixedModuleId = id; },
    });
    return {
      isSplit: false,
      target: {
        baseUrl: picked.module.baseUrl,
        moduleId: picked.module.moduleId,
        label: picked.module.accounts[0].label || picked.module.moduleId,
      },
      amount: totalStake,
    };
  }

  // ── Case 3: Only Variable modules are online ──
  if (variableModules.length > 0 && fixedModules.length === 0) {
    const picked = pickRoundRobin(variableModules, {
      getIndex: () => lastVariableRoundRobinIndex,
      setIndex: (i) => { lastVariableRoundRobinIndex = i; },
      getIds: () => lastVariableRoundRobinModuleIds,
      setIds: (ids) => { lastVariableRoundRobinModuleIds = ids; },
      getLastUsed: () => lastUsedVariableModuleId,
      setLastUsed: (id) => { lastUsedVariableModuleId = id; },
    });
    return {
      isSplit: false,
      target: {
        baseUrl: picked.module.baseUrl,
        moduleId: picked.module.moduleId,
        label: picked.module.accounts[0].label || picked.module.moduleId,
      },
      amount: totalStake,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// pickRoundRobin(modules, state)
// ─────────────────────────────────────────────────────────────
// Generic round-robin picker. Uses state accessors to persist
// the index/IDs across calls.
// ─────────────────────────────────────────────────────────────

function pickRoundRobin(modules, state) {
  const currentIds = modules.map((m) => m.moduleId).sort();
  const idsChanged = JSON.stringify(currentIds) !== JSON.stringify(state.getIds());

  if (idsChanged) {
    state.setIds(currentIds);
    const lastUsed = state.getLastUsed();
    if (lastUsed) {
      const lastPos = currentIds.indexOf(lastUsed);
      state.setIndex(lastPos >= 0 ? lastPos : -1);
    } else {
      state.setIndex(-1);
    }
  }

  const nextIndex = (state.getIndex() + 1) % currentIds.length;
  state.setIndex(nextIndex);

  const moduleId = currentIds[nextIndex];
  const module = modules.find((m) => m.moduleId === moduleId);
  state.setLastUsed(moduleId);

  return { module, moduleId };
}

// ─────────────────────────────────────────────────────────────
// dispatchBet(splitResult, betEntry, deps)
// ─────────────────────────────────────────────────────────────
// Dispatches a resolved bet to the target module(s).
//
// deps = {
//   activeModules,  — the Map of active modules
//   betLog,         — in-memory bet log array
//   MAX_BET_LOG,    — max log size
//   dbCollection,   — MongoDB collection (or null)
//   onRetry,        — callback to retry queue processing
// }
// ─────────────────────────────────────────────────────────────

function dispatchBet(splitResult, betEntry, deps) {
  const { activeModules, betLog, MAX_BET_LOG, dbCollection, onRetry } = deps;

  if (splitResult.isSplit) {
    dispatchSplitBet(splitResult, betEntry, deps);
  } else {
    dispatchSingleBet(splitResult, betEntry, deps);
  }
}

// ─────────────────────────────────────────────────────────────
// dispatchSplitBet()
// ─────────────────────────────────────────────────────────────
// Creates two sub-bets (_0 for fixed, _1 for variable),
// dispatches the fixed one immediately and the variable one
// after a random jitter delay.
// ─────────────────────────────────────────────────────────────

function dispatchSplitBet(splitResult, betEntry, deps) {
  const { activeModules, betLog, MAX_BET_LOG, dbCollection } = deps;
  const { fixedTarget, fixedAmount, variableTarget, variableAmount } = splitResult;

  // ── Log the split summary ──
  const splitTs = new Date().toISOString();
  console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  🔀 SPLIT BET DISPATCH                                      ║`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Bet ID      : ${betEntry.id}`);
  console.log(`║  Timestamp   : ${splitTs}`);
  console.log(`║  Target Side : ${betEntry.target}`);
  console.log(`║  ────────────────────────────────────────────────────────── ║`);
  console.log(`║  Total Stake : ${betEntry.recommendedBetAmount}`);
  console.log(`║  Fixed Amt   : ${fixedAmount}  → ${fixedTarget.label}`);
  console.log(`║  Variable Amt: ${variableAmount}  → ${variableTarget.label}`);
  console.log(`║  ────────────────────────────────────────────────────────── ║`);
  console.log(`║  Fixed Module  : ${fixedTarget.moduleId} (${fixedTarget.baseUrl})`);
  console.log(`║  Variable Module: ${variableTarget.moduleId} (${variableTarget.baseUrl})`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\x1b[0m\n`);

  // Flag both modules as busy
  const fixedMod = activeModules.get(fixedTarget.moduleId);
  if (fixedMod) {
    fixedMod.isBusy = true;
    fixedMod.busySince = Date.now();
  }
  const varMod = activeModules.get(variableTarget.moduleId);
  if (varMod) {
    varMod.isBusy = true;
    varMod.busySince = Date.now();
  }

  // Create sub-bet for Fixed account (suffix _0)
  const fixedBet = {
    ...betEntry,
    id: `${betEntry.id}_0`,
    recommendedBetAmount: fixedAmount,
    targetModuleId: fixedTarget.moduleId,
    targetModule: fixedTarget.label,
    outcome: "PENDING"
  };
  delete fixedBet._id; // Prevent duplicate key error in MongoDB

  // Create sub-bet for Variable account (suffix _1)
  const variableBet = {
    ...betEntry,
    id: `${betEntry.id}_1`,
    recommendedBetAmount: variableAmount,
    targetModuleId: variableTarget.moduleId,
    targetModule: variableTarget.label,
    outcome: "PENDING"
  };
  delete variableBet._id;

  // Push both to betLog in-memory
  betLog.unshift(fixedBet);
  betLog.unshift(variableBet);
  if (betLog.length > MAX_BET_LOG) betLog.length = MAX_BET_LOG;

  // Update parent original bet state to SPLIT
  betEntry.outcome = "SPLIT";
  betEntry.executionState = { status: "SPLIT", reason: `Split into ${fixedBet.id} and ${variableBet.id}` };

  if (dbCollection) {
    dbCollection.insertOne(fixedBet).catch(() => {});
    dbCollection.insertOne(variableBet).catch(() => {});
    dbCollection.updateOne(
      { id: betEntry.id },
      { $set: { outcome: betEntry.outcome, executionState: betEntry.executionState } }
    ).catch(() => {});
  }

  // ── Dispatch Fixed bet immediately ──
  const fixedDispatchTs = new Date().toISOString();
  console.log(`\x1b[32m[Central] [FIXED DISPATCH]  Sent at ${fixedDispatchTs} → ${fixedTarget.label} | Amount: ${fixedAmount} | Sub-ID: ${fixedBet.id}\x1b[0m`);

  fetch(fixedTarget.baseUrl + "/prettygaming/bet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fixedBet)
  }).then(async (resp) => {
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try { const body = await resp.json(); errMsg = body.error || errMsg; } catch (e) { }
      console.error(`[Central] Fixed Split Bet dispatch to ${fixedTarget.label} rejected: ${errMsg}`);
      fixedBet.outcome = "DISPATCH_FAILED";
      fixedBet.executionState = { status: "DISPATCH_FAILED", reason: errMsg };
      if (fixedMod) {
        fixedMod.isBusy = false;
        fixedMod.busySince = null;
      }
      if (dbCollection) {
        dbCollection.updateOne(
          { id: fixedBet.id },
          { $set: { outcome: fixedBet.outcome, executionState: fixedBet.executionState } }
        ).catch(() => { });
      }
    }
  }).catch(err => {
    console.error("[Central] Failed to dispatch Fixed split bet:", err.message);
    fixedBet.outcome = "NETWORK_ERROR";
    fixedBet.executionState = { status: "NETWORK_ERROR", reason: err.message };
    if (fixedMod) {
      fixedMod.isBusy = false;
      fixedMod.busySince = null;
    }
    if (dbCollection) {
      dbCollection.updateOne(
        { id: fixedBet.id },
        { $set: { outcome: fixedBet.outcome, executionState: fixedBet.executionState } }
      ).catch(() => { });
    }
  });

  // ── Dispatch Variable bet after jitter delay ──
  const delayParts = (process.env.SPLIT_BET_DELAY_MS || "200,800").split(",");
  const delayMin = parseInt(delayParts[0], 10) || 200;
  const delayMax = parseInt(delayParts[1], 10) || 800;
  const jitterDelay = Math.floor(Math.random() * (delayMax - delayMin) + delayMin);

  console.log(`\x1b[33m[Central] [VARIABLE DELAYED] Jitter: ${jitterDelay}ms (range: ${delayMin}-${delayMax}ms) | Will send to ${variableTarget.label} | Amount: ${variableAmount} | Sub-ID: ${variableBet.id}\x1b[0m`);

  setTimeout(() => {
    const varDispatchTs = new Date().toISOString();
    console.log(`\x1b[35m[Central] [VARIABLE DISPATCH] Sent at ${varDispatchTs} → ${variableTarget.label} | Amount: ${variableAmount} | Sub-ID: ${variableBet.id} | Actual delay: ${jitterDelay}ms\x1b[0m`);

    fetch(variableTarget.baseUrl + "/prettygaming/bet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(variableBet)
    }).then(async (resp) => {
      if (!resp.ok) {
        let errMsg = `HTTP ${resp.status}`;
        try { const body = await resp.json(); errMsg = body.error || errMsg; } catch (e) { }
        console.error(`[Central] Variable Split Bet dispatch to ${variableTarget.label} rejected: ${errMsg}`);
        variableBet.outcome = "DISPATCH_FAILED";
        variableBet.executionState = { status: "DISPATCH_FAILED", reason: errMsg };
        if (varMod) {
          varMod.isBusy = false;
          varMod.busySince = null;
        }
        if (dbCollection) {
          dbCollection.updateOne(
            { id: variableBet.id },
            { $set: { outcome: variableBet.outcome, executionState: variableBet.executionState } }
          ).catch(() => { });
        }
      }
    }).catch(err => {
      console.error("[Central] Failed to dispatch Variable split bet:", err.message);
      variableBet.outcome = "NETWORK_ERROR";
      variableBet.executionState = { status: "NETWORK_ERROR", reason: err.message };
      if (varMod) {
        varMod.isBusy = false;
        varMod.busySince = null;
      }
      if (dbCollection) {
        dbCollection.updateOne(
          { id: variableBet.id },
          { $set: { outcome: variableBet.outcome, executionState: variableBet.executionState } }
        ).catch(() => { });
      }
    });
  }, jitterDelay);
}

// ─────────────────────────────────────────────────────────────
// dispatchSingleBet()
// ─────────────────────────────────────────────────────────────
// Single module fallback — sends the full stake to one module.
// Used when only one pool type (fixed-only or variable-only) is online.
// ─────────────────────────────────────────────────────────────

function dispatchSingleBet(splitResult, betEntry, deps) {
  const { activeModules, dbCollection, onRetry } = deps;
  const { target, amount } = splitResult;

  console.log(`[Central] Dispatching single fallback bet ${betEntry.id} to ${target.label} for stake: ${amount}`);

  const mod = activeModules.get(target.moduleId);
  if (mod) {
    mod.isBusy = true;
    mod.busySince = Date.now();
  }

  betEntry.targetModuleId = target.moduleId;
  betEntry.targetModule = target.label;
  betEntry.recommendedBetAmount = amount;
  betEntry.outcome = "PENDING";

  if (dbCollection) {
    dbCollection.updateOne(
      { id: betEntry.id },
      { $set: { targetModuleId: betEntry.targetModuleId, targetModule: betEntry.targetModule, outcome: betEntry.outcome, recommendedBetAmount: amount } }
    ).catch(() => { });
  }

  fetch(target.baseUrl + "/prettygaming/bet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(betEntry)
  }).then(async (resp) => {
    if (!resp.ok) {
      let errMsg = `HTTP ${resp.status}`;
      try { const body = await resp.json(); errMsg = body.error || errMsg; } catch (e) { }
      console.error(`[Central] Bet dispatch to ${target.label} rejected: ${errMsg}`);
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
    console.error("[Central] Failed to dispatch fallback bet:", err.message);
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
    if (onRetry) onRetry();
  });
}

module.exports = {
  resolveReadyModules,
  resolveSplitBetTargets,
  dispatchBet,
};
