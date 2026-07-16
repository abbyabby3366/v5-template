/**
 * launch_1xroll.js — Launch Chrome, login to 1XROLL, and navigate to filtered Live Casino.
 * Patterned after launch_winbox.js with resilient state-machine approach.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const { getBrowserArgs } = require("./browserArgs");
const { verifyProxyIp } = require("./proxy_verifier");

// ── Login timestamp persistence ──────────────────────────────
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

// ── Selectors ────────────────────────────────────────────────
const SELECTORS = {
  // Header state indicators
  unauthorizedHeader: ".UnAuthorized",
  authorizedHeader: ".Authorized",
  // Login modal triggers
  loginBtn: ".LoginBtn",
  // Login form inputs
  usernameInput: 'input[placeholder="username"]',
  passwordInput: 'input[placeholder="password"]',
  // Login form submit
  submitLogin: ".btnLogin",
  // Modal container
  loginModal: ".ant-modal",
  // Game items on filtered live casino page
  gameItem: ".game-item",
  gameCardWrapper: ".game-card-wrapper",
  // Game card image for Speedbaccarat (used to identify the correct card to click)
  speedBaccaratImg: 'img[src*="115091a6a14345d7acf622aea3d3428e"]',
  // Currency selection dialog
  currencyDialog: ".choose-currency-background",
  currencyWarn: ".choose-currency-warn",
  playNowBtn: ".play-button",
  // In-game iframe detection (game table loaded)
  tableName: ".tableName",
};

const TIMEOUTS = {
  dashboardWait: 3000,
  navigationWait: 30000,
  selectorWait: 10000,
  tabWait: 30000,
  settleWait: 1500,
};

const URLS = {
  login: "https://1xroll.my/",
  liveCasino: "https://1xroll.my/live-casino?page=1&brand=dblive",
  // URL patterns that indicate we are in the game lobby
  gameLobby: ["/live-casino"],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killZombieChromeOnPort(port, logger) {
  const targetFlag = `--remote-debugging-port=${port}`;
  try {
    const psCommand = [
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"`,
      `| Where-Object { $_.CommandLine -like '*${targetFlag}*' -and $_.CommandLine -notlike '*--type=*' }`,
      `| Select-Object -ExpandProperty ProcessId`,
    ].join(" ");
    const { stdout } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${psCommand}"`,
      { encoding: "utf8", timeout: 10000 },
    );
    const pids = stdout.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        logger.warn(`Found zombie Chrome (PID ${pid}) with ${targetFlag}. Killing...`);
        await execAsync(`taskkill /PID ${pid} /F /T`, { timeout: 5000 });
      } catch (e) {}
    }
  } catch (e) {}
}

/**
 * Check the page for common error overlays (SweetAlert, Ant Design modals, etc.)
 * and dismiss them automatically.
 */
async function checkPageErrors(page, logger = console) {
  try {
    const errorState = await page.evaluate(() => {
      const selectors = [
        ".el-message-box",
        ".swal2-container",
        ".swal-modal",
        ".modal-dialog",
        ".dialog-container",
        ".popup-box",
        ".ant-modal-confirm",
      ];

      let foundBox = null;
      let boxText = "";

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          if (isVisible) {
            foundBox = el;
            boxText = el.innerText || "";
            break;
          }
        }
      }

      if (foundBox) {
        const lowerText = boxText.toLowerCase();
        const errorPatterns = [
          "session timeout",
          "access denied",
          "another device",
          "logged out",
          "kick out",
          "please login",
          "connection lost",
          "disconnected",
          "network error",
          "maintenance",
          "login expired",
          "log in from elsewhere"
        ];

        const hasError = errorPatterns.some(pat => lowerText.includes(pat));
        if (hasError) {
          const confirmSelectors = [
            "button.swal2-confirm",
            ".el-message-box__btns button",
            ".ant-modal-confirm-btns button",
            ".ant-btn-primary",
            "button"
          ];

          let clicked = false;
          for (const sel of confirmSelectors) {
            const btns = Array.from(foundBox.querySelectorAll(sel));
            const confirmBtn = btns.find(b => {
              const txt = (b.textContent || b.innerText || "").trim().toLowerCase();
              return /ok|confirm|yes|close|retry|continue/i.test(txt);
            });

            if (confirmBtn) {
              confirmBtn.click();
              clicked = true;
              break;
            }
          }

          return { found: true, text: boxText.trim(), clicked };
        }
      }

      return { found: false };
    });

    if (errorState && errorState.found) {
      logger.warn(`[PageCheck] Found error overlay on start: "${errorState.text}". Dismissed: ${errorState.clicked}`);
      await sleep(1500);
      await page.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    }
  } catch (err) {
    // Ignore errors during check
  }

  await sleep(3000);
}

