# Bet Module Integration Guide: Balance, Betting, and Session Tracking

> [!NOTE]
> ### ⚡ Executive Summary (TL;DR)
> The `bet_module` is a headless betting engine. It operates sequentially using a background FIFO queue to prevent race conditions. The core functions use Puppeteer to bridge Node.js execution into the Chromium browser window, targeting APIs directly to eliminate flaky DOM-selector dependency:
> 1. **Check Balance**: Scrapes the in-memory Vue/Pinia store balance or falls back to direct Profile & Balance REST API requests.
> 2. **Place Bet**: Validates funds, extracts table constraints, triggers `userPlaceBet` endpoint, and confirms successful balance deductions.
> 3. **Resolve Session (Listen for Bet & Timer)**: Fetches API mappings, accesses raw WebSocket caches across frames, and extracts active game IDs and betting countdown timers.

---

## 🏗️ Module Architecture & Execution Flow

```
   HTTP POST /prettygaming/bet 
                 │
                 ▼
     ┌──────────────────────┐
     │  betQueueProcessor   │ ◄─── Sequential FIFO Queue Loop
     └───────────┬──────────┘
                 │ (Pops next bet)
                 ▼
     ┌──────────────────────┐
     │    executeBet.js     │ ◄─── Main Betting Orchestrator
     └─────┬─────┬─────┬────┘
           │     │     │
           │     │     └─► 3. resolveActiveGameSession (Reads timer, gameId across frames)
           │     │
           │     └───────► 2. submitBetAndConfirm (Triggers placeBet REST transaction)
           │
           └─────────────► 1. fetchBalance.js (Reads Pinia store or fallback REST endpoints)
```

1. **`launcher.js`**: Reads account credentials (`bet_accounts.json`) and spawns the node process running `server.js` with dedicated `BET_PORT` and `ACCOUNT_INDEX` variables.
2. **`server.js`**: Exposes a REST API (`POST /prettygaming/bet`) to receive recommendations, schedules them into the `BetQueueProcessor`, and maintains periodic background loops for balance synchronization and heartbeats.
3. **`src/betQueueProcessor.js`**: Standardizes the execution parameters and triggers `executeBet.js` sequentially. Tracks consecutive errors to trigger self-healing browser context restarts.

---

## 🛠️ Step-by-Step Implementation of the 3 Core Functions

### 1. Check Balance (`fetchBalance.js`)
This function queries the active user balance directly from the browser context without relying on slow or unstable DOM scraping.

```javascript
/**
 * Retrieves the current balance from the page session.
 * @param {import('puppeteer').Page} page 
 * @returns {Promise<number|null>} 
 */
async function fetchAccountBalance(page) {
  // Bridge execution context to the page sandbox
  return await page.evaluate(async () => {
    const API_BASE = "https://member-api.aghippo168.com";

    // A. Extract Token from LocalStorage, SessionStorage, or Cookies
    const token = getAuthToken(); 
    if (!token) return null;

    const headers = {
      "Content-Type": "application/json",
      "authorization": token
    };

    // B. First Choice: Query the active Vue/Pinia in-memory store
    const pinia = getPiniaStore();
    if (pinia?.state?.value?.global) {
      const piniaBal = pinia.state.value.global.profile?.balance;
      if (piniaBal !== undefined && piniaBal !== null) {
        return parseFloat(piniaBal);
      }
    }

    // C. Second Choice: Call the secure Profile & Balance REST APIs directly
    try {
      const profile = await fetch(`${API_BASE}/apiRoute/member/profile`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ lang: "en" })
      }).then(r => r.json());

      if (profile?._id) {
        const balRes = await fetch(`${API_BASE}/apiRoute/member/viewBalance/${profile._id}`, {
          method: "GET",
          headers: headers
        }).then(r => r.json());

        if (balRes && typeof balRes.balance !== 'undefined') {
          const balVal = parseFloat(balRes.balance);
          
          // Write back to Pinia to keep browser UI in-sync
          if (pinia?.state?.value?.global) {
            pinia.state.value.global.profile.balance = balVal;
          }
          return balVal;
        }
      }
    } catch (e) {
      // Direct REST fallback failed
    }
    return null;
  });
}
```

