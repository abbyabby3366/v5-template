/**
 * launch_a9.js — Launch Chrome and navigate to Onbet Baccarat via A9 Play.
 * Patterned after launch_on.js from C:\Users\desmo\Desktop\onbet_v4.
 */

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const { getBrowserArgs } = require("./browserArgs");

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

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

const SELECTORS = {
  uid: 'input[name="userid"]',
  password: 'input[name="userpwd"]',
  loginButton: 'button#login',
  dashboardIndicator: 'a.topnav__info-checkin',
  liveCasinoLink: '#mheader-casino a',
  oncasinoPlayButton: 'a[data-vendor="ONCASINO"]',
  swalConfirmButton: 'button.swal2-confirm',
  turnstileWidget: '.cf-turnstile',
  dashboardPopupCloseButton: '.js-popup-close-btn',
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
  login: "https://h5.a9play3.com/en-us/main",
  betLobby: ["yctkrs.com", "tlbdyyfwpt.com", "h5V01/pc", "ongames.info", "sw.ongames.info", "/play/oncasino", "/play/"], // ON game URL domains or paths
};

async function waitForCanvas(page, timeoutMs = 30000, logger = console) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const count = await frame.evaluate(() => document.querySelectorAll("canvas").length).catch(() => 0);
        if (count > 0) { logger.log("Canvas detected and ready."); return true; }
      } catch (e) {}
    }
    process.stdout.write(`  Waiting for canvas... (${Math.round((Date.now() - startTime) / 1000)}s)\r`);
    await sleep(2000);
  }
  logger.warn("Canvas not found within timeout — proceeding anyway.");
  return false;
}

function buildAccountConfig(accountIndex, accountsFilePath) {
  const accountsFile = accountsFilePath || path.resolve(__dirname, "..", "bet_module", "json", "bet_accounts.json");
  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(accountsFile, "utf8")); } 
  catch (err) { throw new Error(`Failed to read accounts file at ${accountsFile}: ${err.message}`); }

  const account = accounts[accountIndex];
  if (!account) throw new Error(`Account index ${accountIndex} not found. File has ${accounts.length} entries.`);

  const platform = account.platform || "on";
  const baseProfileIndex = 9;
  const basePort = 9222;
  const profileIndex = account.profileIndex ?? baseProfileIndex + accountIndex;
  const port = account.debuggingPort ?? basePort + accountIndex;
  
  const rawProxy = account.proxy || {};
  const useProxy = !!account.useProxy;

  return {
    accountIndex,
    label: account.label || `Account ${accountIndex}`,
    platform,
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
    urls: URLS,
    selectors: SELECTORS,
    timeouts: TIMEOUTS,
    sourceFile: accountsFile,
  };
}

