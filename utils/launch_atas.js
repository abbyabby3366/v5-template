/**
 * launch_atas.js — Launch Chrome, login to ATAS, and navigate to Hotroad Lobby / Pretty Gaming Baccarat.
 * Patterned after launch_winbox.js and launch_a9.js.
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
function getLoginTimestamp(label) {
  return readLoginTimestamps()[label] || null;
}
function clearLoginTimestamp(label) {
  const timestamps = readLoginTimestamps();
  if (timestamps[label]) {
    delete timestamps[label];
    try {
      fs.writeFileSync(LOGIN_TIMESTAMPS_FILE, JSON.stringify(timestamps, null, 2));
    } catch (e) {}
  }
}

const SELECTORS = {
  uid: 'input[placeholder="Enter UID / Email"], input[type="text"], input[placeholder*="Username" i], input[placeholder*="ID" i]',
  password: 'input[placeholder="Enter password"], input[type="password"], input[placeholder*="Password" i]',
  loginButton: 'button.bigbtn.el-button--primary:not(.TelegramBtn), .LoginAtas form .buttons button.el-button--primary:not(.TelegramBtn), button.login, button[type="submit"]',
  dashboardIndicator: '.topnav__info-checkin, a[href*="profile" i], .user-info',
  liveCasinoLink: 'a[href*="casino" i], div[class*="casino" i], span[class*="casino" i], :text("Live Casino"), :text("Casino")',
  prettyGamingIcon: 'img[src*="PRETY"], img[src*="pretty" i], [data-vendor="PRETTY" i]',
  swalConfirmButton: 'button.swal2-confirm, button.el-button--primary',
  dashboardPopupCloseButton: '.js-popup-close-btn, button.close, .modal-close, .popup-close',
};

const TIMEOUTS = {
  initialWait: 1500,
  settleWait: 500,
  dashboardWait: 3000,
  navigationWait: 30000,
  selectorWait: 10000,
  tabWait: 30000,
};

const URLS = {
  login: "https://atas66my3.com/ms/login/",
  pgLobby: ["hippo168.com", "cloudfront.net", "prettygaming", "prety", "yctkrs.com", "tlbdyyfwpt.com", "teamwork33.com", "evo/mini", "evats1", "hotroadgaming.com", "hotroad"]
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
  
  const account = accounts[accountIndex] || {};
  
  const platform = account.platform || "atas";
  const launchMethod = account.launchMethod || "connect";
  const baseProfileIndex = 9;
  const basePort = 9222;
  const profileIndex = account.profileIndex ?? baseProfileIndex + accountIndex;
  const port = account.debuggingPort ?? basePort + accountIndex;

  const rawProxy = account.proxy || {};
  const useProxy = !!account.useProxy;

  const mergedUrls = { ...URLS, ...(account.urls || {}) };
  const mergedSelectors = { ...SELECTORS, ...(account.selectors || {}) };

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
    urls: mergedUrls,
    selectors: mergedSelectors,
    timeouts: TIMEOUTS,
  };
}

const STATES = {
  IN_GAME: "IN_GAME",
  ATAS_DIALOG: "ATAS_DIALOG",
  ATAS_DASHBOARD: "ATAS_DASHBOARD",
  ATAS_LOGIN: "ATAS_LOGIN",
  UNINITIALIZED: "UNINITIALIZED",
};

/**
 * Recursively gets all frames in the page/frame, including content frames of <iframe> elements.
 * 
 * @param {import('puppeteer').Page | import('puppeteer').Frame} pageOrFrame
 * @param {Set<import('puppeteer').Frame>} visited
 * @returns {Promise<import('puppeteer').Frame[]>}
 */
async function getAllFrames(pageOrFrame, visited = new Set()) {
  const frames = [];
  
  let childFrames = [];
  try {
    if (typeof pageOrFrame.frames === 'function') {
      childFrames = pageOrFrame.frames();
    } else if (typeof pageOrFrame.childFrames === 'function') {
      childFrames = pageOrFrame.childFrames();
    }
  } catch (e) {}

  for (const f of childFrames) {
    if (!visited.has(f)) {
      visited.add(f);
      frames.push(f);
      const nested = await getAllFrames(f, visited);
      frames.push(...nested);
    }
  }

  try {
    const iframeElements = await pageOrFrame.$$('iframe').catch(() => []);
    for (const iframeEl of iframeElements) {
      const contentFrame = await iframeEl.contentFrame().catch(() => null);
      if (contentFrame && !visited.has(contentFrame)) {
        visited.add(contentFrame);
        frames.push(contentFrame);
        const nested = await getAllFrames(contentFrame, visited);
        frames.push(...nested);
      }
    }
  } catch (e) {}

  return frames;
}

