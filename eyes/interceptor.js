// Pretty Gaming Client-Side State Interceptor Injection
(function () {
  const API_BASE = "https://member-api.aghippo168.com";

  window.__roomToNameMap = window.__roomToNameMap || {};
  window.__tableStatesCache = window.__tableStatesCache || {};
  window.__activeRooms = window.__activeRooms || new Set();

  function getAuthToken() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key);
      if (key && key.toLowerCase().includes('token') && val) {
        return val.replace(/^Bearer\s+/i, '');
      }
      if (val && val.startsWith('eyJ') && val.split('.').length === 3) {
        return val;
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const val = sessionStorage.getItem(key);
      if (key && key.toLowerCase().includes('token') && val) {
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

  function getRoundCount(roomId, packet) {
    try {
      let pinia = window.$nuxt?.$pinia || window.$pinia;
      if (!pinia) {
        const el = document.querySelector('#__nuxt') || document.querySelector('#app') || document.body;
        pinia = el?.__vue_app__?.$pinia || el?.__vue_app__?.config?.globalProperties?.$pinia;
      }
      if (!pinia && window.$pinia) {
        pinia = window.$pinia;
      }

      if (pinia && pinia.state && pinia.state.value) {
        for (const storeKey of Object.keys(pinia.state.value)) {
          if (storeKey.toLowerCase().includes('baccarat')) {
            const storeState = pinia.state.value[storeKey];
            if (storeState) {
              if (Array.isArray(storeState.bacTable)) {
                const tbl = storeState.bacTable.find(t => t.roomId === roomId);
                if (tbl && tbl.statistics) {
                  return tbl.statistics.length;
                }
              }
              if (Array.isArray(storeState.dtTable)) {
                const tbl = storeState.dtTable.find(t => t.roomId === roomId);
                if (tbl && tbl.statistics) {
                  return tbl.statistics.length;
                }
              }
            }
          }
        }
      }
    } catch (e) { }

    if (packet) {
      const stats = packet.statistics || [];
      if (stats.length) return stats.length;
    }
    return 0;
  }

  async function loadLobbyMapping() {
    try {
      const token = getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) {
        headers["authorization"] = token;
      }
      const bacRes = await fetch(`${API_BASE}/apiRoute/table/getAllBac`, { headers }).then(r => r.json());
      if (bacRes.code === 0 && Array.isArray(bacRes.data)) {
        window.__activeRooms.clear();
        bacRes.data.forEach(t => {
          const name = t.tableNumber || t.name || `Baccarat ${t.roomId.replace("BAC-", "")}`;
          window.__roomToNameMap[t.roomId] = name;
          if (t.isActive === true) {
            window.__activeRooms.add(t.roomId);
            if (!window.__tableStatesCache[t.roomId]) {
              const baseStoreCount = t.statistics ? t.statistics.length : 0;
              const roundCount = t.round || t.roundNo || t.roundNumber || baseStoreCount;
              window.__tableStatesCache[t.roomId] = {
                roomId: t.roomId,
                gameId: t.gameId || "N/A",
                status: t.status || "Unknown",
                timeLeft: t.timeLeft ?? -1,
                result: null,
                statistics: t.statistics || [],
                round: roundCount
              };
            }
          }
        });
      }
    } catch (err) {
      // dynamic fallback
    }
  }

  loadLobbyMapping();

  async function syncSourceBeadRoad(roomId) {
    try {
      const token = getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) {
        headers["authorization"] = token;
      }
      const res = await fetch(`${API_BASE}/apiRoute/table/getStatResult/${roomId}`, { headers }).then(r => r.json());
      if (res.code === 0 && res.data && Array.isArray(res.data.statistics)) {
        if (window.__tableStatesCache[roomId]) {
          window.__tableStatesCache[roomId].statistics = res.data.statistics;
        }
      }
    } catch (e) {
      // dynamic fallback
    }
  }

  function savePacketToCache(packet) {
    if (!packet || !packet.roomId || !packet.status) return;
    if (!window.__activeRooms.has(packet.roomId)) return;

    const old = window.__tableStatesCache[packet.roomId] || {};
    const statusChanged = packet.status !== old.status;

    const gameId = packet.gameId || old.gameId || "N/A";
    const baseStoreCount = getRoundCount(packet.roomId, packet);

    const roundCount = packet.round || packet.roundNo || packet.roundNumber || baseStoreCount;

    const isNewRound = (gameId !== "N/A" && old.gameId !== undefined && old.gameId !== "N/A" && gameId !== old.gameId) ||
                       (statusChanged && packet.status === "CountDown");

    let result = packet.result || old.result || null;
    if (isNewRound) {
      result = packet.result || null;
    }

    window.__tableStatesCache[packet.roomId] = {
      roomId: packet.roomId,
      gameId: gameId,
      status: packet.status,
      timeLeft: packet.timeLeft !== undefined ? packet.timeLeft : old.timeLeft,
      result: result,
      statistics: packet.statistics || old.statistics || [],
      round: roundCount
    };

    if (statusChanged && packet.status === "CountDown") {
      syncSourceBeadRoad(packet.roomId);
    }
  }

  // --- WebSocket Interception ---
  if (!WebSocket.prototype.send.isHooked) {
    const originalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (!this._hooked) {
        this._hooked = true;
        this.addEventListener('message', function (event) {
          try {
            let rawData = event.data;
            if (event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data)) {
              rawData = new TextDecoder().decode(event.data);
            }
            // Parse Socket.IO framing if present
            if (typeof rawData === "string" && rawData.startsWith("42[")) {
              const parsedArray = JSON.parse(rawData.slice(2));
              if (Array.isArray(parsedArray) && parsedArray.length >= 2) {
                const inner = parsedArray[1];
                if (inner) {
                  if (inner.roomId && inner.status) {
                    savePacketToCache(inner);
                  } else if (inner.method && inner.data && inner.data.roomId && inner.data.status) {
                    savePacketToCache(inner.data);
                  }
                }
              }
            } else {
              const packet = JSON.parse(rawData);
              if (packet) {
                if (packet.roomId && packet.status) {
                  savePacketToCache(packet);
                } else if (packet.method && packet.data && packet.data.roomId && packet.data.status) {
                  savePacketToCache(packet.data);
                }
              }
            }
          } catch (e) {}
        });
      }
      return originalWsSend.apply(this, arguments);
    };
    WebSocket.prototype.send.isHooked = true;
  }

  // --- Pinia Interception ---
  function hookPinia() {
    try {
      let pinia = window.$nuxt?.$pinia || window.$pinia;
      if (!pinia) {
        const el = document.querySelector('#__nuxt') || document.querySelector('#app') || document.body;
        pinia = el?.__vue_app__?.$pinia || el?.__vue_app__?.config?.globalProperties?.$pinia;
      }
      if (pinia && pinia._s) {
        const storeKeys = pinia._s.keys ? Array.from(pinia._s.keys()) : Object.keys(pinia._s);
        for (const key of storeKeys) {
          if (key.toLowerCase().includes('baccarat')) {
            const store = pinia._s.get ? pinia._s.get(key) : pinia._s[key];
            if (store && store.setSocket && !store.setSocket.isHooked) {
              const originalSetSocket = store.setSocket;
              store.setSocket = function (roomId, packet) {
                try {
                  if (packet && roomId) {
                    if (!packet.roomId) packet.roomId = roomId;
                    savePacketToCache(packet);
                  }
                } catch (e) {}
                return originalSetSocket.apply(this, arguments);
              };
              store.setSocket.isHooked = true;
            }
          }
        }
      }
    } catch (e) {}
  }

  // --- Socket.IO Application Hooking ---
  function hookSocketIo() {
    try {
      if (window.io && window.io.managers) {
        for (const url of Object.keys(window.io.managers)) {
          const mgr = window.io.managers[url];
          if (mgr && mgr.nsps) {
            for (const nspName of Object.keys(mgr.nsps)) {
              const socket = mgr.nsps[nspName];
              if (socket && !socket._hooked) {
                socket._hooked = true;
                const originalOnevent = socket.onevent;
                socket.onevent = function (packet) {
                  try {
                    const args = packet.data || [];
                    const payload = args[1];
                    if (payload) {
                      if (payload.roomId && payload.status) {
                        savePacketToCache(payload);
                      } else if (payload.method && payload.data && payload.data.roomId && payload.data.status) {
                        savePacketToCache(payload.data);
                      }
                    }
                  } catch (e) {}
                  return originalOnevent.apply(this, arguments);
                };
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  // Run scans dynamically
  hookPinia();
  hookSocketIo();
  setInterval(() => {
    hookPinia();
    hookSocketIo();
    // Periodically re-sync active rooms map just in case new tables open
    loadLobbyMapping();
  }, 5000);
})();
