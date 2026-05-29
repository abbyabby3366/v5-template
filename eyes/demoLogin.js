/**
 * demoLogin.js - Reusable utility to handle logging into Demo / restoring active lobby session.
 */

const { checkPageErrors } = require("../utils/check_page_interval");

/**
 * Opens a new browser page, navigates to the Demo multiplay lobby, and checks for errors.
 * This effectively logs in/restores the session since cookies are persisted in the profile.
 * @param {object} browserContext
 * @returns {Promise<object>} The fully loaded and validated Demo page instance
 */
async function loginToDemo(browserContext) {
  if (!browserContext) throw new Error("browserContext is required to login to Demo");
  const newPage = await browserContext.newPage();
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