/**
 * Gets all frames in the page, starting from the main frame.
 * 
 * @param {import('puppeteer').Page} page
 * @returns {Promise<import('puppeteer').Frame[]>}
 */
async function getAllFramesOfPage(page) {
  const visited = new Set();
  const mainFrame = page.mainFrame();
  visited.add(mainFrame);
  const childFrames = await getAllFrames(mainFrame, visited);
  return [mainFrame, ...childFrames];
}

async function evaluateState(browser, urls, selectors) {
  const pages = await browser.pages();
  const validPages = pages.filter(p => {
      const url = p.url() || "";
      return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.includes("devtools://");
  });

  // 1. Check if ANY page is inside the game lobby first
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
      const allFrames = await getAllFramesOfPage(p);

      // Check all frames
      let hasUid = false;
      let hasLandingBtn = false;
      let hasDashboardIndicator = false;
      let hasDialog = false;

      for (const frame of allFrames) {
        try {
          if (await frame.$(selectors.uid).catch(() => null)) hasUid = true;
          if (await frame.$('.Login-btn').catch(() => null)) hasLandingBtn = true;
          if (await frame.$('.topnav__info-checkin, .item, .column-scroll-area').catch(() => null)) {
            hasDashboardIndicator = true;
          }
          const dialogs = await frame.$$('.game-pop__dialog').catch(() => []);
          for (const dialogEl of dialogs) {
            const isVisible = await frame.evaluate(el => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
            }, dialogEl).catch(() => false);
            if (isVisible) {
              hasDialog = true;
              break;
            }
          }
        } catch (e) {}
      }

      if (hasDialog) {
        return { state: STATES.ATAS_DIALOG, page: p };
      }

      if (hasDashboardIndicator) {
        if (bestState === STATES.UNINITIALIZED || bestState === STATES.ATAS_LOGIN) {
          bestState = STATES.ATAS_DASHBOARD;
          targetPage = p;
        }
      } else if (hasUid || hasLandingBtn || url.includes(urls.login)) {
        if (bestState === STATES.UNINITIALIZED) {
          bestState = STATES.ATAS_LOGIN;
          targetPage = p;
        }
      }
    } catch (e) {}
  }
  return { state: bestState, page: targetPage };
}

