/**
 * launcher.js - Reads bet_accounts.json and spawns one bet module process
 * per account that has "run": true. Each gets a unique port and account index.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ACCOUNTS_FILE = path.resolve(__dirname, "json", "bet_accounts.json");
const BASE_PORT = parseInt(process.env.BET_PORT || "4001", 10);

let accounts = [];
try {
  accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
} catch (err) {
  console.error(`[Launcher] Failed to read ${ACCOUNTS_FILE}:`, err.message);
  process.exit(1);
}

const runnableAccounts = accounts
  .map((acct, index) => ({ ...acct, originalIndex: index }))
  .filter(acct => acct.run === true);

if (runnableAccounts.length === 0) {
  console.error("[Launcher] No accounts with \"run\": true found in bet_accounts.json");
  process.exit(1);
}

console.log(`[Launcher] Found ${runnableAccounts.length} account(s) to launch:`);
runnableAccounts.forEach((acct, i) => {
  const port = BASE_PORT + i;
  console.log(`  ${i + 1}. ${acct.label || `Account ${acct.originalIndex}`} → port ${port} (index ${acct.originalIndex})`);
});
console.log("");

const children = [];

for (let i = 0; i < runnableAccounts.length; i++) {
  const acct = runnableAccounts[i];
  const port = BASE_PORT + i;
  const label = acct.label || `Account ${acct.originalIndex}`;

  const childEnv = {
    ...process.env,
    BET_PORT: String(port),
    ACCOUNT_INDEX: String(acct.originalIndex),
  };

  const child = spawn("node", [path.join(__dirname, "server.js")], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Prefix each line of output with the account label
  const prefix = `[${label}]`;

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(l => l.length > 0);
    for (const line of lines) {
      process.stdout.write(`${prefix} ${line}\n`);
    }
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter(l => l.length > 0);
    for (const line of lines) {
      process.stderr.write(`${prefix} ${line}\n`);
    }
  });

  child.on("exit", (code) => {
    console.error(`${prefix} Process exited with code ${code}`);
  });

  children.push(child);
}

// Graceful shutdown: forward kill signals to all children
function cleanup() {
  console.log("\n[Launcher] Shutting down all bet modules...");
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
