const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { buildAccountConfig } = require("../utils/launch_any");

const ACCOUNTS_PATH = path.resolve(__dirname, "json", "eyes_accounts.json");
const CONFIG_PATH = path.join(__dirname, "..", "dashboard", "config.json");

function getAccountConfig(index = 0) {
  if (index === 0) {
    try {
      const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
      const activeIndex = accounts.findIndex(a => a.run === true);
      if (activeIndex !== -1) {
        return buildAccountConfig(activeIndex, ACCOUNTS_PATH);
      }
    } catch (e) {}
  }
  return buildAccountConfig(index, ACCOUNTS_PATH);
}

function getDynamicConfig() {
  let ignoredTables = [];
  let rawConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      ignoredTables = rawConfig.ignoredTables || [];
    }
  } catch (e) {
    // Silent fallback
  }
  return {
    ignoredTables,
    config: rawConfig
  };
}

module.exports = {
  getAccountConfig,
  getDynamicConfig,
  accountsPath: ACCOUNTS_PATH,
  stateMaxAgeMinutes: parseInt(process.env.STATE_MAX_AGE_MINUTES) || 60,
  minBetDelayMs: parseInt(process.env.MIN_BET_DELAY_MS || "0", 10),
};