async function launchAccount(acctConfig) {
  const { chrome, useProxy, proxy, credentials } = acctConfig;
  const urls = acctConfig.urls || URLS;
  const selectors = acctConfig.selectors || SELECTORS;
  const timeouts = acctConfig.timeouts || TIMEOUTS;
  const logger = { log: (msg) => console.log(`[${acctConfig.label}] ${msg}`), warn: (msg) => console.warn(`[${acctConfig.label}] ${msg}`), error: (msg) => console.error(`[${acctConfig.label}] ${msg}`) };

  const prefix = acctConfig.modulePrefix || "BET";
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
  if (acctConfig.launchMethod === "puppeteer") {
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
    let { state: currentState, page } = await evaluateState(browser, urls, selectors);
    
    if (!page) { 
        page = await browser.newPage(); 
        currentState = STATES.UNINITIALIZED; 
    }
    
    logger.log(`Initial state detected: ${currentState}`);
    
    try {
      let safetyCounter = 0;
      while (currentState !== STATES.IN_GAME && safetyCounter < 15) {
        safetyCounter++;
        logger.log(`[State Machine] Executing state: ${currentState}`);
        
        if (currentState === STATES.UNINITIALIZED) {
          logger.log(`Navigating to ATAS login page: ${urls.login}`);
          await page.goto(urls.login, { waitUntil: "networkidle2", timeout: timeouts.navigationWait }).catch(() => {});
          await sleep(1500);
        } else if (currentState === STATES.ATAS_LOGIN) {
          logger.log("Handling ATAS_LOGIN...");
          
          const allFrames = await getAllFramesOfPage(page);
          let loginFrame = page;
          let uidInput = null;
          for (const frame of allFrames) {
            uidInput = await frame.$(selectors.uid).catch(() => null);
            if (uidInput) {
              loginFrame = frame;
              break;
            }
          }
          
          if (!uidInput) {
            logger.log("UID input not visible immediately. Checking for click-to-login landing buttons...");
            let clicked = false;
            for (const frame of allFrames) {
              const elements = await frame.$$('span, div, button, a').catch(() => []);
              for (const el of elements) {
                try {
                  const text = await frame.evaluate(node => node.textContent.trim(), el);
                  if (/^(log\s*in|login)$/i.test(text)) {
                    const rect = await frame.evaluate(node => {
                      const r = node.getBoundingClientRect();
                      return r.width > 0 && r.height > 0;
                    }, el).catch(() => false);
                    if (rect) {
                      logger.log(`Found clickable element with text "${text}". Clicking...`);
                      await el.click().catch(() => {});
                      await sleep(2000);
                      clicked = true;
                      break;
                    }
                  }
                } catch(e) {}
              }
              if (clicked) break;
            }
            
            // Re-check for uid input after clicking
            for (const frame of allFrames) {
              uidInput = await frame.$(selectors.uid).catch(() => null);
              if (uidInput) {
                loginFrame = frame;
                break;
              }
            }
          }
          
          if (!uidInput) {
            logger.warn("UID input still not found. Attempting to proceed with page frame...");
          }
          
          await loginFrame.waitForSelector(selectors.uid, { timeout: timeouts.selectorWait }).catch(() => {});
          await loginFrame.$eval(selectors.uid, el => el.value = "").catch(() => {});
          await loginFrame.type(selectors.uid, credentials.email || "", { delay: 10 });
          await loginFrame.$eval(selectors.password, el => el.value = "").catch(() => {});
          await loginFrame.type(selectors.password, credentials.password || "", { delay: 10 });
          await sleep(500);
          
          // Check for Turnstile captcha widget
          const turnstile = await loginFrame.$('.cf-turnstile').catch(() => null);
          if (turnstile) {
            logger.log("Cloudflare Turnstile CAPTCHA detected. Giving 3s window...");
            await sleep(3000);
          }

          const loginBtn = await loginFrame.$(selectors.loginButton);
          if (loginBtn) {
            await loginBtn.click();
          } else {
            // fallback: press Enter
            await page.keyboard.press("Enter");
          }
          
          logger.log("Login submitted. Waiting for dashboard...");
          writeLoginTimestamp(acctConfig.label);
          await sleep(timeouts.dashboardWait);
        } else if (currentState === STATES.ATAS_DASHBOARD) {
          logger.log("Handling ATAS_DASHBOARD...");
          
          const allFrames = await getAllFramesOfPage(page);
          // Dismiss guide overlays if visible
          let dismissedGuide = false;
          for (const frame of allFrames) {
            try {
              const guideOverlay = await frame.$('.guide-tip__overlay, .guide-tip').catch(() => null);
              if (guideOverlay) {
                logger.log("Found guide overlay. Clicking to dismiss...");
                await guideOverlay.click().catch(() => {});
                await sleep(1500);
                dismissedGuide = true;
                break;
              }
            } catch(e) {}
          }
          if (dismissedGuide) continue;

          // Dismiss popup ads if any
          let dismissedPopup = false;
          for (const frame of allFrames) {
            try {
              const closeBtn = await frame.$(selectors.dashboardPopupCloseButton).catch(() => null);
              if (closeBtn) {
                const isVisible = await frame.evaluate(el => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                }, closeBtn).catch(() => false);
                if (isVisible) {
                  logger.log("Dismissing dashboard popup ad...");
                  await closeBtn.click().catch(() => {});
                  await sleep(1500);
                  dismissedPopup = true;
                  break;
                }
              }
            } catch (e) {}
          }
          if (dismissedPopup) continue;

          // Look for Hotroad game provider card
          let hotroadItem = null;
          let hotroadItemFrame = page;
          let hotroadImg = null;
          for (const frame of allFrames) {
            const items = await frame.$$('.gameItem').catch(() => []);
            for (const item of items) {
              const img = await item.$('img[src*="ROAD"]').catch(() => null);
              if (img) {
                hotroadItem = item;
                hotroadItemFrame = frame;
                hotroadImg = img;
                break;
              }
            }
            if (hotroadItem) break;
          }

          if (!hotroadItem) {
            // Find and click the Live Casino tab (text content matches "Live")
            let liveTab = null;
            let liveTabFrame = page;
            for (const frame of allFrames) {
              const items = await frame.$$('.item').catch(() => []);
              for (const item of items) {
                const txt = await frame.evaluate(el => el.textContent.trim(), item);
                if (txt === 'Live') {
                  liveTab = item;
                  liveTabFrame = frame;
                  break;
                }
              }
              if (liveTab) break;
            }

            if (liveTab) {
              logger.log("Hotroad card not visible yet. Clicking Live Casino section...");
              await liveTab.click();
              await sleep(4000);
            } else {
              logger.warn("Live Casino tab / link not found on dashboard. Waiting...");
              await sleep(3000);
            }
          } else {
            logger.log("Found Hotroad game card. Clicking...");
            await hotroadItemFrame.evaluate(el => el.click(), hotroadImg);
            await sleep(4000);
          }
        } else if (currentState === STATES.ATAS_DIALOG) {
          logger.log("Handling ATAS_DIALOG (game pop-up)...");
          
          const allFrames = await getAllFramesOfPage(page);
          // Switch to Wallet tab to make sure Start Game is enabled
          for (const frame of allFrames) {
            try {
              const dialogs = await frame.$$('.game-pop__dialog').catch(() => []);
              for (const dialog of dialogs) {
                const isVisible = await frame.evaluate(el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                }, dialog).catch(() => false);

                if (isVisible) {
                  const walletTab = await frame.evaluateHandle((dialogEl) => {
                    const tabs = Array.from(dialogEl.querySelectorAll('div, span, p'));
                    return tabs.find(el => el.innerText && el.innerText.trim() === 'Wallet');
                  }, dialog).catch(() => null);

                  if (walletTab && walletTab.asElement()) {
                    logger.log("Found 'Wallet' tab in dialog. Clicking to switch to cash wallet...");
                    await frame.evaluate(el => el.click(), walletTab).catch(() => {});
                    await sleep(2000);
                  }
                }
              }
            } catch(e) {}
          }

          // Now find the Start Game button in the visible dialog
          let startBtn = null;
          let startBtnFrame = page;
          let quitBtn = null;
          let quitBtnFrame = page;

          for (const frame of allFrames) {
            try {
              const dialogs = await frame.$$('.game-pop__dialog').catch(() => []);
              for (const dialog of dialogs) {
                const isVisible = await frame.evaluate(el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                }, dialog).catch(() => false);
                
                if (isVisible) {
                  const buttons = await dialog.$$('button').catch(() => []);
                  for (const btn of buttons) {
                    const txt = await frame.evaluate(el => el.textContent.trim(), btn);
                    if (txt.includes('Start Game')) {
                      startBtn = btn;
                      startBtnFrame = frame;
                    } else if (txt.includes('Quit Game')) {
                      quitBtn = btn;
                      quitBtnFrame = frame;
                    }
                  }
                }
                if (startBtn || quitBtn) break;
              }
            } catch(e) {}
            if (startBtn || quitBtn) break;
          }

          if (startBtn) {
            logger.log("Found 'Start Game' button. Clicking...");
            // Click opens a new page context/tab, prepare target hook
            const newTargetPromise = browser.waitForTarget((t) => t.opener() === page.target(), { timeout: timeouts.tabWait }).catch(() => null);
            await startBtnFrame.evaluate(el => el.click(), startBtn).catch(() => {});
            
            const newTarget = await newTargetPromise;
            if (newTarget) {
              logger.log("Game target loaded successfully in new tab.");
              page = await newTarget.page();
              await sleep(4000);
            }
          } else if (quitBtn) {
            logger.log("Found 'Quit Game' button. Clicking to exit previous session...");
            await quitBtnFrame.evaluate(el => el.click(), quitBtn).catch(() => {});
            await sleep(4000);
          } else {
            logger.warn("Could not find 'Start Game' or 'Quit Game' button in pop-up dialog.");
            await sleep(3000);
          }
        }
        
        await sleep(2000);
        let nextStateResult = await evaluateState(browser, urls, selectors);
        currentState = nextStateResult.state;
        if (nextStateResult.page && page !== nextStateResult.page) {
          page = nextStateResult.page;
        }
      }
      
      if (currentState === STATES.IN_GAME) {
        logger.log("SUCCESS: Reached Baccarat game / Evolution lobby!");
        
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

module.exports = { launchAccount, buildAccountConfig, checkPageErrors, getLoginTimestamp, writeLoginTimestamp, clearLoginTimestamp };
