/**
 * check_page_interval.js - General utility to consistently check a Puppeteer page for system overlays,
 * session timeouts, and generic modal errors, and automatically dismiss/resolve them or reload the page.
 */

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          "login expired"
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

/**
 * Periodically checks the page for common error overlays and system dialogs,
 * automatically clicking confirm/dismiss buttons or reloading the page.
 * 
 * @param {import('puppeteer').Page} page
 * @param {Object} logger
 * @param {Object} options
 * @param {number} options.intervalMs - Check interval (default: 5000ms)
 * @returns {NodeJS.Timeout} The interval ID so the caller can clear it if needed.
 */
function startPageCheckInterval(page, logger = console, options = {}) {
  const intervalMs = options.intervalMs || 5000;

  const checkInterval = setInterval(async () => {
    if (page.isClosed && page.isClosed()) {
      clearInterval(checkInterval);
      return;
    }

    try {
      const errorState = await page.evaluate(() => {
        const selectors = [
          ".el-message-box",
          ".swal2-container",
          ".swal-modal",
          ".modal-dialog",
          ".dialog-container",
          ".popup-box"
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
            "login expired"
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
        logger.warn(`[PageCheck] Error overlay detected: "${errorState.text}". Dismissed: ${errorState.clicked}`);
        
        await sleep(1500);
        await page.reload({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
        logger.log("[PageCheck] Page reloaded successfully after error detection.");
      }

    } catch (err) {
      if (err.message && (err.message.includes("Target closed") || err.message.includes("Session closed") || err.message.includes("detached Frame"))) {
        clearInterval(checkInterval);
      }
    }
  }, intervalMs);

  return checkInterval;
}

module.exports = {
  checkPageErrors,
  startPageCheckInterval
};
