/**
 * network_watchdog.js - Previously monitored network connectivity via in-browser fetch pings.
 * Disabled: Network connectivity checks removed per user request.
 * Kept as a no-op stub so existing callers don't break.
 */

function startNetworkWatchdog(page, logger = console, options = {}) {
  // No-op: network connectivity monitoring disabled
  return null;
}

module.exports = {
  startNetworkWatchdog
};
