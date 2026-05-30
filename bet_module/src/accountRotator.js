const path = require("path");
const fs = require("fs");
const { buildAccountConfig } = require("../../utils/launch_winbox");

class AccountRotator {
  /**
   * @param {number} initialIndex 
   * @param {string} [accountsPath] 
   */
  constructor(initialIndex, accountsPath) {
    this.currentAccountIndex = initialIndex;
    this.accountsPath = accountsPath || path.resolve(__dirname, "..", "json", "bet_accounts.json");
  }

  getCurrentIndex() {
    return this.currentAccountIndex;
  }

  getCurrentConfig() {
    return buildAccountConfig(this.currentAccountIndex, this.accountsPath);
  }

  /**
   * Dynamically rotates the active account to the next having "run": true in JSON.
   * @returns {number} The new current account index
   */
  advanceToNext() {
    let accounts = [];
    try {
      accounts = JSON.parse(fs.readFileSync(this.accountsPath, "utf-8"));
    } catch (err) {
      console.error(`[Rotation] Failed to read ${this.accountsPath} for rotating:`, err.message);
      return this.currentAccountIndex;
    }

    const runnableIndices = accounts
      .map((acct, index) => ({ ...acct, originalIndex: index }))
      .filter((acct) => acct.run === true)
      .map((acct) => acct.originalIndex);

    if (runnableIndices.length <= 1) {
      console.log(`[Rotation] Only ${runnableIndices.length} runnable account found. No rotation change needed.`);
      return this.currentAccountIndex;
    }

    const currentPos = runnableIndices.indexOf(this.currentAccountIndex);
    let nextPos = 0;
    if (currentPos !== -1) {
      nextPos = (currentPos + 1) % runnableIndices.length;
    }
    const prevIndex = this.currentAccountIndex;
    this.currentAccountIndex = runnableIndices[nextPos];
    console.log(`[Rotation] Rotated active account index: ${prevIndex} → ${this.currentAccountIndex}`);
    return this.currentAccountIndex;
  }
}

module.exports = AccountRotator;