---

### 2. Place Bet (`executeBet.js` / `submitBetAndConfirm`)
Pushes the transactional bet placement array to the game server. Relies heavily on pre-bet balance verification and post-bet confirmations.

```javascript
/**
 * Places the bet transaction via REST, syncs balance, and returns result indicators.
 * @param {import('puppeteer').Page} page 
 * @param {Object} betConfig - { tableName, betType, targetAmount }
 * @param {string} gameId - Active game round identifier
 * @param {number} limitId - Account limit identifier
 * @param {number|null} balanceBefore - Starting funds
 * @returns {Promise<{success: boolean, reason?: string, betAmount?: string, balance?: string}>}
 */
async function submitBetAndConfirm(page, betConfig, gameId, limitId, balanceBefore) {
  return await page.evaluate(async (config, gId, limId, balBefore) => {
    const API_BASE = "https://member-api.aghippo168.com";
    const token = getAuthToken();
    if (!token) return { success: false, reason: "Authorization token not found" };

    const headers = {
      "Content-Type": "application/json",
      "authorization": token
    };

    // A. Guard check: Prevent placement if balance is strictly insufficient
    const betVal = parseInt(config.targetAmount, 10);
    if (balBefore !== null && !isNaN(betVal) && balBefore < betVal) {
      return { success: false, reason: `Insufficient funds (have ${balBefore}, need ${betVal})` };
    }

    // B. Build standard positioning mapping (map "Player" -> "player", "PlayerBet" -> "player", etc.)
    const formattedPosition = mapPositionToContract(config.betType);

    const payload = {
      betLimit: limId,
      gameId: gId,
      type: "Baccarat",
      txts: [{ position: formattedPosition, betValue: betVal }]
    };

    // C. Execute placement request
    try {
      const res = await fetch(`${API_BASE}/apiRoute/transaction/userPlaceBet`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
      }).then(r => r.json());

      const success = res && res.code === 0;
      const reason = success ? undefined : (res?.msg || `Lobby error code: ${res?.code}`);

      // D. Verify new balance immediately to validate deduction
      let balanceAfter = await queryBalanceViaAPI(headers);
      
      // Update Pinia store to ensure browser UI reflects new balance
      const pinia = getPiniaStore();
      if (balanceAfter !== null && pinia?.state?.value?.global) {
        pinia.state.value.global.profile.balance = balanceAfter;
      }

      return {
        success: success,
        reason: reason,
        betAmount: success ? String(betVal) : undefined,
        balance: balanceAfter !== null ? String(balanceAfter) : String(balBefore || "")
      };
    } catch (err) {
      return { success: false, reason: `Network error: ${err.message}` };
    }
  }, betConfig, gameId, limitId, balanceBefore);
}
```

---

### 3. Resolve Session & Live Status (`resolveActiveGameSession`)
Before a bet is placed, this function extracts crucial session markers. It evaluates if the bet is valid based on the active table, betting time, and current round.

```javascript
/**
 * Resolves active table constraints, WebSocket timers, and active game ID.
 * @param {import('puppeteer').Page} page 
 * @param {string} tableName - Target friendly name
 * @returns {Promise<{gameId: string|null, canonicalRoomId: string|null, timeLeft: number|null, limitId: number|null}>}
 */
async function resolveActiveGameSession(page, tableName) {
  return await page.evaluate(async (targetName) => {
    const API_BASE = "https://member-api.aghippo168.com";
    const token = getAuthToken();
    if (!token) return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };

    const headers = { "Content-Type": "application/json", "authorization": token };

    // A. Query active table profiles to resolve roomId & limit configs
    const tables = await fetch(`${API_BASE}/apiRoute/table/getAllBac`, { headers }).then(r => r.json());
    if (tables?.code !== 0 || !Array.isArray(tables.data)) {
      return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };
    }

    const tObj = tables.data.find(t => t.name === targetName || t.tableNumber === targetName);
    if (!tObj) return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };

    const canonicalRoomId = tObj.roomId;
    const limitId = tObj.limitObj?.limitId || 3016;

    // B. Crawl across all iframe frames to read WebSocket caches
    let wsData = getSocketDataAcrossFrames(canonicalRoomId);

    // C. Fallback: Search Pinia stores to retrieve the live WebSocket payload
    const pinia = getPiniaStore();
    if (!wsData && pinia?.state?.value) {
      wsData = searchPiniaForSocketData(pinia, canonicalRoomId);
    }

    const timeLeft = wsData && wsData.timeLeft !== undefined ? wsData.timeLeft : null;
    let gameId = (wsData && wsData.gameId) || tObj.gameId;

    // D. Second Fallback: Inspect Baccarat Nuxt stores directly for gameId
    if (!gameId && pinia?.state?.value) {
      gameId = searchPiniaForBaccaratStoreGameId(pinia, canonicalRoomId);
    }

    return { gameId, canonicalRoomId, timeLeft, limitId };
  }, tableName);
}
```

