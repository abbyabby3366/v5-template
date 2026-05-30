/**
 * Shared utility for querying the active balance from the browser session.
 * Zero DOM selectors are used.
 */

/**
 * Helper to retrieve active auth token from browser localStorage, sessionStorage, or cookies.
 */
function getAuthTokenFromBrowser() {
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

/**
 * Helper to retrieve Pinia global store from window.
 */
function getPiniaStoreFromBrowser() {
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

/**
 * Queries the current balance from the browser session.
 * @param {import('puppeteer').Page} page 
 * @returns {Promise<number|null>} 
 */
async function fetchAccountBalance(page) {
  try {
    const evaluatePromise = page.evaluate(async (getAuthTokenStr, getPiniaStoreStr) => {
      const API_BASE = "https://member-api.aghippo168.com";

      // Re-define internal helpers so page.evaluate can access them
      const getAuthToken = new Function(`return (${getAuthTokenStr})()`);
      const getPiniaStore = new Function(`return (${getPiniaStoreStr})()`);

      const token = getAuthToken();
      if (!token) return null;

      const headers = {
        "Content-Type": "application/json",
        "authorization": token
      };

      // Try Pinia first (in-memory)
      const pinia = getPiniaStore();
      if (pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
        const piniaBal = pinia.state.value.global.profile?.balance;
        if (piniaBal !== undefined && piniaBal !== null) {
          return parseFloat(piniaBal);
        }
      }

      // Direct REST API Fallback
      try {
        const profile = await fetch(`${API_BASE}/apiRoute/member/profile`, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({ lang: "en" })
        }).then(r => r.json());

        if (profile && profile._id) {
          const balanceInfo = await fetch(`${API_BASE}/apiRoute/member/viewBalance/${profile._id}`, {
            method: "GET",
            headers: headers
          }).then(r => r.json());

          if (balanceInfo && typeof balanceInfo.balance !== 'undefined') {
            const balanceVal = parseFloat(balanceInfo.balance);
            // Sync to Pinia if possible
            if (pinia && pinia.state && pinia.state.value && pinia.state.value.global) {
              pinia.state.value.global.profile.balance = balanceVal;
            }
            return balanceVal;
          }
        }
      } catch (e) {}
      return null;
    }, getAuthTokenFromBrowser.toString(), getPiniaStoreFromBrowser.toString());

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("queryBalance timeout")), 15000));
    return await Promise.race([evaluatePromise, timeoutPromise]);
  } catch (err) {
    console.error(`[Bet Module] fetchAccountBalance error:`, err.message);
    return null;
  }
}

module.exports = fetchAccountBalance;
