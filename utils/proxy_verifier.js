const { sendWhatsAppNotification } = require("./whatsapp_notifier");

/**
 * Verifies the external proxy IP routing. If it fails, alerts via WhatsApp and cleans up browser resources.
 * @param {object} params
 * @param {import('puppeteer').Browser} params.browser - The active browser context
 * @param {object} params.proxy - The proxy configuration object (server, username, password, etc.)
 * @param {string} params.label - Account or session label (e.g. "PG Eyes Winbox")
 * @param {object} [params.logger] - Custom logger (defaults to console)
 * @param {boolean} [params.closeBrowserOnFailure] - Whether to close the entire browser instance on failure
 * @returns {Promise<string>} The verified IP address
 */
async function verifyProxyIp({ browser, proxy, label, logger = console, closeBrowserOnFailure = false }) {
  logger.log("🌐 Verifying external IP address and routing via proxy...");
  let tempPage = null;
  let ipVerified = false;
  let verificationError = null;
  let verifiedIp = "";

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
      logger.log("[Proxy Verifier] Closing verification page with timeout safeguard...");
      await Promise.race([
        tempPage.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("page.close() timeout")), 3000))
      ]).catch((e) => logger.warn(`Page close warning: ${e.message}`));
    }
  }

  if (!ipVerified) {
    const errorMsg = `Proxy Leak Prevention: Failed to verify external IP across all fallback reflection servers. Halting browser launch.`;
    logger.error(`❌ ${errorMsg}`);
    
    try {
      logger.log(`[Proxy Verifier] Sending WhatsApp notification for secure proxy halt...`);
      const waMsg = `[PROXY FAILURE] ${label} failed to verify its secure proxy route at launch. Browser connection halted for security. Reason: ${verificationError ? verificationError.message : 'All reflection servers failed'}`;
      const waResult = await sendWhatsAppNotification(waMsg);
      logger.log(`[Proxy Verifier] WhatsApp API response:`, JSON.stringify(waResult));
    } catch (e) {
      logger.error(`[Proxy Verifier] Failed to trigger WhatsApp notification: ${e.message}`);
    }

    if (closeBrowserOnFailure && browser) {
      logger.log("[Proxy Verifier] Closing browser with timeout safeguard...");
      await Promise.race([
        browser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close() timeout")), 4000))
      ]).catch((e) => logger.warn(`Browser close warning: ${e.message}`));
    }

    throw new Error(errorMsg);
  }

  return verifiedIp;
}

module.exports = {
  verifyProxyIp
};
