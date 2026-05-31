/**
 * demoLogin.js - Reusable utility to handle logging into Demo / restoring active lobby session.
 */

const { checkPageErrors } = require("../utils/check_page_interval");

/**
 * Opens a new browser page, navigates to the Demo multiplay lobby, and checks for errors.
 * This effectively logs in/restores the session since cookies are persisted in the profile.
 * @param {object} browserContext
 * @param {object} [proxy]
 * @returns {Promise<object>} The fully loaded and validated Demo page instance
 */
async function loginToDemo(browserContext, proxy = null) {
  if (!browserContext) throw new Error("browserContext is required to login to Demo");
  const newPage = await browserContext.newPage();

  if (proxy && proxy.server && proxy.username && proxy.password) {
    console.log("[Demo Login] Applying proxy authentication to new demo session page...");
    await newPage.authenticate({
      username: proxy.username,
      password: proxy.password
    }).catch((e) => console.warn(`[Demo Login] Proxy authentication failed: ${e.message}`));
  }

  // --- VERIFY EXTERNAL PROXY IP ---
  if (proxy && proxy.server) {
    console.log("[Demo Login] 🌐 Verifying external IP address and routing via proxy...");
    let tempPage = null;
    let ipVerified = false;
    let verificationError = null;

    try {
      tempPage = await browserContext.newPage();
      if (proxy.username && proxy.password) {
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
            console.log(`\n🎉 [Demo Login] PROXY CONNECTED! Current Public IP: \x1b[36m${ip}\x1b[0m (via ${new URL(server.url).hostname})\n`);
            ipVerified = true;
            break;
          }
        } catch (err) {
          console.warn(`⚠️ [Demo Login] Reflection server ${server.url} failed: ${err.message}. Trying fallback...`);
        }
      }
    } catch (err) {
      console.warn(`⚠️ [Demo Login] Warning: Error setting up IP verification page: ${err.message}`);
      verificationError = err;
    } finally {
      if (tempPage) {
        await tempPage.close().catch(() => {});
      }
    }

    if (!ipVerified) {
      const errorMsg = `Proxy Leak Prevention: Failed to verify external IP across all fallback reflection servers. Halting browser session restart.`;
      console.error(`❌ [Demo Login] ${errorMsg}`);
      
      try {
        const { sendWhatsAppNotification } = require("../utils/whatsapp_notifier");
        await sendWhatsAppNotification(`[PROXY FAILURE] Demo Login session failed to verify its secure proxy route during restart. Browser swap halted for security. Reason: ${verificationError ? verificationError.message : 'All reflection servers failed'}`).catch(() => {});
      } catch (e) {}

      // Close the newPage we just opened to prevent leak or zombie tabs
      if (newPage && !newPage.isClosed()) {
        await newPage.close().catch(() => {});
      }
      throw new Error(errorMsg);
    }
  }

  await newPage.goto("https://d3jai9eacl1740.cloudfront.net/lobby/multiplay", { 
    waitUntil: "networkidle2", 
    timeout: 30000 
  }).catch(() => {});
  
  await checkPageErrors(newPage, { log: console.log, warn: console.warn, error: console.error });
  return newPage;
}

module.exports = {
  loginToDemo,
};