async function launchAccount(acctConfig) {
  const { chrome, useProxy, proxy, credentials, urls, selectors, timeouts } = acctConfig;
  const labelPrefix = acctConfig.label || "Account";
  const logger = {
    label: labelPrefix,
    log: (msg) => console.log(`[${labelPrefix}] ${msg}`),
    warn: (msg) => console.warn(`[${labelPrefix}] ${msg}`),
    error: (msg) => console.error(`[${labelPrefix}] ${msg}`),
  };
  let verifiedIp = "Direct / No Proxy";

  // --- EMBEDDED TAILSCALE PROXY HANDLING ---
  let tscProxy = null;
  if (proxy && proxy.type === "tailscale") {
    logger.log("Initializing embedded Tailscale node...");
    try {
      const { TSCProxy } = require("@tailscale/tscproxy");
      const port = proxy.port || 1055;
      const hostname = proxy.hostname || `puppeteer-${labelPrefix.replace(/\s+/g, '-').toLowerCase()}`;
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

  async function applyProxyAuth(p) {
    if (proxy && proxy.server && proxy.username && proxy.password) {
      logger.log("Refreshing proxy authentication...");
      await p.authenticate({ username: proxy.username, password: proxy.password }).catch((e) => logger.warn(`Proxy auth failed: ${e.message}`));
    }
  }

  let browser;
  try {
    logger.log(`Checking if Chrome is already running on port ${chrome.remoteDebuggingPort}...`);
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${chrome.remoteDebuggingPort}`,
      defaultViewport: null,
      protocolTimeout: 30000,
    });
    logger.log("Connected to existing Chrome instance.");
  } catch (e) {
    logger.log("Chrome not found on debugging port. Spawning new instance...");
    await killZombieChromeOnPort(chrome.remoteDebuggingPort, logger);
    await sleep(500);

    const chromeArgs = [
      `--remote-debugging-port=${chrome.remoteDebuggingPort}`,
      `--user-data-dir=${chrome.userDataDir}`,
      "--no-first-run", "--no-default-browser-check", "--mute-audio",
      `--window-size=${process.env.BET_WINDOW_SIZE || process.env.CHROME_WINDOW_SIZE || "900,1400"}`,
      `--window-position=${process.env.BET_WINDOW_POSITION || process.env.CHROME_WINDOW_POSITION || "100,50"}`,
      "--force-device-scale-factor=1", "--high-dpi-support=1",
      ...(chrome.extraArgs || []),
    ];
    if (formattedProxy) {
      chromeArgs.push(`--proxy-server=${formattedProxy}`);
    }

    const chromeProcess = spawn(chrome.executablePath, chromeArgs, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    const chromePid = chromeProcess.pid;
    let chromeStderr = "";
    if (chromeProcess.stderr) {
      chromeProcess.stderr.on("data", (chunk) => { if (chromeStderr.length < 2048) chromeStderr += chunk.toString(); });
    }
    chromeProcess.unref();
    logger.log(`Waiting for Chrome to initialize (PID: ${chromePid})...`);

    let connected = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delayMs = Math.min(1000 + attempt * 1000, 10000);
      await sleep(delayMs);
      if (chromePid && !isProcessAlive(chromePid)) {
        throw new Error(`Chrome (PID ${chromePid}) died before accepting connections.`);
      }
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.remoteDebuggingPort}`, defaultViewport: null, protocolTimeout: 30000 });
        connected = true;
        logger.log(`Connected to Chrome on attempt ${attempt}/5.`);
        break;
      } catch (error) {
        logger.warn(`Connect attempt ${attempt}/5 failed. ${attempt < 5 ? "Retrying..." : ""}`);
      }
    }
    if (!connected) throw new Error("Failed to connect to Chrome after 5 attempts.");
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

    // 2. Authenticate newly created pages/tabs dynamically
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const p = await target.page();
          if (p) {
            await p.authenticate({ username: proxy.username, password: proxy.password })
              .catch((e) => logger.warn(`Proxy authentication failed on new page: ${e.message}`));
          }
        } catch (e) {
          // Ignore
        }
      }
    });
  }

  // --- VERIFY EXTERNAL PROXY IP ---
  if (useProxy) {
    logger.log("🌐 Verifying external IP address and routing via proxy...");
    let tempPage = null;
    let ipVerified = false;
    let verificationError = null;

    try {
      tempPage = await browser.newPage();
      if (proxy && proxy.username && proxy.password) {
        await tempPage.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
      }

      const reflectionServers = [
        { url: "https://httpbin.org/ip", key: "origin" },
        { url: "https://api.ipify.org?format=json", key: "ip" },
        { url: "https://ipinfo.io/json", key: "ip" }
      ];

      for (const server of reflectionServers) {
        try {
          await tempPage.goto(server.url, { waitUntil: "networkidle2", timeout: 10000 });
          const responseText = await tempPage.evaluate(() => document.body.innerText || document.body.textContent || "");
          const cleanedText = responseText.trim();
          
          let ip = "";
          try {
            const data = JSON.parse(cleanedText);
            ip = data[server.key] || data.ip || data.origin || "";
          } catch (e) {
            // Regex fallback if JSON parsing fails due to browser pre/code tags wrapping
            const match = responseText.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
            if (match) ip = match[0];
          }

          if (ip) {
            console.log(`\n🎉 PROXY CONNECTED! Current Public IP: \x1b[36m${ip}\x1b[0m (via ${new URL(server.url).hostname})\n`);
            ipVerified = true;
            verifiedIp = ip;
            break;
          }
        } catch (err) {
          logger.warn(`⚠️ Reflection server ${server.url} failed: ${err.message}. Trying fallback...`);
        }
      }
    } catch (err) {
      logger.warn(`⚠️ Warning: Error setting up IP verification page: ${err.message}`);
      verificationError = err;
    } finally {
      if (tempPage) {
        await tempPage.close().catch(() => {});
      }
    }

    if (!ipVerified) {
      const errorMsg = `Proxy Leak Prevention: Failed to verify external IP across all fallback reflection servers. Halting browser launch.`;
      logger.error(`❌ ${errorMsg}`);
      
      try {
        const { sendWhatsAppNotification } = require("./whatsapp_notifier");
        await sendWhatsAppNotification(`[PROXY FAILURE] ${acctConfig.label} failed to verify its secure proxy route at launch. Browser connection halted for security. Reason: ${verificationError ? verificationError.message : 'All reflection servers failed'}`).catch(() => {});
      } catch (e) {}

      // Clean up browser instance to prevent hanging zombie processes
      if (browser) {
        await browser.close().catch(() => {});
      }
      throw new Error(errorMsg);
    }
  }

  const STATES = { IN_GAME: "IN_GAME", A9_DASHBOARD: "A9_DASHBOARD", OTP_REQUIRED: "OTP_REQUIRED", A9_LOGIN: "A9_LOGIN", UNINITIALIZED: "UNINITIALIZED" };

  async function evaluateState(browser) {
    const pages = await browser.pages();
    const validPages = pages.filter((p) => {
      const url = p.url() || "";
      return !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
    });

    let bestState = STATES.UNINITIALIZED;
    let targetPage = validPages.length > 0 ? validPages[0] : null;
    let targetGameFrame = null;

    for (const p of validPages) {
      if (!p.__dialogHooked) {
        p.on('dialog', async (dialog) => { try { await dialog.accept(); } catch(e) {} });
        p.__dialogHooked = true;
      }
      try {
        const url = p.url() || "";
        logger.log(`[evaluateState] Checking page URL: ${url}`);

        // 1. Check if any frame (including embedded iframes) contains the game lobby URL
        let bestFrame = null;
        let bestScore = 0;
        const frameUrls = [];
        for (const frame of p.frames()) {
          try {
            const frameUrl = frame.url() || "";
            frameUrls.push(frameUrl);
            
            // Strong match: The actual Cocos baccarat game client iframe
            if (["yctkrs.com", "tlbdyyfwpt.com", "h5V01/pc", "ongames.info", "sw.ongames.info"].some(domain => frameUrl.includes(domain))) {
              bestFrame = frame;
              bestScore = 2;
              break; // Ideal match, stop searching
            }
            
            // Weak match: The platform's outer game container iframe
            if (["/play/oncasino", "/play/"].some(domain => frameUrl.includes(domain))) {
              if (bestScore < 1) {
                bestFrame = frame;
                bestScore = 1;
              }
            }
          } catch (e) {}
        }
        
        if (bestFrame) {
          logger.log(`[evaluateState] Found embedded game iframe: ${bestFrame.url()} (Score: ${bestScore})`);
          return { state: STATES.IN_GAME, page: p, gameFrame: bestFrame };
        }
        if (frameUrls.length > 1) {
          logger.log(`[evaluateState] Active frame URLs: ${JSON.stringify(frameUrls)}`);
        }

        // 2. Check for sweetalert overlays or message box
        let sessionBox = null;
        let boxText = "";
        for (const frame of p.frames()) {
          try {
            sessionBox = await frame.$(".swal2-container, .el-message-box").catch(() => null);
            if (sessionBox) {
              boxText = await frame.evaluate((el) => el.innerText, sessionBox).catch(() => "");
              break;
            }
          } catch (e) {}
        }

        if (sessionBox) {
          const lowerText = boxText.toLowerCase();
          if (
            lowerText.includes("session timeout") ||
            lowerText.includes("access denied") ||
            lowerText.includes("another device") ||
            lowerText.includes("logged out") ||
            lowerText.includes("kick out") ||
            lowerText.includes("please login")
          ) {
            logger.warn("Session timeout or disconnect overlay detected — dismissing and reloading...");
            let dismissed = false;
            const okBtn = await sessionBox.$("button.swal2-confirm, .el-message-box__btns button").catch(() => null);
            if (okBtn) {
              await okBtn.click().catch(() => {});
              await okBtn.dispose().catch(() => {});
              dismissed = true;
            }
            await sleep(1000);
            await p.reload({ waitUntil: "networkidle2", timeout: timeouts.navigationWait }).catch(() => {});
            await sleep(2000);
            continue;
          }
        }

        // 3. Determine if dashboard or login page
        let isDashboard = false, isLogin = false, isOtpModal = false;
        let hasInnerAppRoute = false;
        for (const frame of p.frames()) {
          try {
            const frameUrl = frame.url() || "";
            if (
              frameUrl.includes("/main") || 
              frameUrl.includes("/live-casino") || 
              frameUrl.includes("/user/account")
            ) {
              hasInnerAppRoute = true;
            }

            if (await frame.$('.EmailVerificationRoot').catch(() => null)) isOtpModal = true;
            if (await frame.$(selectors.dashboardIndicator).catch(() => null)) isDashboard = true;
            if (await frame.$(selectors.dashboardPopupCloseButton).catch(() => null)) isDashboard = true;
            if ((await frame.$(selectors.uid).catch(() => null)) || (await frame.$(selectors.loginButton).catch(() => null))) isLogin = true;
          } catch (e) {}
        }

        if (isOtpModal) {
          if (![STATES.IN_GAME, STATES.A9_DASHBOARD].includes(bestState)) {
            bestState = STATES.OTP_REQUIRED;
            targetPage = p;
          }
        } else if (isDashboard) {
          if ([STATES.UNINITIALIZED, STATES.A9_LOGIN, STATES.OTP_REQUIRED].includes(bestState)) {
            bestState = STATES.A9_DASHBOARD;
            targetPage = p;
          }
        } else if (isLogin) {
          if (bestState === STATES.UNINITIALIZED) {
            bestState = STATES.A9_LOGIN;
            targetPage = p;
          }
        } else if (
          hasInnerAppRoute || 
          url.includes("/main") || 
          url.includes("/live-casino") || 
          url.includes("/user/account")
        ) {
          // If login inputs are not in the DOM, and we are on these A9 routes, we are logged in!
          if ([STATES.UNINITIALIZED, STATES.A9_LOGIN].includes(bestState)) {
            bestState = STATES.A9_DASHBOARD;
            targetPage = p;
          }
        }
      } catch (e) {}
    }
    return { state: bestState, page: targetPage, gameFrame: targetGameFrame };
  }

  try {
    let mainLoopRetries = 0;
    while (mainLoopRetries < 3) {
      mainLoopRetries++;
      let { state: currentState, page, gameFrame } = await evaluateState(browser);
      if (!page) { page = await browser.newPage(); currentState = STATES.UNINITIALIZED; }
      await applyProxyAuth(page);
      logger.log(`Initial state detected: ${currentState}`);

      try {
        let safetyCounter = 0;
        while (currentState !== STATES.IN_GAME && safetyCounter < 10) {
          safetyCounter++;
          logger.log(`[State Machine] Executing state: ${currentState}`);

          if (currentState === STATES.UNINITIALIZED) {
            await applyProxyAuth(page);
            logger.log("Navigating to A9 Play main page...");
            try {
              await page.goto(urls.login, { waitUntil: "networkidle2", timeout: timeouts.navigationWait });
            } catch (e) {
              throw new Error(`Failed to navigate to login page: ${e.message}`);
            }
            await sleep(timeouts.settleWait);

          } else if (currentState === STATES.A9_LOGIN) {
            logger.log("Handling A9 login...");
            await applyProxyAuth(page);

            let loginFrame = page;
            for (const frame of page.frames()) {
              try { if (await frame.$(selectors.uid)) { loginFrame = frame; break; } } catch (e) {}
            }

            try { await loginFrame.waitForSelector(selectors.uid, { timeout: timeouts.selectorWait }); }
            catch (e) { throw new Error("Login form failed to load (userid selector not found)."); }

            await loginFrame.$eval(selectors.uid, (el) => (el.value = ""));
            await loginFrame.click(selectors.uid, { clickCount: 3 });
            await page.keyboard.press("Backspace");
            await loginFrame.type(selectors.uid, credentials.email, { delay: 10 });

            await loginFrame.$eval(selectors.password, (el) => (el.value = ""));
            await loginFrame.click(selectors.password, { clickCount: 3 });
            await page.keyboard.press("Backspace");
            await loginFrame.type(selectors.password, credentials.password, { delay: 10 });

            await sleep(500);

            // Turnstile CAPTCHA sleep support
            const turnstile = await loginFrame.$(selectors.turnstileWidget).catch(() => null);
            if (turnstile) {
              logger.log("Cloudflare Turnstile CAPTCHA detected. Giving 3s window...");
              await sleep(3000);
            }

            const submitBtn = await loginFrame.$(selectors.loginButton);
            if (submitBtn) {
              await submitBtn.click();
            } else {
              throw new Error("Sign In button not found.");
            }

            logger.log("Login submitted. Waiting for dashboard...");
            writeLoginTimestamp(labelPrefix);
            await sleep(timeouts.dashboardWait);

          } else if (currentState === STATES.OTP_REQUIRED) {
            logger.warn("OTP REQUIRED! Waiting up to 10 minutes for user to enter OTP...");
            const { sendWhatsAppNotification } = require("./whatsapp_notifier");
            sendWhatsAppNotification(`[OTP Required] ${labelPrefix} needs OTP. You have 10 minutes.`).catch(() => {});

            const otpStart = Date.now();
            let solved = false;
            while (Date.now() - otpStart < 10 * 60 * 1000) {
              let check = await evaluateState(browser);
              if ([STATES.A9_DASHBOARD, STATES.IN_GAME].includes(check.state)) { solved = true; break; }
              await sleep(5000);
              safetyCounter = 0;
            }
            if (!solved) throw new Error("OTP Timeout! User did not enter OTP within 10 minutes.");
            logger.log("OTP resolved. Proceeding...");
            const nextResult = await evaluateState(browser);
            currentState = nextResult.state;
            page = nextResult.page;
            gameFrame = nextResult.gameFrame;
            continue;

          } else if (currentState === STATES.A9_DASHBOARD) {
            logger.log("Handling A9_DASHBOARD...");

            // Resolve the active frame dynamically to handle iframe-based single-page wrapping
            let activeFrame = page;
            let currentUrl = page.url() || "";
            for (const frame of page.frames()) {
              try {
                // Strictly prioritize child iframe frames (which have .parent() as not null) over outer main page
                if (frame.parent()) {
                  const frameUrl = frame.url() || "";
                  if (frameUrl.includes("/main") || frameUrl.includes("/live-casino") || frameUrl.includes("/user/account")) {
                    activeFrame = frame;
                    currentUrl = frameUrl;
                    break;
                  }
                }
              } catch (e) {}
            }

            // Dismiss dashboard banner popups if visible
            let dismissedPopup = false;
            for (const frame of page.frames()) {
              try {
                const closeBtn = await frame.$(selectors.dashboardPopupCloseButton).catch(() => null);
                if (closeBtn) {
                  // Verify that the element is actually visible on screen (not hidden/faded out)
                  const isVisible = await frame.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                  }, closeBtn).catch(() => false);

                  if (isVisible) {
                    logger.log("Found visible dashboard ad popup. Clicking close button...");
                    await closeBtn.click().catch(() => {});
                    await sleep(2500); // Wait for transition animation
                    dismissedPopup = true;
                    break;
                  }
                }
              } catch (e) {}
            }
            if (dismissedPopup) continue;

            let messageBoxHandled = false;
            for (const frame of page.frames()) {
              try {
                const sessionBox = await frame.$(".swal2-container, .el-message-box").catch(() => null);
                if (sessionBox) {
                  const boxText = await frame.evaluate((el) => el.innerText, sessionBox).catch(() => "");
                  const lowerText = boxText.toLowerCase();
                  
                  logger.log(`Found SweetAlert / dialog overlay with text: "${boxText.trim()}"`);
                  const okBtn = await sessionBox.$("button.swal2-confirm, button.el-button--primary").catch(() => null) || await frame.$(".el-message-box__btns button");
                  
                  if (okBtn) {
                    logger.log("Auto-detect: Clicking OK on dialog overlay...");
                    await frame.evaluate(el => el.click(), okBtn).catch(() => {});
                  }

                  if (
                    lowerText.includes("session timeout") ||
                    lowerText.includes("access denied") ||
                    lowerText.includes("another device") ||
                    lowerText.includes("logged out") ||
                    lowerText.includes("kick out") ||
                    lowerText.includes("please login")
                  ) {
                    logger.warn("Session timeout/disconnect overlay detected. Reloading page...");
                    await sleep(1500);
                    await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
                    await sleep(4000);
                  } else {
                    logger.log("Waiting 8 seconds for game container iframe to load...");
                    await sleep(8000);
                  }
                  messageBoxHandled = true;
                  break;
                }
              } catch (e) {}
            }
            if (messageBoxHandled) continue;

            // Check if ONCASINO play button is already present inside frames
            let playBtn = null;
            let playBtnFrame = page;
            for (const frame of page.frames()) {
              try {
                playBtn = await frame.$(selectors.oncasinoPlayButton).catch(() => null);
                if (playBtn) {
                  playBtnFrame = frame;
                  break;
                }
              } catch (e) {}
            }

            if (!playBtn) {
              logger.log("ONLIVE play link not found. Navigating to Live Casino section...");
              
              // Search all frames for the Live Casino link (to support direct click inside frames)
              let casinoLink = null;
              let casinoLinkFrame = page;
              for (const frame of page.frames()) {
                try {
                  casinoLink = await frame.$(selectors.liveCasinoLink).catch(() => null);
                  if (casinoLink) {
                    casinoLinkFrame = frame;
                    break;
                  }
                } catch (e) {}
              }

              if (casinoLink) {
                logger.log("Found Live Casino link inside frame. Triggering DOM click...");
                await casinoLinkFrame.evaluate(el => {
                  el.click();
                  const parent = el.closest('#mheader-casino') || el.parentElement;
                  if (parent) parent.click();
                }, casinoLink).catch(() => {});
                await sleep(5000);
              } else {
                logger.warn("Live Casino link selector not found inside any frame!");
                await sleep(3000);
              }
            } else {
              logger.log("ONLIVE play link is visible. Triggering play click...");
              logger.log("Found ONCASINO play link inside frame. Triggering DOM click...");
              await playBtnFrame.evaluate(el => el.click(), playBtn).catch(() => {});
              await sleep(4000);

              // Auto-confirm SweetAlert2 modal if it appears
              let swalConfirm = null;
              let swalConfirmFrame = page;
              for (const frame of page.frames()) {
                try {
                  swalConfirm = await frame.$(selectors.swalConfirmButton).catch(() => null);
                  if (swalConfirm) {
                    swalConfirmFrame = frame;
                    break;
                  }
                } catch (e) {}
              }

              if (swalConfirm) {
                logger.log("SweetAlert confirmation visible. Triggering DOM click...");
                await swalConfirmFrame.evaluate(el => el.click(), swalConfirm).catch(() => {});
                logger.log("Waiting 8 seconds for game container iframe to load...");
                await sleep(8000);
              } else {
                await sleep(2000);
                // Check again inside frames
                for (const frame of page.frames()) {
                  try {
                    swalConfirm = await frame.$(selectors.swalConfirmButton).catch(() => null);
                    if (swalConfirm) {
                      swalConfirmFrame = frame;
                      break;
                    }
                  } catch (e) {}
                }
                if (swalConfirm) {
                  logger.log("SweetAlert confirmation visible (delayed). Triggering DOM click...");
                  await swalConfirmFrame.evaluate(el => el.click(), swalConfirm).catch(() => {});
                  logger.log("Waiting 8 seconds for game container iframe to load...");
                  await sleep(8000);
                }
              }
            }
          }

          await sleep(1000);
          const nextStateResult = await evaluateState(browser);
          currentState = nextStateResult.state;
          if (nextStateResult.page && page !== nextStateResult.page) {
            page = nextStateResult.page;
            await applyProxyAuth(page);
          }
          gameFrame = nextStateResult.gameFrame;
        }

        if (currentState === STATES.IN_GAME) {
          logger.log("SUCCESS: Reached the final Baccarat game page inside iframe.");
          logger.log("Ensuring canvas is loaded...");
          const hasCanvas = await waitForCanvas(page, 15000, logger);

          if (!hasCanvas) {
            if (mainLoopRetries >= 3) {
              logger.warn("Canvas never loaded after 3 attempts. Proceeding anyway!");
            } else {
              logger.warn("Canvas not loaded. Closing tab and retrying...");
              if (page && !page.isClosed()) await page.close().catch(() => {});
              continue;
            }
          }
          
          let evalContext = gameFrame || page;
          for (const frame of page.frames()) {
            try {
              const frameUrl = frame.url() || "";
              if (["yctkrs.com", "tlbdyyfwpt.com", "h5V01/pc", "ongames.info", "sw.ongames.info"].some(domain => frameUrl.includes(domain))) {
                logger.log(`[IN_GAME] Dynamically resolved innermost game iframe: ${frameUrl}`);
                evalContext = frame;
                break;
              }
            } catch (e) {}
          }

          // --- Fetch live table mapping for ON ---
          logger.log("Fetching live table mapping from ON inside game iframe...");
          const tableData = await evalContext.evaluate(() => {
            try {
              if (window.TableMgr && window.TableMgr.inst) {
                const inst = window.TableMgr.inst;
                const tables = inst.tableInfoList || inst._tables || (inst._tableMap ? Array.from(inst._tableMap.values()) : []);
                if (tables && tables.length > 0) {
                  const baccGameIds = [1, 7, 10, 13, 101];
                  const baccTables = tables.filter(t => baccGameIds.includes(t.gameId));
                  if (baccTables.length > 0) {
                     return baccTables.map((t, idx) => ({
                       key: t.tableNo || String(t.tableId),
                       index: idx
                     }));
                  }
                }
              }
            } catch (e) {}
            return null;
          });

          let mapping = null;
          if (tableData && tableData.length > 0) {
              mapping = {};
              tableData.forEach((item) => {
                if (item && item.key) {
                  mapping[item.key] = item.index;
                }
              });
              logger.log(`📋 Live table mapping: ${tableData.length} tables → ${JSON.stringify(Object.keys(mapping).slice(0, 10))}...`);
              
              try {
                const liveJsonPath = path.resolve(__dirname, "..", "bet_module", "json", "live_table_mapping.json");
                const mappingStr = JSON.stringify(mapping, null, 2);
                require("fs").writeFileSync(liveJsonPath, mappingStr, "utf8");
                logger.log(`✅ Saved live table mapping to JSON file.`);
              } catch (err) {
                logger.warn(`Failed to save table mapping to JSON: ${err.message}`);
              }
          } else {
              logger.warn("Could not fetch table mapping from game iframe. Falling back to static mapping.");
          }

          return { browser, page, gameFrame: evalContext, lastLoginTime: getLoginTimestamp(labelPrefix), tableMapping: mapping, ip: verifiedIp };
        } else {
          throw new Error(`State machine stuck. Last state: ${currentState}`);
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
    throw new Error("Failed to fully load canvas after multiple retries.");
  } catch (error) {
    logger.error(`[FAILURE] ${error.message}`);
    throw error;
  }
}

module.exports = { launchAccount, buildAccountConfig, getLoginTimestamp, writeLoginTimestamp, clearLoginTimestamp };
