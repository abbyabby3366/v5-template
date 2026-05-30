/**
 * Injects the pure API-based betting script into the live Chromium page to place the bet and verify.
 * Zero DOM selectors are used for game state, timer, or balance.
 */

const fetchAccountBalance = require("./fetchBalance");

/**
 * Resolves current lobby/table details, including gameId, canonicalRoomId, and remaining timer.
 * @param {import('puppeteer').Page} page 
 * @param {string} tableName 
 * @returns {Promise<{gameId: string|null, canonicalRoomId: string|null, timeLeft: number|null, limitId: number|null}>} 
 */
async function resolveActiveGameSession(page, tableName) {
  try {
    const evaluatePromise = page.evaluate(async (targetName) => {
      const API_BASE = "https://member-api.aghippo168.com";

      function getAuthToken() {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const val = localStorage.getItem(key);
          if (key.toLowerCase().includes('token') && val) {
            return val.replace(/^Bearer\s+/i, '');
          }
          if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
            return val;
          }
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          const val = sessionStorage.getItem(key);
          if (key.toLowerCase().includes('token') && val) {
            return val.replace(/^Bearer\s+/i, '');
          }
          if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
            return val;
          }
        }
        const cookieMatch = document.cookie.match(/token=([^;]+)/i);
        if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
        return null;
      }

      function getPiniaStore() {
        try {
          let pinia = window.$nuxt?.$pinia || window.$pinia;
          if (!pinia) {
            const el = document.querySelector('#__nuxt') || document.querySelector('#app') || document.body;
            pinia = el?.__vue_app__?.$pinia || el?.__vue_app__?.config?.globalProperties?.$pinia;
          }
          return pinia;
        } catch (e) {}
        return null;
      }

      const token = getAuthToken();
      if (!token) return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };

      const headers = {
        "Content-Type": "application/json",
        "authorization": token
      };

      // 1. Fetch tables from API
      let tableData;
      try {
        tableData = await fetch(`${API_BASE}/apiRoute/table/getAllBac`, { headers }).then(r => r.json());
      } catch (err) {
        return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };
      }

      if (!tableData || tableData.code !== 0 || !Array.isArray(tableData.data)) {
        return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };
      }

      const tableObj = tableData.data.find(t => t.name === targetName || t.tableNumber === targetName);
      if (!tableObj) return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };

      const canonicalRoomId = tableObj.roomId;
      const limitId = tableObj.limitObj?.limitId || 3016;

      // 2. Resolve WebSocket data for timer and active game ID
      function getSocketDataAcrossFrames(roomId) {
        const windowsToTry = [window];
        try {
          if (window.parent && window.parent !== window) windowsToTry.push(window.parent);
          if (window.top && window.top !== window) windowsToTry.push(window.top);
        } catch (e) { }

        try {
          const iframes = document.querySelectorAll('iframe');
          for (const iframe of iframes) {
            try {
              if (iframe.contentWindow) windowsToTry.push(iframe.contentWindow);
            } catch (e) { }
          }
        } catch (e) { }

        for (const w of windowsToTry) {
          try {
            if (w.__tableStatesCache && w.__tableStatesCache[roomId]) {
              return w.__tableStatesCache[roomId];
            }
          } catch (e) { }
        }
        return null;
      }

      let socketData = getSocketDataAcrossFrames(canonicalRoomId);
      const pinia = getPiniaStore();

      // Pinia fallback for socket retrieval
      if (!socketData && pinia && pinia.state && pinia.state.value) {
        for (const storeKey of Object.keys(pinia.state.value)) {
          const storeState = pinia.state.value[storeKey];
          if (storeState) {
            for (const prop of Object.keys(storeState)) {
              if (prop.toLowerCase().includes('socket') && typeof storeState[prop] === 'object' && storeState[prop] !== null) {
                if (storeState[prop][canonicalRoomId]) {
                  socketData = storeState[prop][canonicalRoomId];
                  break;
                }
              }
            }
          }
          if (socketData) break;
        }
      }

      const timeLeft = socketData && socketData.timeLeft !== undefined ? socketData.timeLeft : null;
      let gameId = (socketData && socketData.gameId) || tableObj.gameId;

      // Pinia baccarat store fallback for gameId
      if (!gameId && pinia && pinia.state && pinia.state.value) {
        for (const storeKey of Object.keys(pinia.state.value)) {
          if (storeKey.toLowerCase().includes('baccarat')) {
            const storeState = pinia.state.value[storeKey];
            if (storeState) {
              const sockets = storeState.bacSocket || storeState.sockets;
              if (sockets && sockets[canonicalRoomId]) {
                gameId = sockets[canonicalRoomId].gameId;
              }
            }
          }
        }
      }

      return { gameId, canonicalRoomId, timeLeft, limitId };
    }, tableName);

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("getGameSession timeout")), 15000));
    return await Promise.race([evaluatePromise, timeoutPromise]);
  } catch (err) {
    console.error(`[Bet Module] resolveActiveGameSession error:`, err.message);
    return { gameId: null, canonicalRoomId: null, timeLeft: null, limitId: null };
  }
}

/**
 * Places the actual bet transaction in the browser session.
 * @param {import('puppeteer').Page} page 
 * @param {Object} betConfig 
 * @param {string} gameId 
 * @param {number} limitId 
 * @param {number|null} balanceBefore 
 * @returns {Promise<{success: boolean, reason?: string, betAmount?: string, balance?: string}>} 
 */