function buildAccountConfig(accountIndex = 0, accountsFilePath, modulePrefix = "") {
  const accountsFile = accountsFilePath || path.resolve(__dirname, "..", "bet_module", "json", "bet_accounts.json");

  let prefix = modulePrefix;
  if (!prefix) {
    prefix = accountsFile.includes("eyes_accounts") ? "EYES" : "BET";
  }

  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8")); } catch (err) {}

  const account = accounts[accountIndex] || { credentials: {} };

  const platform = account.platform || "1xroll";
  const launchMethod = account.launchMethod || "connect";
  const baseProfileIndex = 9;
  const basePort = 9222;
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
    betType: account.betType || "variable",
    allowedFixedAmounts: account.allowedFixedAmounts || [5000, 10000, 15000, 20000],
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
    urls: URLS,
  };
}

// ── State Machine ────────────────────────────────────────────

const STATES = {
  IN_GAME: "IN_GAME",
  XROLL_CURRENCY_SELECT: "XROLL_CURRENCY_SELECT",
  XROLL_GAME_LOBBY: "XROLL_GAME_LOBBY",
  XROLL_DASHBOARD: "XROLL_DASHBOARD",
  XROLL_LOGIN: "XROLL_LOGIN",
  UNINITIALIZED: "UNINITIALIZED",
};

/**
 * Evaluate the current browser state by scanning all open pages for known selectors.
 * This is called repeatedly to determine which step we're at, making the flow resilient
 * to lag, mispresses, and session timeouts.
 */
