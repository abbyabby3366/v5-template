/**
 * launch_winbox.js - Launch Chrome, login to Winbox, and navigate to Pretty Gaming.
 * Patterned after launch_bet.js from hotroad_learn.
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

const SELECTORS = {
  uid: 'input[placeholder="Enter UID / Email"]',
  password: 'input[placeholder="Enter password"]',
  myNav: "#My-Nav",
  loginPopup: "button.winbox-login-popup-btn",
  // Matches the provided DOM: img[src*="WINBOX/gamelist/PRETY/pc/cover.png"]
  prettyGamingIcon: 'img[src*="PRETY/pc/cover"], img[src*="PRETY"]', 
};

const TIMEOUTS = {
  dashboardWait: 3000,
  navigationWait: 30000,
  selectorWait: 10000,
  tabWait: 30000,
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
 * Perform a single immediate check (or quick wait) on the page for error overlays
 * and dismiss them. Helpful right after launch/navigation.
 * 
 * @param {import('puppeteer').Page} page
 * @param {Object} logger
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
        ".EmailVerificationRoot"
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
            ".el-message-box__btns .el-button--primary",
            "button.swal-button--confirm",
            ".modal-footer button",
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

  // Let it settle for a couple of seconds
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
  
  const account = accounts[accountIndex] || { credentials: { email: process.env.WINBOX_EMAIL, password: process.env.WINBOX_PASSWORD } };
  
  const platform = account.platform || "winbox";
  const launchMethod = account.launchMethod || "connect";
  const baseProfileIndex = 9; // Adjust as needed
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
    urls: {
      login: "https://login.winboxmalay.com/",
      pgLobby: ["hippo168.com", "cloudfront.net"] // Supports both direct URL and Winbox CloudFront redirect
    },
  };
}

const STATES = {
  IN_GAME: "IN_GAME",
  WINBOX_DASHBOARD: "WINBOX_DASHBOARD",
  WINBOX_LOGIN: "WINBOX_LOGIN",
  UNINITIALIZED: "UNINITIALIZED",
};

async function evaluateState(browser, urls) {
  const pages = await browser.pages();
  const validPages = pages.filter(p => {
      const url = p.url() || "";
      return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.includes("devtools://");
  });

  // 1. Check if ANY page is inside Pretty Gaming lobby first
  for (const p of validPages) {
    try {
      const url = p.url() || "";
      if (urls.pgLobby.some(domain => url.includes(domain))) {
        return { state: STATES.IN_GAME, page: p };
      }
    } catch (e) {}
  }
  
  let bestState = STATES.UNINITIALIZED;
  let targetPage = validPages.length > 0 ? validPages[0] : null;

  for (const p of validPages) {
    try {
      const url = p.url() || "";

      // Check for "Session timeout" overlay — blocks all interactions.
      // Dismissing and reloading clears the overlay and forces re-login.
      let sessionBox = null;
      let boxText = "";
      for (const frame of p.frames()) {
        sessionBox = await frame.$(".el-message-box").catch(() => null);
        if (sessionBox) {
          boxText = await frame
            .evaluate((el) => el.innerText, sessionBox)
            .catch(() => "");
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
          lowerText.includes("log in from elsewhere")
        ) {
          console.log(`[evaluateState] Session timeout overlay detected — dismissing and reloading...`);

          // Strategy 1: Click OK button via child selector
          let dismissed = false;
          const okBtn = await sessionBox
            .$(".el-message-box__btns button")
            .catch(() => null);
          if (okBtn) {
            await okBtn.click().catch(() => {});
            dismissed = true;
          }

          // Strategy 2: Try frame-level selector fallback
          if (!dismissed) {
            for (const frame of p.frames()) {
              try {
                const clicked = await frame.evaluate(() => {
                  const btn =
                    document.querySelector(".el-message-box__btns button") ||
                    document.querySelector(".el-message-box__btns .el-button--primary");
                  if (btn) { btn.click(); return true; }
                  const allBtns = document.querySelectorAll(".el-message-box button");
                  for (const b of allBtns) {
                    if (/OK|Confirm/i.test(b.textContent)) { b.click(); return true; }
                  }
                  return false;
                });
                if (clicked) { dismissed = true; break; }
              } catch (e) {}
            }
          }

          await sleep(1000);
          await p.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
          await sleep(2000);
          continue; // Re-evaluate this page's state after reload
        }
      }

      let isDashboard = false;
      let isLogin = false;

      for (const frame of p.frames()) {
        try {
          if (await frame.$(SELECTORS.myNav).catch(() => null)) isDashboard = true;
          if (await frame.$(SELECTORS.uid).catch(() => null) ||
              await frame.$$(SELECTORS.loginPopup).then(el => el.length > 0).catch(() => false)) isLogin = true;
        } catch (e) {}
      }

      if (isDashboard) {
        if (bestState === STATES.UNINITIALIZED || bestState === STATES.WINBOX_LOGIN) {
          bestState = STATES.WINBOX_DASHBOARD;
          targetPage = p;
        }
      } else if (isLogin || url.includes(urls.login)) {
        if (bestState === STATES.UNINITIALIZED) {
          bestState = STATES.WINBOX_LOGIN;
          targetPage = p;
        }
      }
    } catch (e) {}
  }
  return { state: bestState, page: targetPage };
}



async function launchAccount(acctConfig) {
  const { chrome, useProxy, proxy, credentials, urls, platform, launchMethod, modulePrefix } = acctConfig;
  const logger = { log: (msg) => console.log(`[${acctConfig.label}] ${msg}`), warn: (msg) => console.warn(`[${acctConfig.label}] ${msg}`), error: (msg) => console.error(`[${acctConfig.label}] ${msg}`) };

  const prefix = modulePrefix || "BET";
  let verifiedIp = "Direct / No Proxy";

  if (platform === "winbox" && (!credentials.email || !credentials.password)) {
      throw new Error("Missing Winbox credentials. Please set WINBOX_EMAIL and WINBOX_PASSWORD in .env");
  }

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
    
    // Extract protocol scheme if present (e.g., http://, socks5://)
    const schemeMatch = proxyUrl.match(/^([a-zA-Z0-9+.-]+:\/\/)/);
    if (schemeMatch) {
      scheme = schemeMatch[1];
      proxyUrl = proxyUrl.substring(scheme.length);
    }
    
    // Handle wrapping of raw IPv6 hosts with port numbers in brackets
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
    
    // 1. Authenticate existing pages/tabs
    const pages = await browser.pages().catch(() => []);
    for (const p of pages) {
      await p.authenticate({ username: proxy.username, password: proxy.password })
        .catch((e) => logger.warn(`Proxy authentication failed on existing page: ${e.message}`));
    }

    // 2. Authenticate any newly created pages/tabs in the browser context dynamically
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) {
            await p.authenticate({ username: proxy.username, password: proxy.password })
              .catch((e) => logger.warn(`Proxy authentication failed on new page: ${e.message}`));
          }
        } catch (e) {
          // Ignore if target page is closed during initialization
        }
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
      while (currentState !== STATES.IN_GAME && safetyCounter < 10) {
        safetyCounter++;
        logger.log(`Executing state: ${currentState}`);
        
        if (currentState === STATES.UNINITIALIZED) {
          logger.log("Navigating to winboxmalay...");
          await page.goto(urls.login, { waitUntil: "networkidle2", timeout: TIMEOUTS.navigationWait }).catch(() => {});
          await sleep(1500);
        } else if (currentState === STATES.WINBOX_LOGIN) {
          logger.log("Handling WINBOX_LOGIN...");
          for (const frame of page.frames()) {
            try {
              const popupBtns = await frame.$$(SELECTORS.loginPopup);
              for (const btn of popupBtns) {
                if ((await frame.evaluate(el => el.textContent, btn)).includes("Log In")) {
                  await btn.click(); await sleep(500); break;
                }
              }
            } catch(e) {}
          }
          
          let loginFrame = page;
          for (const frame of page.frames()) if (await frame.$(SELECTORS.uid).catch(()=>null)) { loginFrame = frame; break; }
          
          await loginFrame.$eval(SELECTORS.uid, el => el.value = "").catch(() => {});
          await loginFrame.type(SELECTORS.uid, credentials.email, { delay: 10 });
          await loginFrame.$eval(SELECTORS.password, el => el.value = "").catch(() => {});
          await loginFrame.type(SELECTORS.password, credentials.password, { delay: 10 });
          await sleep(500);
          
          const buttons = await loginFrame.$$("button");
          for (const button of buttons) {
            if ((await loginFrame.evaluate(el => el.textContent, button)).includes("Log In")) {
              await button.click(); break;
            }
          }
          logger.log("Login submitted. Waiting for dashboard...");
          writeLoginTimestamp(acctConfig.label);
          await sleep(TIMEOUTS.dashboardWait);
        } else if (currentState === STATES.WINBOX_DASHBOARD) {
          logger.log("Handling WINBOX_DASHBOARD...");
          
          let dialogHandled = false;
          for (const frame of page.frames()) {
            try {
              const buttons = await frame.$$("button");
              let action = null;
              let matchedButton = null;
  
              for (const button of buttons) {
                const text = await frame.evaluate((el) => el.textContent, button);
                if (text.trim().includes("Quit Game")) {
                  matchedButton = button;
                  action = "quit";
                  break;
                } else if (text.trim().includes("Start Game")) {
                  matchedButton = button;
                  action = "start";
                  break;
                }
              }
  
              if (action === "quit") {
                logger.log("Found 'Quit Game' button. Clicking to exit previous session...");
                await matchedButton.click().catch(() => {});
                await sleep(4000);
                dialogHandled = true;
              } else if (action === "start") {
                logger.log("Found 'Start Game' button. Clicking...");
                const newTargetPromise = browser.waitForTarget((t) => t.opener() === page.target(), { timeout: TIMEOUTS.tabWait }).catch(() => null);
                await matchedButton.click().catch(() => {});
                
                const newTarget = await newTargetPromise;
                if (newTarget) {
                  page = await newTarget.page();
                  await sleep(2500);
                }
                dialogHandled = true;
              }
            } catch (e) {}
            if (dialogHandled) break;
          }
  
          if (!dialogHandled) {
            let gameClicked = false;
            
            // Wait for dashboard to settle
            await sleep(1500);
            
            // Find and click the Pretty Gaming icon
            for (const frame of page.frames()) {
              try {
                const pgIcon = await frame.$(SELECTORS.prettyGamingIcon);
                if (pgIcon) {
                  logger.log("Found Pretty Gaming icon. Clicking...");
                  await pgIcon.click();
                  gameClicked = true;
                  break;
                }
              } catch(e) {}
              if (gameClicked) break;
            }
            
            if (gameClicked) {
               logger.log("Waiting for game dialog to appear...");
               await sleep(3000); 
            } else {
               logger.warn("Could not find Pretty Gaming icon in dashboard.");
            }
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
        logger.log("SUCCESS: Reached Pretty Gaming lobby!");
        
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
  throw new Error("Failed to reach Pretty Gaming lobby after multiple attempts.");
}

module.exports = { launchAccount, buildAccountConfig, checkPageErrors };

if (require.main === module) {
  const accountIndex = parseInt(process.argv[2], 10) || 0;
  const acctConfig = buildAccountConfig(accountIndex);
  launchAccount(acctConfig).then(({ browser, page }) => {
    console.log("Successfully launched Pretty Gaming.");
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