async function submitBetAndConfirm(page, betConfig, gameId, limitId, balanceBefore) {
  try {
    const evaluatePromise = page.evaluate(async (config, gId, limId, balBefore) => {
      const API_BASE = "https://member-api.aghippo168.com";

      function getAuthToken() {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          const val = localStorage.getItem(key);
          if (key.toLowerCase().includes('token') && val) {
            return val.replace(/^Bearer\s+/i, '');
          }
          if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
            return val;
          }
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          const val = sessionStorage.getItem(key);
          if (key.toLowerCase().includes('token') && val) {
            return val.replace(/^Bearer\s+/i, '');
          }
          if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
            return val;
          }
        }
        const cookieMatch = document.cookie.match(/token=([^;]+)/i);
        if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
        return null;
      }

      function getPiniaStore() {
        try {
          let pinia = window.$nuxt?.$pinia || window.$pinia;
          if (!pinia) {
            const el = document.querySelector('#__nuxt') || document.querySelector('#app') || document.body;
            pinia = el?.__vue_app__?.$pinia || el?.__vue_app__?.config?.globalProperties?.$pinia;
          }
          return pinia;
        } catch (e) {}
        return null;
      }

      async function queryBalanceViaAPI(headers) {
        try {
          const profile = await fetch(`${API_BASE}/apiRoute/member/profile`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ lang: "en" })
          }).then(r => r.json());

          if (!profile || !profile._id) {
            return null;
          }

          const balanceInfo = await fetch(`${API_BASE}/apiRoute/member/viewBalance/${profile._id}`, {
            method: "GET",
            headers: headers
          }).then(r => r.json());

          if (balanceInfo && typeof balanceInfo.balance !== 'undefined') {
            return parseFloat(balanceInfo.balance);
          }
        } catch (e) {}
        return null;
      }

      const token = getAuthToken();
      if (!token) return { success: false, reason: "Authorization token not found in browser storage" };

      const headers = {
        "Content-Type": "application/json",
        "authorization": token
      };

      const betTypeMap = {
        "PlayerBet": "player",
        "BankerBet": "banker",
        "TieBet": "tie",
        "Player": "player",
        "Banker": "banker",
        "Tie": "tie",
        "playerpair": "playerPair",
        "bankerpair": "bankerPair"
      };
      const formattedPosition = betTypeMap[config.betType] || betTypeMap[config.betType.toLowerCase()] || config.betType.toLowerCase();

      let targetAmountVal = parseInt(config.targetAmount, 10);
      if (balBefore !== null && !isNaN(targetAmountVal) && config.targetAmount !== "ALL_IN") {
        if (balBefore < targetAmountVal) {
          return { success: false, reason: `Insufficient balance (have ${balBefore}, need ${targetAmountVal})`, balance: String(balBefore) };
        }
      }

      const payload = {
        betLimit: limId,
        gameId: gId,
        type: "Baccarat",
        txts: [
          {
            position: formattedPosition,
            betValue: targetAmountVal
          }
        ]
      };

      let response;
      try {
        response = await fetch(`${API_BASE}/apiRoute/transaction/userPlaceBet`, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload)
        }).then(r => r.json());
      } catch (err) {
        return { success: false, reason: `Bet transaction network error: ${err.message}` };
      }

      const success = response && response.code === 0;
      const reason = success ? undefined : (response?.msg || `Lobby error code: ${response?.code}`);

      let balanceAfter = await queryBalanceViaAPI(headers);
      const pinia = getPiniaStore();
      if (balanceAfter !== null && pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
        pinia.state.value.global.profile.balance = balanceAfter;
      }

      return {
        success: success,
        reason: reason,
        betAmount: success ? String(targetAmountVal) : undefined,
        balance: balanceAfter !== null ? String(balanceAfter) : String(balBefore || "")
      };
    }, betConfig, gameId, limitId, balanceBefore);

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("placeBet timeout")), 25000));
    return await Promise.race([evaluatePromise, timeoutPromise]);
  } catch (err) {
    console.error(`[Bet Module] submitBetAndConfirm error:`, err.message);
    return { success: false, reason: `Evaluate error: ${err.message}` };
  }
}

/**
 * Orchestrator that queries balance, resolves table timer/game info, and places the bet.
 * @param {import('puppeteer').Page} page 
 * @param {Object} betConfig 
 * @returns {Promise<{success: boolean, reason?: string, betAmount?: string, balance?: string, timer?: number}>} 
 */
async function executeBet(page, betConfig) {
  try {
    // 1. Get balance before bet
    const balanceBefore = await fetchAccountBalance(page);

    // 2. Get table and game session details (including the current timeLeft timer)
    const { gameId, canonicalRoomId, timeLeft, limitId } = await resolveActiveGameSession(page, betConfig.tableName);

    if (!gameId) {
      return { success: false, reason: "Game ID not resolved", timer: timeLeft };
    }

    // 3. Place the bet transaction
    const betResult = await submitBetAndConfirm(page, betConfig, gameId, limitId || 3016, balanceBefore);

    return {
      success: betResult.success,
      reason: betResult.reason,
      betAmount: betResult.betAmount,
      balance: betResult.balance,
      timer: timeLeft
    };
  } catch (err) {
    console.error(`[Bet Module] Puppeteer evaluate error:`, err.message);
    return { success: false, reason: `Evaluate error: ${err.message}` };
  }
}

module.exports = executeBet;
