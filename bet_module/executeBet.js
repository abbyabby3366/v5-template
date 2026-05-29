/**
 * Injects the pure API-based betting script into the live Chromium page to place the bet and verify.
 * Zero DOM selectors are used for game state, timer, or balance.
 * @param {import('puppeteer').Page} page 
 * @param {Object} betConfig 
 * @returns {Promise<{success: boolean, reason?: string, betAmount?: string, balance?: string, timer?: number}>} 
 */
async function executeBetInBrowser(page, betConfig) {
  try {
    const evaluatePromise = page.evaluate(async (config) => {
      const API_BASE = "https://member-api.aghippo168.com";

      // --- 1. EXTRACT AUTHORIZATION SESSION TOKEN ---
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

      const token = getAuthToken();
      if (!token) {
        return { success: false, reason: "Authorization token not found in browser storage" };
      }

      const headers = {
        "Content-Type": "application/json",
        "authorization": token
      };

      // --- 2. GET PINIA STORE HELPER ---
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

      // --- 3. FETCH PROFILE AND BALANCE VIA REST API ---
      async function queryBalanceViaAPI() {
        try {
          // A. Fetch profile to get _id
          const profile = await fetch(`${API_BASE}/apiRoute/member/profile`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ lang: "en" })
          }).then(r => r.json());

          if (!profile || !profile._id) {
            return null;
          }

          // B. Fetch balance using profile._id
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

      // --- 4. RESOLVE TABLE SESSION DETAILS VIA API ---
      let tableData;
      try {
        tableData = await fetch(`${API_BASE}/apiRoute/table/getAllBac`, { headers }).then(r => r.json());
      } catch (err) {
        return { success: false, reason: `Failed to fetch tables API: ${err.message}` };
      }

      if (!tableData || tableData.code !== 0 || !Array.isArray(tableData.data)) {
        return { success: false, reason: `Lobby API error: ${tableData?.msg || "Invalid response structure"}` };
      }

      const tableObj = tableData.data.find(t => t.name === config.tableName || t.tableNumber === config.tableName);
      if (!tableObj) {
        return { success: false, reason: `Table "${config.tableName}" not found in lobby list` };
      }

      const canonicalRoomId = tableObj.roomId;

      // --- 5. RESOLVE WEBSOCKET SOCKET DATA & TIMER ACROSS FRAMES & PINIA ---
      const pinia = getPiniaStore();

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

      const initialTimer = socketData && socketData.timeLeft !== undefined ? socketData.timeLeft : null;

      // --- 6. FORMAT POSITION & GAME DATA ---
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

      let gameId = (socketData && socketData.gameId) || tableObj.gameId;

      // If gameId wasn't in wsCache or lobby response, try Pinia baccarat store
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

      if (!gameId) {
        return { success: false, reason: "Game ID not resolved", timer: initialTimer };
      }

      // --- 7. PRE-FLIGHT BALANCE CHECK (PURE API/PINIA) ---
      let balanceBefore = null;
      // First try in-memory Pinia cache (no network query)
      if (pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
        const piniaBal = pinia.state.value.global.profile?.balance;
        if (piniaBal !== undefined && piniaBal !== null) balanceBefore = parseFloat(piniaBal);
      }
      // Fallback: direct API call
      if (balanceBefore === null) {
        balanceBefore = await queryBalanceViaAPI();
      }

      let targetAmountVal = parseInt(config.targetAmount, 10);
      if (balanceBefore !== null && !isNaN(targetAmountVal) && config.targetAmount !== "ALL_IN") {
        if (balanceBefore < targetAmountVal) {
          return { success: false, reason: `Insufficient balance (have ${balanceBefore}, need ${targetAmountVal})`, balance: String(balanceBefore), timer: initialTimer };
        }
      }

      // --- 8. SEND BET TRANSACTION payload ---
      const limitId = tableObj.limitObj?.limitId || 3016;
      const payload = {
        betLimit: limitId,
        gameId: gameId,
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
        return { success: false, reason: `Bet transaction network error: ${err.message}`, timer: initialTimer };
      }

      const success = response && response.code === 0;
      const reason = success ? undefined : (response?.msg || `Lobby error code: ${response?.code}`);

      // --- 9. QUERY POST-BET BALANCE VIA REST API & SYNC NUXT UI STATE ---
      let balanceAfter = await queryBalanceViaAPI();
      
      if (balanceAfter !== null && pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
        pinia.state.value.global.profile.balance = balanceAfter;
      }

      return {
        success: success,
        reason: reason,
        betAmount: success ? String(targetAmountVal) : undefined,
        balance: balanceAfter !== null ? String(balanceAfter) : String(balanceBefore || ""),
        timer: initialTimer
      };

    }, betConfig);

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("page.evaluate timeout")), 25000));
    return await Promise.race([evaluatePromise, timeoutPromise]);
  } catch (err) {
    console.error(`[Bet Module] Puppeteer evaluate error:`, err.message);
    return { success: false, reason: `Evaluate error: ${err.message}` };
  }
}

module.exports = { executeBetInBrowser };
