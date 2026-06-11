# How to Create a Working Interceptor for the `eyes` Module

> [!NOTE]
> ### ⚡ Executive Summary (TL;DR)
> The client-side Interceptor is a JavaScript payload injected into the target lobby browser page. Its role is two-fold:
> 1. **Initial Extract**: Populates `window.__tableStatesCache` with current states on startup.
> 2. **Real-time Listen**: Hooks network and state layers (WS, Socket.io, Pinia) to detect live events, map room IDs, normalize parameters, and trigger the Node.js callback `window.onTableStateUpdate(table)`.
> 
> Follow this blueprint to construct an interceptor that integrates with `runEyes.js`, `tableManager.js`, and `evCalculator.js`.

---

## 🔗 The Node.js-to-Browser Bridge Architecture

The backend supervisor (`launcher.js` and `runEyes.js`) uses Puppeteer to manage the lifecycle of the browser and interceptor. Understanding this connection is vital for building a functional interceptor:

```
+-----------------------------------------------------------+
|                   Node.js Backend Engine                  |
|  - tableManager.js  - evCalculator.js                     |
+-----------------------------+-----------------------------+
                              |
                     Puppeteer exposing / injecting
                              v
+-----------------------------------------------------------+
|                  Target Browser Page                      |
|                                                           |
|   1. Global Cache: `window.__tableStatesCache`            |
|   2. Parser Hook:  `window.getParsedTable(roomId)`        |
|   3. Callback:     `window.onTableStateUpdate(table)`     |
|                                                           |
|   +---------------------------------------------------+   |
|   |         Active Interceptor Injection              |   |
|   |  - Hook WebSocket  - Hook Socket.io  - Hook Pinia |   |
|   +---------------------------------------------------+   |
+-----------------------------------------------------------+
```

### 1. Injected Code Execution
`launcher.js` reads the interceptor script from disk and evaluates it on the page during page creation and upon navigation:
* `await page.evaluate(extractorCode)`
* `await page.evaluateOnNewDocument(extractorCode)`

### 2. Live Update Event Callback
`runEyes.js` exposes a Node function to the browser window under the name `onTableStateUpdate`:
* When the interceptor catches an update in the browser, it **must** call:
  ```javascript
  if (typeof window.onTableStateUpdate === "function") {
    window.onTableStateUpdate(parsedTableStateObject);
  }
  ```

### 3. Initial State Priming
During a launch or seamless page recovery, the engine directly queries the interceptor's cache to pull current states without waiting for live network packets:
```javascript
const allParsed = await page.evaluate(() => {
  const cache = window.__tableStatesCache || {};
  const rooms = Object.keys(cache);
  if (typeof getParsedTable !== "function" || rooms.length === 0) return [];
  return rooms.map(roomId => getParsedTable(roomId)).filter(Boolean);
});
```

---

## 🛠️ Required Global Interface Hook Contract

To successfully interact with the backend supervisor, the interceptor **must** register three global endpoints on the browser's `window` object:

### 1. `window.__tableStatesCache` (Object)
* **Purpose**: Serves as the database of raw or partially-parsed network packets for each active room.
* **Format**: Key-value map using the provider's raw `roomId` (e.g., `"BAC-005"`) as the key:
  ```javascript
  window.__tableStatesCache = {
    "BAC-005": { /* raw or updated packet state */ },
    "BAC-MG06": { /* raw or updated packet state */ }
  };
  ```

### 2. `window.getParsedTable(roomId)` (Function)
* **Purpose**: Translates a cached record from `window.__tableStatesCache` into the standardized state object.
* **Return Value**: A `StandardizedTableState` object, or `null` if the room has no cache record yet.

### 3. State Update Broadcast
Whenever a new packet is captured or a store update triggers, the interceptor must immediately write it to `window.__tableStatesCache` and pass the parsed result to the bridge callback:
```javascript
const parsed = getParsedTable(roomId);
if (parsed && typeof window.onTableStateUpdate === "function") {
  window.onTableStateUpdate(parsed);
}
```

---

## 📋 The Standardized Output Schema (`StandardizedTableState`)

The parser function `getParsedTable(roomId)` must convert raw packets into a clean, game-agnostic state object containing these exact properties:

