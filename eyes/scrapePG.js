const { ensureMultiplayActive } = require("../utils/ensureMultiplayActive");

/**
 * Pure scrape function. Extracts structured table data from the page using the client-side interceptor cache.
 * @param {import('puppeteer').Page} page
 * @param {string} unused_extractorCode - Obsolete, kept for backwards compatibility in argument signature
 * @returns {Promise<{text: string, tables: Array} | null>}
 */
async function scrapePG(page, unused_extractorCode, acctConfig = {}) {
  await ensureMultiplayActive(page);

  // Prevent hanging indefinitely if the Chromium tab freezes
  const evaluatePromise = page.evaluate(() => {
    const cache = window.__tableStatesCache || {};
    const roomMap = window.__roomToNameMap || {};
    const tableData = [];

    const stateMapping = {
      "CountDown": "Waiting for Bets",
      "showResult": "Dealing",
      "PayOut": "Result",
      "Shuffle": "Shuffling"
    };

    function mapServerCodeToWinner(code) {
      if (!code) return null;
      const c = code.toLowerCase();
      if (c.startsWith('p')) return 'P';
      if (c.startsWith('b')) return 'B';
      if (c.startsWith('t')) return 'T';
      return null;
    }

    let tableIndex = 1;
    for (const [roomId, entry] of Object.entries(cache)) {
      const name = roomMap[roomId] || roomId;
      const stats = entry.statistics || [];
      
      const pWins = stats.filter(c => c.startsWith('p')).length;
      const bWins = stats.filter(c => c.startsWith('b')).length;
      const tWins = stats.filter(c => c.startsWith('t')).length;

      // Directly follow the round number given from interceptor
      let roundNumber = entry.round || 0;

      // Determine standardized state
      let state = stateMapping[entry.status] || entry.status || "Waiting for Bets";
      let winner = null;

      // Extract winner outcome inside PayOut state
      if (entry.status === "PayOut") {
        if (entry.result && entry.result.rsBc) {
          const rs = entry.result.rsBc;
          const pPoints = rs.player123;
          const bPoints = rs.banker123;
          if (pPoints !== undefined && bPoints !== undefined) {
            if (pPoints > bPoints) {
              state = "Result (Player Win)";
              winner = "P";
            } else if (pPoints < bPoints) {
              state = "Result (Banker Win)";
              winner = "B";
            } else {
              state = "Result (Tie Win)";
              winner = "T";
            }
          }
        }

        // Fallback to server statistics if point-based check not available or didn't set winner
        if (!winner && stats.length >= roundNumber) {
          const serverCode = stats[roundNumber - 1];
          winner = mapServerCodeToWinner(serverCode);
          if (winner === "P") {
            state = "Result (Player Win)";
          } else if (winner === "B") {
            state = "Result (Banker Win)";
          } else if (winner === "T") {
            state = "Result (Tie Win)";
          }
        }
      }

      const playerCards = [];
      const bankerCards = [];
      const allCards = [];

      if (entry.result && entry.result.rsBc) {
        const rs = entry.result.rsBc;
        const normalizeCard = (c) => {
          if (!c || c === "null" || c === "Red") return null;
          if (c.startsWith("10")) return "T" + c.slice(2);
          return c;
        };

        [rs.player_1, rs.player_2, rs.player_3].forEach(c => {
          const norm = normalizeCard(c);
          if (norm) {
            playerCards.push(norm);
            allCards.push(norm);
          }
        });
        [rs.banker_1, rs.banker_2, rs.banker_3].forEach(c => {
          const norm = normalizeCard(c);
          if (norm) {
            bankerCards.push(norm);
            allCards.push(norm);
          }
        });
      }

      tableData.push({
        tableIndex: tableIndex++,
        tableName: name,
        state: state,
        timer: entry.timeLeft !== undefined ? entry.timeLeft : -1,
        round: roundNumber,
        wins: { P: pWins, B: bWins, T: tWins },
        playerCards: playerCards,
        bankerCards: bankerCards,
        allCards: allCards,
        winner: winner,
        statistics: stats
      });
    }

    // Compile compact readable view log text
    let textLog = `=== LIVE BACCARAT TABLES COMPACT VIEW ===\n\n`;
    tableData.forEach(t => {
      textLog += `[Table ${t.tableIndex}] ${t.tableName} | State: ${t.state} | Timer: ${t.timer}s | Round: ${t.round} | Wins: P:${t.wins.P} B:${t.wins.B} T:${t.wins.T}\n`;
      textLog += `   Bets:  Standard Baccarat Bets\n`;
      textLog += `   Cards: Player [${t.playerCards.join(", ")}] | Banker [${t.bankerCards.join(", ")}]\n\n`;
    });
    
    return JSON.stringify({
      text: textLog + `\n[Parser Complete] Extracted exactly ${tableData.length} Active Baccarat Tables\n`,
      tables: tableData
    });
  });

  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("page.evaluate timeout")), 15000));
  
  const rawResult = await Promise.race([evaluatePromise, timeoutPromise]);
  if (!rawResult) return null;

  try {
    return JSON.parse(rawResult);
  } catch {
    return { text: rawResult, tables: [] };
  }
}

module.exports = { scrapePG };
