const path = require("path");
const fs = require("fs");

function buildDynamicAccountConfig(accountIndex, accountsPath) {
  let accounts = [];
  try {
    accounts = JSON.parse(fs.readFileSync(accountsPath, "utf-8"));
  } catch (err) {}
  const account = accounts[accountIndex] || {};
  const platform = (account.platform || "winbox").toLowerCase();

  let launcher;
  if (platform === "winbox") {
    launcher = require("../../utils/launch_winbox");
  } else if (platform === "a9" || platform === "on") {
    launcher = require("../../utils/launch_a9");
  } else if (platform === "atas") {
    launcher = require("../../utils/launch_atas");
  } else {
    launcher = require("../../utils/launch_any");
  }
  return launcher.buildAccountConfig(accountIndex, accountsPath);
}

function isSingleTimeRangeWithinBounds(range) {
  if (typeof range !== "string") return true;
  const parts = range.split("-");
  if (parts.length !== 2) return true;
  
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  const [startH, startM] = parts[0].split(":").map(Number);
  const [endH, endM] = parts[1].split(":").map(Number);
  
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  
  if (startMinutes <= endMinutes) {
    // Normal range: e.g. "08:00-18:00"
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } else {
    // Midnight-crossing range: e.g. "22:00-06:00"
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
}

function isTimeWithinRange(allowedRange) {
  if (!allowedRange) return true; // If no allowed hours specified, always allowed
  
  if (Array.isArray(allowedRange)) {
    if (allowedRange.length === 0) return true; // Empty array means always allowed
    return allowedRange.some(range => isSingleTimeRangeWithinBounds(range));
  }
  
  return isSingleTimeRangeWithinBounds(allowedRange);
}

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
    this.ensureActiveTiming();
    return buildDynamicAccountConfig(this.currentAccountIndex, this.accountsPath);
  }

  /**
   * Scans and verifies that the current index is within its allowed timing window.
   * If not, rotates to the next active runnable account.
   */
  ensureActiveTiming() {
    let accounts = [];
    try {
      accounts = JSON.parse(fs.readFileSync(this.accountsPath, "utf-8"));
    } catch (err) {
      return;
    }

    const runnableAccounts = accounts
      .map((acct, index) => ({ ...acct, originalIndex: index }))
      .filter((acct) => acct.run === true);

    if (runnableAccounts.length === 0) return;

    // Check if current account is currently allowed
    let currentAcct = runnableAccounts.find(a => a.originalIndex === this.currentAccountIndex);
    if (currentAcct && isTimeWithinRange(currentAcct.allowedHours)) {
      return; // Already allowed, nothing to do
    }

    console.log(`[Timing] Current account (index ${this.currentAccountIndex}) is outside its allowed window (${currentAcct ? currentAcct.allowedHours : "None"}). Finding next active account...`);

    const startIndex = runnableAccounts.findIndex(a => a.originalIndex === this.currentAccountIndex);
    let checkIndex = startIndex === -1 ? 0 : startIndex;

    for (let i = 0; i < runnableAccounts.length; i++) {
      checkIndex = (checkIndex + 1) % runnableAccounts.length;
      const candidate = runnableAccounts[checkIndex];
      if (isTimeWithinRange(candidate.allowedHours)) {
        const prev = this.currentAccountIndex;
        this.currentAccountIndex = candidate.originalIndex;
        console.log(`[Timing] Found active timing account: Index ${prev} → ${this.currentAccountIndex} (Window: ${candidate.allowedHours})`);
        return;
      }
    }

    console.log(`[Timing] WARNING: No runnable accounts are currently within their allowed time windows! Keeping index ${this.currentAccountIndex}.`);
  }

  /**
   * Dynamically rotates the active account to the next having "run": true in JSON and active timing.
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

    const runnableAccounts = accounts
      .map((acct, index) => ({ ...acct, originalIndex: index }))
      .filter((acct) => acct.run === true);

    if (runnableAccounts.length <= 1) {
      console.log(`[Rotation] Only ${runnableAccounts.length} runnable account found. No rotation change needed.`);
      return this.currentAccountIndex;
    }

    const currentPos = runnableAccounts.findIndex(a => a.originalIndex === this.currentAccountIndex);
    let checkPos = currentPos === -1 ? 0 : currentPos;

    for (let i = 0; i < runnableAccounts.length; i++) {
      checkPos = (checkPos + 1) % runnableAccounts.length;
      const candidate = runnableAccounts[checkPos];
      if (isTimeWithinRange(candidate.allowedHours)) {
        const prevIndex = this.currentAccountIndex;
        this.currentAccountIndex = candidate.originalIndex;
        console.log(`[Rotation] Rotated active account index: ${prevIndex} → ${this.currentAccountIndex} (Window: ${candidate.allowedHours})`);
        return this.currentAccountIndex;
      }
    }

    // Fallback if none are active
    const nextPos = (currentPos + 1) % runnableAccounts.length;
    const prevIndex = this.currentAccountIndex;
    this.currentAccountIndex = runnableAccounts[nextPos].originalIndex;
    console.log(`[Rotation Fallback] Rotated active account index: ${prevIndex} → ${this.currentAccountIndex} (None active in timing)`);
    return this.currentAccountIndex;
  }
}

module.exports = AccountRotator;