| Property | Type | Required | Description | Example |
| :--- | :--- | :---: | :--- | :--- |
| **`tableName`** | `string` | **Yes** | Friendly name used as the primary map identifier in the database. | `"PrettyMG05"` |
| **`tableId`** | `string` / `null` | **Yes** | Database lookup or API room identifier string. | `"BAC-005"` |
| **`state`** | `string` | **Yes** | Normalized active phase: `"Waiting for Bets"`, `"Dealing"`, `"Result"`, `"Shuffling"`. | `"Waiting for Bets"` |
| **`round`** | `number` | **Yes** | 1-based index representing the current shoe round count. Must be $> 0$ (unless `"Shuffling"`). | `18` |
| **`timer`** | `number` | **Yes** | Remaining betting seconds. Provide `-1` if betting is closed or inactive. | `15` |
| **`wins`** | `object` | **Yes** | Win totals matching `{ P: number, B: number, T: number }`. | `{ P: 8, B: 7, T: 3 }` |
| **`playerCards`** | `string[]` | **Yes** | Array of normalized cards dealt to the Player hand (if any). | `["8D", "7H"]` |
| **`bankerCards`** | `string[]` | **Yes** | Array of normalized cards dealt to the Banker hand (if any). | `["9S", "QD"]` |
| **`allCards`** | `string[]` | **Yes** | Combined array of all cards dealt during this round. | `["8D", "7H", "9S", "QD"]` |
| **`winner`** | `string` / `null` | **Yes** | Final outcome letter: `"P"` (Player), `"B"` (Banker), `"T"` (Tie), or `null`. | `"B"` |
| **`winPoints`** | `number` / `null` | No | Total hand value/points representing the winning score. | `9` |
| **`statistics`** | `string[]` | **Yes** | Raw or standard bead road outcome strings representing past rounds. | `["p_8", "b_5", "t_6"]` |

---

## ⏱️ Standardizing Game States

To prevent localized telemetry failures or validation errors, you must map all provider-specific state words to these four normalized states:

1. **`"Waiting for Bets"`**
   * Betting is active and open. This state initializes new EV calculations and counts down the placement timer.
2. **`"Dealing"`**
   * Betting has closed. The dealer is currently distributing cards. 
3. **`"Result"`** (or `"Result [Suffix]"`)
   * Outcomes are being determined. Cards are finalized, payouts are evaluated, and telemetry signals are stored.
4. **`"Shuffling"`**
   * The current shoe has completed. Clears active shoe composition state and resets historical counters.

---

## 🎴 Card Normalization Protocol

Cards parsed by the interceptor are subtracted directly from a shared 13-slot deck composition inside `tableManager.js`. Therefore, you must normalize card strings:

> [!IMPORTANT]
> **Format Rule**: `[Rank][Suit]` (e.g. `"AD"`, `"7H"`, `"TS"`, `"KC"`)
> * **Rank**: Single uppercase character. Ranks `2`-`9`, `A` (Ace), `J` (Jack), `Q` (Queen), `K` (King).
> * **The Ten Rule**: Ten **must** be represented as `"T"`, never `"10"`.
> * **Suit**: Single uppercase character. `H` (Hearts), `D` (Diamonds), `C` (Clubs), `S` (Spades).
> * **Filtering**: All empty placeholder strings (like `"null"`, `"Red"`, `undefined`) **must** be filtered out from the final arrays.

---

## ⚙️ Generic Interceptor Implementation Blueprint

Here is a modular template designed to intercept standard browser technologies (WebSockets, Socket.IO, Pinia stores) and convert them to the expected global schema.