async function evaluateState(browser, urls) {
  const pages = await browser.pages();
  const validPages = pages.filter(p => {
    const url = p.url() || "";
    return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.includes("devtools://");
  });

  let bestState = STATES.UNINITIALIZED;
  let targetPage = validPages.length > 0 ? validPages[0] : null;

  for (const p of validPages) {
    try {
      const url = p.url() || "";

      // --- Check for error/session overlays and dismiss them ---
      let sessionBox = null;
      let boxText = "";
      for (const frame of p.frames()) {
        sessionBox = await frame.$(".swal2-container, .el-message-box, .ant-modal-confirm").catch(() => null);
        if (sessionBox) {
          boxText = await frame.evaluate((el) => el.innerText, sessionBox).catch(() => "");
          break;
        }
      }

      if (sessionBox) {
        const lowerText = boxText.toLowerCase();
        if (
          lowerText.includes("session timeout") ||
          lowerText.includes("access denied") ||
          lowerText.includes("another device") ||
          lowerText.includes("logged out") ||
          lowerText.includes("kick out") ||
          lowerText.includes("please login") ||
          lowerText.includes("log in from elsewhere")
        ) {
          console.log(`[evaluateState] Session timeout overlay detected — dismissing and reloading...`);

          let dismissed = false;
          const okBtn = await sessionBox.$("button.swal2-confirm, .ant-btn-primary, button").catch(() => null);
          if (okBtn) {
            await okBtn.click().catch(() => {});
            dismissed = true;
          }

          await sleep(1000);
          await p.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
          await sleep(2000);
          continue;
        }
      }

      // --- Check for IN_GAME — iframe with .tableName containing game text ---
      let inGameDetected = false;
      for (const frame of p.frames()) {
        try {
          const tableNameEl = await frame.$(SELECTORS.tableName).catch(() => null);
          if (tableNameEl) {
            const text = await frame.evaluate(el => el.textContent || "", tableNameEl).catch(() => "");
            if (text.includes("极速百家乐")) {
              inGameDetected = true;
              break;
            }
          }
        } catch (e) {}
      }

      if (inGameDetected) {
        return { state: STATES.IN_GAME, page: p };
      }

      // --- Check for currency selection dialog ---
      let hasCurrencyDialog = false;
      for (const frame of p.frames()) {
        try {
          const dialog = await frame.$(SELECTORS.currencyDialog).catch(() => null);
          if (dialog) {
            const playBtn = await frame.$(SELECTORS.playNowBtn).catch(() => null);
            if (playBtn) {
              hasCurrencyDialog = true;
              break;
            }
          }
        } catch (e) {}
      }

      if (hasCurrencyDialog) {
        return { state: STATES.XROLL_CURRENCY_SELECT, page: p };
      }

      // --- Check for game lobby (on live casino page with game items) ---
      if (urls.gameLobby.some(pattern => url.includes(pattern))) {
        let isAuthorized = false;
        let hasGameItems = false;
        for (const frame of p.frames()) {
          try {
            if (await frame.$(SELECTORS.authorizedHeader).catch(() => null)) isAuthorized = true;
            const items = await frame.$$(SELECTORS.gameItem).catch(() => []);
            if (items.length > 0) hasGameItems = true;
          } catch (e) {}
        }

        if (isAuthorized && hasGameItems) {
          return { state: STATES.XROLL_GAME_LOBBY, page: p };
        } else if (isAuthorized) {
          // On live casino page but game items not loaded yet — still dashboard
          if (bestState === STATES.UNINITIALIZED || bestState === STATES.XROLL_LOGIN) {
            bestState = STATES.XROLL_DASHBOARD;
            targetPage = p;
          }
          continue;
        }
      }

      // --- Determine if dashboard or login page ---
      let isDashboard = false;
      let isLogin = false;

      for (const frame of p.frames()) {
        try {
          if (await frame.$(SELECTORS.authorizedHeader).catch(() => null)) isDashboard = true;
          if (await frame.$(SELECTORS.unauthorizedHeader).catch(() => null)) isLogin = true;
          if (await frame.$(SELECTORS.loginBtn).catch(() => null)) isLogin = true;
        } catch (e) {}
      }

      if (isDashboard) {
        if (bestState === STATES.UNINITIALIZED || bestState === STATES.XROLL_LOGIN) {
          bestState = STATES.XROLL_DASHBOARD;
          targetPage = p;
        }
      } else if (isLogin || url.includes("1xroll.my")) {
        if (bestState === STATES.UNINITIALIZED) {
          bestState = STATES.XROLL_LOGIN;
          targetPage = p;
        }
      }
    } catch (e) {}
  }

  return { state: bestState, page: targetPage };
}

// ── Main Launch Function ─────────────────────────────────────