---

## ⚠️ Critical Interceptor & Session Fallback Constraints

To ensure zero-error execution, the AI implementing these functions must adhere to the following rules:

1. **Cross-Frame Traversal**: WebSocket cache objects (`window.__tableStatesCache`) are often trapped within isolated iframe elements. Always traverse `window`, `window.parent`, `window.top`, and search all `document.querySelectorAll('iframe')` content windows:
   ```javascript
   function getSocketDataAcrossFrames(roomId) {
     const windows = [window, window.parent, window.top];
     document.querySelectorAll('iframe').forEach(f => {
       if (f.contentWindow) windows.push(f.contentWindow);
     });
     for (const w of windows) {
       try {
         if (w.__tableStatesCache?.[roomId]) return w.__tableStatesCache[roomId];
       } catch (e) { /* cross-origin safety catch */ }
     }
     return null;
   }
   ```
2. **Post-Bet Verification**: Never assume a bet is successful solely because the HTTP response code is `0`. Check and compare the balance before and after placement. If the balance remains unchanged after a successful API response, report a verification error.
3. **Execution Locks**: Because multiple table updates happen concurrently, the `BetQueueProcessor` **must** lock the processing thread (`isBetInProgress = true`) until both the transaction and balance confirmations are fully complete.

---

## 🛡️ Reliability Watchdogs & Modular Page Checks

To prevent stale or uninitialized browser sessions and guarantee continuous service, the bet module implements a dedicated page check framework defined in [pageCheck.js](file:///c:/Users/desmo/Desktop/v5-template/bet_module/src/pageCheck.js). This framework exports the following checks:

### 1. Readiness Check (`runReadinessCheck`)
* **Trigger**: Runs during the browser startup sequence in `BrowserController.launch()`.
* **Condition**: Waits up to 15 seconds (using Puppeteer's `page.waitForFunction`) for the underlying Laya game engine to compile and register active `playerInfo` on the global `window` object.
* **Success Action**: Defer setting `isBrowserReady = true` until `window.playerInfo` is successfully detected, ensuring the API routes are only accessible when the game engine is fully operational.
* **Failure Action**: If the game engine fails to initialize within 15 seconds:
  1. Raises a critical readiness check error.
  2. Sends an immediate WhatsApp alert notification.
  3. Closes the browser context to prevent memory/zombie tab leaks.
  4. Rotates the configuration and starts a clean recovery session on the next account index.

### 2. Liveness Check (`runLivenessCheck`)
* **Trigger**: Executed inside `updateBalance()` every 5 seconds in `server.js`.
* **Condition**: Monitors consecutive balance extraction failures from the active page using `fetchAccountBalance()`.
* **Failure Action**: If balance retrieval fails 3 consecutive times ($\ge 15$ seconds of failure), it triggers a liveness failure alert:
  1. Sends a critical WhatsApp notification to the operator.
  2. Sets `page.closeReason = "Liveness check failed: consecutive balance failures"`.
  3. Invokes the `onFail` callback which resets the failure count and calls `sessionManager.triggerRestart()` to cycle and rotate the account.
* **Rotation Guard**: The failure counter automatically resets to 0 whenever a successful balance is retrieved or when a new active account configuration is loaded by the rotator.