```javascript
(function () {
  // 1. Establish cache layers
  window.__tableStatesCache = window.__tableStatesCache || {};
  window.__roomToNameMap = window.__roomToNameMap || {};

  // 2. Extract Token / Auth helpers if needed for API fetches
  function getAuthToken() {
    // Look through localStorage / sessionStorage / cookies
    return null; 
  }

  // 3. Normalized card converter helper
  function normalizeCard(code) {
    if (!code || code === "null" || code === "Red") return null;
    if (code.startsWith("10")) return "T" + code.slice(2);
    return code.toUpperCase();
  }

  // 4. Required bridge translation function
  window.getParsedTable = function(roomId) {
    const rawEntry = window.__tableStatesCache[roomId];
    if (!rawEntry) return null;

    // TODO: Map provider-specific properties to the StandardizedTableState contract
    return {
      tableName: window.__roomToNameMap[roomId] || roomId,
      tableId: roomId,
      state: normalizeState(rawEntry.status), // e.g. "Waiting for Bets"
      round: parseInt(rawEntry.roundNo, 10) || 0,
      timer: rawEntry.timeLeft ?? -1,
      wins: calculateWins(rawEntry.statistics),
      playerCards: (rawEntry.cards?.player || []).map(normalizeCard).filter(Boolean),
      bankerCards: (rawEntry.cards?.banker || []).map(normalizeCard).filter(Boolean),
      allCards: [], // playerCards + bankerCards
      winner: extractWinner(rawEntry),
      statistics: rawEntry.statistics || []
    };
  };

  // 5. Broadcast updates to Puppeteer Bridge
  function savePacketAndEmit(roomId, rawPacket) {
    window.__tableStatesCache[roomId] = {
      ...window.__tableStatesCache[roomId],
      ...rawPacket
    };

    if (typeof window.onTableStateUpdate === "function") {
      try {
        const parsed = window.getParsedTable(roomId);
        if (parsed) {
          window.onTableStateUpdate(parsed);
        }
      } catch (err) {
        console.error("Bridge emit error:", err);
      }
    }
  }

  // 6. Network Interception Layers
  // A. Hook standard WebSockets
  if (!WebSocket.prototype.send.isHooked) {
    const originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (!this._hooked) {
        this._hooked = true;
        this.addEventListener('message', function (event) {
          try {
            const rawMessage = JSON.parse(event.data);
            if (rawMessage && rawMessage.roomId) {
              savePacketAndEmit(rawMessage.roomId, rawMessage);
            }
          } catch (e) {}
        });
      }
      return originalWsSend.apply(this, arguments);
    };
    WebSocket.prototype.send.isHooked = true;
  }

  // B. Hook Pinia / Vue State Manager Stores
  function hookPinia() {
    try {
      const pinia = window.$nuxt?.$pinia || window.$pinia || document.querySelector('#app')?.__vue_app__?.$pinia;
      if (pinia && pinia._s) {
        for (const storeKey of Object.keys(pinia._s)) {
          if (storeKey.toLowerCase().includes('game') || storeKey.toLowerCase().includes('table')) {
            const store = pinia._s[storeKey];
            // Hook mutations / setters
            if (store && store.setTableState && !store.setTableState.isHooked) {
              const original = store.setTableState;
              store.setTableState = function (roomId, packet) {
                savePacketAndEmit(roomId, packet);
                return original.apply(this, arguments);
              };
              store.setTableState.isHooked = true;
            }
          }
        }
      }
    } catch (e) {}
  }

  // Monitor store injection periodically
  setInterval(hookPinia, 4000);
})();
```

---

## 🛡️ Reliability Watchdogs & Modular Page Checks

To guarantee high availability and quick self-healing recovery, the scraper engine implements an automated page check framework defined in [pageCheck.js](file:///c:/Users/desmo/Desktop/v5-template/eyes/pageCheck.js) which exports two main configuration helpers:

### 1. Readiness Watchdog (`setupReadinessCheck`)
* **Trigger**: Starts a 15-second timer immediately after injecting event interceptors on the browser page.
* **Condition**: Checks if a valid game state update is received via the bridge (`onTableStateUpdate`) or successfully primed from the interceptor cache on startup.
* **Failure Action**: If no state is received within 15 seconds, it logs a critical error, sends a WhatsApp alert, sets `pageRef.current.closeReason = "Failed readiness check"`, and rejects/resolves the runner execution to let the supervisor relaunch the process.
* **Success Action**: Once a state is successfully received, the watchdog clears and logs: `Readiness watchdog cleared — game state is flowing`.

### 2. Liveness & URL Watchdog (`setupLivenessCheck`)
* **Interval**: Runs periodically on a 5-second interval.
* **Staleness Check**: Monitors the time gap since the last received game state. If no update is received for $\ge 15$ seconds, the connection is considered stale, sends a WhatsApp notification, sets `pageRef.current.closeReason = "Liveness check failed: stale connection"`, and exits to trigger supervisor restart.
* **URL Domain Check**: Inspects `page.url()` every 5 seconds. If the page has navigated away from the target domain (`ct-999.com`), it triggers a WhatsApp notification, sets `pageRef.current.closeReason = "Liveness check failed: navigated away"`, and exits with a navigation loss error to force a restart.


---

## 📢 WebSocket Disconnection Alerts
* **Client-Side**: If the WebSocket client loses connection to the central Dashboard server, it triggers an alert notification:
  `[ALERT] Scraper "Label" lost connection to Dashboard WebSocket. Attempting reconnection...`
* **Dashboard-Side**: If all active scrapers are disconnected, the dashboard triggers a WhatsApp alert:
  `[CRITICAL] Pretty Gaming Scraper client disconnected from Dashboard (0 active scrapers remaining).`

---

## 👥 Running Multiple Scrapers (Backup Mode)

You can launch multiple independent scraper instances to serve as redundant backups for the telemetry client.
* **Index Configuration**: Customize the configuration of each backup scraper via the `eyes_accounts.json` array.
* **Running Scrapers**: Start each instance by passing its array index (0-based) as an argument:
  ```bash
  # Launch the primary scraper (Index 0)
  node eyes/launcher.js 0

  # Launch the backup scraper (Index 1)
  node eyes/launcher.js 1
  ```
* **Dashboard Support**: The central server maintains a `scraperSockets` Set. It aggregates state updates from all active instances and will keep the UI status `online` as long as at least one scraper socket is active.

