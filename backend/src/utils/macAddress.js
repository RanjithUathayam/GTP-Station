'use strict';

const { exec } = require('child_process');

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** Validates and normalizes a MAC address to uppercase colon-separated form (AA:BB:CC:DD:EE:FF). */
function normalizeMac(mac) {
  const trimmed = String(mac || '').trim();
  if (!MAC_RE.test(trimmed)) {
    throw Object.assign(new Error(`Invalid MAC address: "${mac}"`), { status: 400, code: 'INVALID_MAC' });
  }
  return trimmed.replace(/-/g, ':').toUpperCase();
}

function _ping(ip, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `ping -n 1 -w ${timeoutMs} ${ip}`
      : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${ip}`;
    exec(cmd, { timeout: timeoutMs + 1000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(isWin ? /TTL=/i.test(stdout) : /time=/i.test(stdout));
    });
  });
}

function _arp(ip, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? `arp -a ${ip}` : `arp -n ${ip}`;
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      // Windows:  10.0.210.87    aa-bb-cc-dd-ee-ff    dynamic
      // Linux:    10.0.210.87 ether aa:bb:cc:dd:ee:ff C eth0
      const match = stdout.match(/([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/);
      resolve(match ? match[0] : null);
    });
  });
}

/**
 * Resolves the MAC address currently associated with `ip` via the OS ARP table.
 * Pings first to make sure the ARP cache is populated, then reads it.
 * Returns null if the device did not respond or has no ARP entry.
 */
async function getMacForIp(ip, timeoutMs = 3000) {
  await _ping(ip, timeoutMs);
  const raw = await _arp(ip, timeoutMs);
  if (!raw) return null;
  try {
    return normalizeMac(raw);
  } catch (_) {
    return null;
  }
}

module.exports = { normalizeMac, getMacForIp };