async function launchAccount(acctConfig) {
  const { chrome, useProxy, proxy, credentials, platform, launchMethod, modulePrefix } = acctConfig;
  const urls = acctConfig.urls || URLS;
  const logger = {
    log: (msg) => console.log(`[${acctConfig.label}] ${msg}`),
    warn: (msg) => console.warn(`[${acctConfig.label}] ${msg}`),
    error: (msg) => console.error(`[${acctConfig.label}] ${msg}`),
  };

  const prefix = modulePrefix || "BET";
  let verifiedIp = "Direct / No Proxy";

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
      await killZombieChromeOnPort(chrome.remoteDebuggingPort, logger);
      await sleep(500);

      // Clean up stale lock file from previous force-killed sessions
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

      // Progressive backoff to wait for Chrome to start
      let connected = false;
      for (let attempt = 1; attempt <= 5; attempt++) {
        await sleep(2000 * attempt);
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
      await p.authenticate({ username: proxy.username, password: proxy.password })
        .catch((e) => logger.warn(`Proxy authentication failed on existing page: ${e.message}`));
    }

    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) {
            await p.authenticate({ username: proxy.username, password: proxy.password })
              .catch((e) => logger.warn(`Proxy authentication failed on new page: ${e.message}`));
          }
        } catch (e) {}
      }
    });
  }

  // --- VERIFY EXTERNAL PROXY IP ---
  if (useProxy) {
    verifiedIp = await verifyProxyIp({
      browser,
      proxy,
      label: acctConfig.label,
      logger,
      closeBrowserOnFailure: true
    });
  }

  // ── State Machine Loop ─────────────────────────────────────
  let mainLoopRetries = 0;
  while (mainLoopRetries < 3) {
    mainLoopRetries++;
    let { state: currentState, page } = await evaluateState(browser, urls);

    if (!page) {
      page = await browser.newPage();
      currentState = STATES.UNINITIALIZED;
    }

    logger.log(`Initial state detected: ${currentState}`);

    try {
      let safetyCounter = 0;
      while (currentState !== STATES.IN_GAME && safetyCounter < 15) {
        safetyCounter++;
        logger.log(`Executing state: ${currentState}`);

        if (currentState === STATES.UNINITIALIZED) {
          logger.log("Navigating to 1xroll.my...");
          await page.goto(urls.login, { waitUntil: "networkidle2", timeout: TIMEOUTS.navigationWait }).catch(() => {});
          await sleep(TIMEOUTS.settleWait);

        } else if (currentState === STATES.XROLL_LOGIN) {
          logger.log("Handling XROLL_LOGIN...");

          // Check if the login modal is already open
          let modalOpen = false;
          for (const frame of page.frames()) {
            try {
              const modal = await frame.$(SELECTORS.loginModal).catch(() => null);
              if (modal) {
                const usernameInput = await frame.$(SELECTORS.usernameInput).catch(() => null);
                if (usernameInput) {
                  modalOpen = true;
                  break;
                }
              }
            } catch (e) {}
          }

          // If modal is not open, click the login button to open it
          if (!modalOpen) {
            logger.log("Login modal not open. Clicking Login button...");
            for (const frame of page.frames()) {
              try {
                const loginBtn = await frame.$(SELECTORS.loginBtn).catch(() => null);
                if (loginBtn) {
                  await loginBtn.click();
                  await sleep(2000);
                  break;
                }
              } catch (e) {}
            }
          }

          // Now fill in credentials using Vue-compatible event dispatching
          logger.log("Filling in credentials...");
          await page.evaluate((selectors, creds) => {
            const uInput = document.querySelector(selectors.usernameInput);
            const pInput = document.querySelector(selectors.passwordInput);

            if (uInput) {
              uInput.value = creds.email;
              uInput.dispatchEvent(new Event("input", { bubbles: true }));
              uInput.dispatchEvent(new Event("change", { bubbles: true }));
            }
            if (pInput) {
              pInput.value = creds.password;
              pInput.dispatchEvent(new Event("input", { bubbles: true }));
              pInput.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, SELECTORS, credentials);

          await sleep(500);

          // Click the submit login button
          logger.log("Clicking submit login button...");
          for (const frame of page.frames()) {
            try {
              const submitBtn = await frame.$(SELECTORS.submitLogin).catch(() => null);
              if (submitBtn) {
                await submitBtn.click();
                break;
              }
            } catch (e) {}
          }

          logger.log("Login submitted. Waiting for dashboard...");
          writeLoginTimestamp(acctConfig.label);
          await sleep(TIMEOUTS.dashboardWait);

        } else if (currentState === STATES.XROLL_DASHBOARD) {
          logger.log("Handling XROLL_DASHBOARD...");

          // Check if we're already on the live casino page
          const currentUrl = page.url() || "";
          if (urls.gameLobby.some(pattern => currentUrl.includes(pattern))) {
            logger.log("Already on live casino page. Waiting for game items to load...");
            await sleep(3000);
          } else {
            // Navigate to the filtered live casino page
            logger.log("Navigating to filtered live casino page...");
            await page.goto(urls.liveCasino, { waitUntil: "networkidle2", timeout: TIMEOUTS.navigationWait }).catch(() => {});
            await sleep(TIMEOUTS.settleWait);
          }

        } else if (currentState === STATES.XROLL_GAME_LOBBY) {
          logger.log("Handling XROLL_GAME_LOBBY — clicking Speedbaccarat game card...");

          // Find and click the Speedbaccarat game card by its unique image src
          let clicked = false;
          for (const frame of page.frames()) {
            try {
              const gameImg = await frame.$(SELECTORS.speedBaccaratImg).catch(() => null);
              if (gameImg) {
                // Click the image itself — the card's click handler should fire
                await gameImg.click();
                clicked = true;
                logger.log("Clicked Speedbaccarat game card image.");
                break;
              }
            } catch (e) {}
          }

          if (!clicked) {
            // Fallback: try clicking the first .game-item on the page
            logger.warn("Speedbaccarat image not found. Trying first .game-item as fallback...");
            for (const frame of page.frames()) {
              try {
                const firstItem = await frame.$(SELECTORS.gameItem).catch(() => null);
                if (firstItem) {
                  await firstItem.click();
                  clicked = true;
                  logger.log("Clicked first game item as fallback.");
                  break;
                }
              } catch (e) {}
            }
          }

          if (clicked) {
            logger.log("Waiting for currency selection dialog...");
            await sleep(3000);
          } else {
            logger.warn("No game card found to click. Retrying...");
            await sleep(2000);
          }

        } else if (currentState === STATES.XROLL_CURRENCY_SELECT) {
          logger.log("Handling XROLL_CURRENCY_SELECT — clicking Play Now...");

          let clicked = false;
          for (const frame of page.frames()) {
            try {
              const playBtn = await frame.$(SELECTORS.playNowBtn).catch(() => null);
              if (playBtn) {
                await playBtn.click();
                clicked = true;
                logger.log("Clicked 'Play Now' button.");
                break;
              }
            } catch (e) {}
          }

          if (clicked) {
            logger.log("Waiting for game iframe to load...");
            await sleep(8000);
          } else {
            logger.warn("Play Now button not found. Retrying...");
            await sleep(2000);
          }
        }

        await sleep(2000);
        let nextStateResult = await evaluateState(browser, urls);
        currentState = nextStateResult.state;
        if (nextStateResult.page && page !== nextStateResult.page) {
          page = nextStateResult.page;
        }
      }

      if (currentState === STATES.IN_GAME) {
        logger.log("SUCCESS: Game iframe loaded — Speedbaccarat table is ready!");

        await checkPageErrors(page, logger);

        const { startNetworkWatchdog } = require("./network_watchdog");
        startNetworkWatchdog(page, logger);

        return { browser, page, ip: verifiedIp };
      }
    } catch (err) {
      logger.error(`Error during launch/login attempt ${mainLoopRetries}: ${err.message}`);
      if (page && !page.isClosed()) {
        logger.log("Closing the current page/tab to clean up...");
        await page.close().catch(() => {});
      }
      if (mainLoopRetries < 3) {
        logger.log("Retrying launch sequence with a new clean tab...");
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Failed to reach 1XROLL Live Casino after multiple attempts.");
}

module.exports = { launchAccount, buildAccountConfig, checkPageErrors };

if (require.main === module) {
  const accountIndex = parseInt(process.argv[2], 10) || 0;
  const acctConfig = buildAccountConfig(accountIndex);
  launchAccount(acctConfig).then(({ browser, page }) => {
    console.log("Successfully launched 1XROLL Live Casino.");
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
