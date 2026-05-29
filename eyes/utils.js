/**
 * utils.js — Shared mapping utilities for PG Eyes
 */

function mapServerCodeToWinner(code) {
  if (!code) return null;
  const c = code.toLowerCase();
  if (c.startsWith('p')) return 'P';
  if (c.startsWith('b')) return 'B';
  if (c.startsWith('t')) return 'T';
  return null;
}

module.exports = { mapServerCodeToWinner };
