/**
 * launch_any.js - General browser launcher for direct URL / Hippo platforms.
 * Excludes Winbox login sequences for absolute simplicity and clean segregation.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { getBrowserArgs } = require("./browserArgs");
const { verifyProxyIp } = require("./proxy_verifier");
const { checkPageErrors } = require("./launch_winbox");
const { startNetworkWatchdog } = require("./network_watchdog");

const LOGIN_TIMESTAMPS_FILE = path.resolve(__dirname, "login_timestamps.json");
function readLoginTimestamps() {
  try { return JSON.parse(fs.readFileSync(LOGIN_TIMESTAMPS_FILE, "utf8")); } catch (e) { return {}; }
}
function writeLoginTimestamp(label) {
  const timestamps = readLoginTimestamps();
  timestamps[label] = Date.now();
  try { fs.writeFileSync(LOGIN_TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2)); } catch (e) {}
  return timestamps[label];
}

const TIMEOUTS = {
  dashboardWait: 3000,
  navigationWait: 30000,
  selectorWait: 10000,
  tabWait: 30000,
};

function buildAccountConfig(accountIndex = 0, accountsFilePath, modulePrefix = "") {
  const accountsFile = accountsFilePath || path.resolve(__dirname, "..", "eyes", "json", "eyes_accounts.json");
  
  let prefix = modulePrefix;
  if (!prefix) {
    prefix = accountsFile.includes("eyes_accounts") ? "EYES" : "BET";
  }

  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8")); } catch (err) {}
  
  const account = accounts[accountIndex] || {};
  
  const platform = account.platform || "hippo";
  const launchMethod = account.launchMethod || "connect";
  const baseProfileIndex = 2; // Default for eyes
  const basePort = 9223;
  const profileIndex = account.profileIndex ?? baseProfileIndex + accountIndex;
  const port = account.debuggingPort ?? basePort + accountIndex;

  const rawProxy = account.proxy || {};
  const useProxy = !!account.useProxy;

  return {
    accountIndex,
    modulePrefix: prefix,
    label: account.label || `Account ${accountIndex}`,
    platform,
    launchMethod,
    enableDomCleanup: account.enableDomCleanup ?? false,
    sessionRestartMinutes: account.sessionRestartMinutes || 0,
    chrome: {
      executablePath: process.env.CHROME_EXECUTABLE_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      userDataDir: process.env.CHROME_USER_DATA_DIR 
        ? `${process.env.CHROME_USER_DATA_DIR}\\Profile ${profileIndex}` 
        : `C:\\Temp\\ChromeProfile_${profileIndex}`,
      remoteDebuggingPort: port,
      extraArgs: getBrowserArgs() || [],
    },
    useProxy,
    proxy: useProxy ? rawProxy : {},
    credentials: account.credentials || {},
    urls: {
      pgLobby: ["hippo168.com", "cloudfront.net"]
    },
  };
}

async function launchAccount(acctConfig) {
  const { chrome, useProxy, proxy, urls, platform, launchMethod, modulePrefix } = acctConfig;
  const logger = { log: (msg) => console.log(`[${acctConfig.label}] ${msg}`), warn: (msg) => console.warn(`[${acctConfig.label}] ${msg}`), error: (msg) => console.error(`[${acctConfig.label}] ${msg}`) };

  const prefix = modulePrefix || "EYES";

  // --- EMBEDDED TAILSCALE PROXY HANDLING ---
  let tscProxy = null;
  if (proxy && proxy.type === "tailscale") {
    logger.log("Initializing embedded Tailscale node...");
    try {
      const { TSCProxy } = require("@tailscale/tscproxy");
      const port = proxy.port || 1055;
      const hostname = proxy.hostname || `puppeteer-${acctConfig.label.replace(/\s+/g, '-').toLowerCase()}`;
      tscProxy = await TSCProxy.start({
        authKey: proxy.authKey,
        hostname,
        socks5Addr: `127.0.0.1:${port}`,
        args: proxy.exitNode ? [`--exit-node=${proxy.exitNode}`] : []
      });
      logger.log(`Tailscale proxy successfully started on socks5://127.0.0.1:${port}`);
      proxy.server = `socks5://127.0.0.1:${port}`;
    } catch (err) {
      logger.error(`Failed to start Tailscale proxy: ${err.message}`);
      throw err;
    }
  }

  // --- PROXY COMMAND-LINE ARGUMENT FORMATTING ---
  let formattedProxy = "";
  if (proxy && proxy.server) {
    let proxyUrl = proxy.server;
    let scheme = "";
    const schemeMatch = proxyUrl.match(/^([a-zA-Z0-9+.-]+:\/\/)/);
    if (schemeMatch) {
      scheme = schemeMatch[1];
      proxyUrl = proxyUrl.substring(scheme.length);
    }
    if (proxyUrl.includes(":") && proxyUrl.split(":").length > 2 && !proxyUrl.startsWith("[")) {
      const lastColon = proxyUrl.lastIndexOf(":");
      const host = proxyUrl.substring(0, lastColon);
      const portPart = proxyUrl.substring(lastColon);
      if (/^:\d+$/.test(portPart)) {
        proxyUrl = `[${host}]${portPart}`;
      }
    }
    formattedProxy = scheme + proxyUrl;
  }

  let browser;
  if (launchMethod === "puppeteer") {
      logger.log("Launching fresh browser via native Puppeteer...");
      const launchArgs = [
        `--window-size=${process.env[`${prefix}_WINDOW_SIZE`] || process.env.CHROME_WINDOW_SIZE || "900,1400"}`,
        `--window-position=${process.env[`${prefix}_WINDOW_POSITION`] || process.env.CHROME_WINDOW_POSITION || "100,50"}`,
        ...chrome.extraArgs
      ];
      if (formattedProxy) {
        launchArgs.push(`--proxy-server=${formattedProxy}`);
      }
      browser = await puppeteer.launch({
          headless: false,
          defaultViewport: null,
          protocolTimeout: 30000,
          args: launchArgs,
      });
  } else {
      try {
        logger.log(`Checking if Chrome is already running on port ${chrome.remoteDebuggingPort}...`);
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.remoteDebuggingPort}`, defaultViewport: null });
        logger.log("Connected to existing Chrome instance.");
      } catch (e) {
        logger.log("Chrome not found on debugging port. Spawning new instance...");
        try {
          const lockFile = require("path").join(chrome.userDataDir, "lockfile");
          if (require("fs").existsSync(lockFile)) {
            require("fs").unlinkSync(lockFile);
            logger.log("Removed stale Chrome lock file.");
          }
        } catch (e) {}
        
        const chromeArgs = [
          `--remote-debugging-port=${chrome.remoteDebuggingPort}`,
          `--user-data-dir=${chrome.userDataDir}`,
          "--no-first-run", "--no-default-browser-check", "--mute-audio",
          `--window-size=${process.env[`${prefix}_WINDOW_SIZE`] || process.env.CHROME_WINDOW_SIZE || "900,1400"}`,
          `--window-position=${process.env[`${prefix}_WINDOW_POSITION`] || process.env.CHROME_WINDOW_POSITION || "100,50"}`,
          ...chrome.extraArgs,
        ];
        if (formattedProxy) {
          chromeArgs.push(`--proxy-server=${formattedProxy}`);
        }
        const chromeProcess = spawn(chrome.executablePath, chromeArgs, { detached: true, stdio: "ignore" });
        chromeProcess.unref();
        
        let connected = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
            try {
                browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.remoteDebuggingPort}`, defaultViewport: null });
                connected = true;
                break;
            } catch (err) {}
        }
        if (!connected) throw new Error("Failed to connect to newly spawned Chrome instance.");
      }
  }

  // --- TAILSCALE LIFECYCLE HOOK ---
  if (browser && tscProxy) {
    browser.tscProxy = tscProxy;
    browser.on('disconnected', async () => {
      logger.log("Browser disconnected, shutting down Tailscale proxy...");
      await tscProxy.close().catch(() => {});
    });
  }

  // --- GLOBAL EVENT-DRIVEN PROXY AUTHENTICATION ---
  if (browser && proxy && proxy.server && proxy.username && proxy.password) {
    logger.log("Setting up global proxy authentication listener...");
    const pages = await browser.pages().catch(() => []);
    for (const p of pages) {
      await p.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
    }
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) await p.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
        } catch (e) {}
      }
    });
  }

  // --- VERIFY EXTERNAL PROXY IP ---
  let verifiedIp = "Direct / No Proxy";
  if (useProxy) {
    verifiedIp = await verifyProxyIp({
      browser,
      proxy,
      label: acctConfig.label,
      logger,
      closeBrowserOnFailure: true
    });
  }

  logger.log(`Platform is ${platform}. Preparing Hippo page...`);
  let pages = await browser.pages();
  let page = pages.length > 0 ? pages[0] : await browser.newPage();
  
  const currentUrl = page.url() || "";
  const isAlreadyOnLobby = urls.pgLobby.some(domain => currentUrl.includes(domain)) && currentUrl.includes("multiplay");
  
  if (isAlreadyOnLobby) {
    logger.log("Browser is already on the Hippo multiplay page. Skipping navigation to avoid disrupting active session.");
  } else {
    logger.log("Navigating to Hippo multiplay lobby...");
    await page.goto("https://d3jai9eacl1740.cloudfront.net/lobby/multiplay", { waitUntil: "networkidle2", timeout: TIMEOUTS.navigationWait }).catch(() => {});
  }
  
  await checkPageErrors(page, logger);

  // Start active network watchdog on the page context
  startNetworkWatchdog(page, logger);

  return { browser, page, ip: verifiedIp };
}

module.exports = { launchAccount, buildAccountConfig };
