'use strict';

const deviceManager = require('../services/adamDeviceManager');
const legacyAdam    = deviceManager.getLegacyDevice();
const logger        = require('../utils/logger');

// Every endpoint accepts an optional ?device=<code> query param that selects
// one of the devices configured on the ADAM Config screen. Omit it to fall
// back to the single legacy env-configured device (backward compatible).
function _resolveDevice(req) {
  const code = req.query.device;
  if (!code) return { device: legacyAdam, deviceCode: null };

  const entry = deviceManager.getDevice(code);
  if (!entry) {
    throw Object.assign(
      new Error(`No ADAM device configured with code "${code}"`),
      { status: 404, code: 'ADAM_DEVICE_NOT_FOUND' }
    );
  }
  return { device: entry.device, deviceCode: code };
}

// ── GET /api/adam/devices ──────────────────────────────────────────────────────
// Lists the device codes currently connected/configured, for the dashboard's
// device selector dropdown.
function listDevices(req, res) {
  res.json({ success: true, data: deviceManager.listDeviceCodes() });
}

// ── GET /api/adam/status ──────────────────────────────────────────────────────
// Returns polling cache (no Modbus round-trip).
function getStatus(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    res.json(device.getStatus());
  } catch (err) { next(err); }
}

// ── GET /api/adam/check ───────────────────────────────────────────────────────
// Network diagnostics: ping + TCP port probe.
async function checkConnection(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    res.json(await device.checkConnection());
  } catch (err) {
    logger.error('[ADAM ctrl] checkConnection:', err.message);
    next(err);
  }
}

// ── GET /api/adam/connection ──────────────────────────────────────────────────
// Runtime connection state (lightweight, sync).
function getConnection(req, res, next) {
  try {
    const { device, deviceCode } = _resolveDevice(req);
    res.json({
      connected:         device.isConnected,
      reconnectAttempts: device.reconnectAttempts,
      lastError:         device.lastError,
      ip:                device.ip,
      port:              device.port,
      unitId:            device.unitId,
      protocol:          'Modbus TCP',
      deviceCode,
    });
  } catch (err) { next(err); }
}

// ── GET /api/adam/input ───────────────────────────────────────────────────────
// Live FC02 read — 12 DI channels.
async function readInput(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    res.json(await device.readInputs());
  } catch (err) {
    logger.error('[ADAM ctrl] readInput:', err.message);
    next(err);
  }
}

// ── GET /api/adam/output ──────────────────────────────────────────────────────
// Live FC01 read — 8 DO channels.
async function readOutput(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    res.json(await device.readOutputs());
  } catch (err) {
    logger.error('[ADAM ctrl] readOutput:', err.message);
    next(err);
  }
}

// ── POST /api/adam/output ─────────────────────────────────────────────────────
// Write DO. Body options:
//   { channel: 0, state: true }   → FC05 single coil
//   { value: 255 }                → FC15 all coils (bitmask 0–255)
async function writeOutput(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    const { channel, state, value } = req.body;

    if (value !== undefined) {
      const mask = parseInt(value, 10);
      if (isNaN(mask) || mask < 0 || mask > 255) {
        return res.status(400).json({ error: 'value must be an integer 0–255' });
      }
      return res.json(await device.writeAllOutputs(mask));
    }

    if (channel !== undefined) {
      const ch = parseInt(channel, 10);
      if (isNaN(ch) || ch < 0 || ch > 7) {
        return res.status(400).json({ error: 'channel must be 0–7' });
      }
      return res.json(await device.writeSingleOutput(ch, Boolean(state)));
    }

    res.status(400).json({ error: 'Provide { channel, state } or { value }' });
  } catch (err) {
    logger.error('[ADAM ctrl] writeOutput:', err.message);
    next(err);
  }
}

// ── POST /api/adam/output/:channel/on ─────────────────────────────────────────
async function channelOn(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    const ch = parseInt(req.params.channel, 10);
    if (isNaN(ch) || ch < 0 || ch > 7) {
      return res.status(400).json({ error: 'Channel must be 0–7' });
    }
    res.json(await device.writeSingleOutput(ch, true));
  } catch (err) {
    logger.error('[ADAM ctrl] channelOn:', err.message);
    next(err);
  }
}

// ── POST /api/adam/output/:channel/off ────────────────────────────────────────
async function channelOff(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    const ch = parseInt(req.params.channel, 10);
    if (isNaN(ch) || ch < 0 || ch > 7) {
      return res.status(400).json({ error: 'Channel must be 0–7' });
    }
    res.json(await device.writeSingleOutput(ch, false));
  } catch (err) {
    logger.error('[ADAM ctrl] channelOff:', err.message);
    next(err);
  }
}

// ── POST /api/adam/output/all ─────────────────────────────────────────────────
// Body: { value: 255 } or { hex: "FF" }
async function setAll(req, res, next) {
  try {
    const { device } = _resolveDevice(req);
    const { value, hex } = req.body;
    let mask;

    if (hex !== undefined) {
      if (!/^[0-9A-Fa-f]{1,2}$/.test(String(hex))) {
        return res.status(400).json({ error: 'hex must be 1–2 hex digits' });
      }
      mask = parseInt(String(hex), 16);
    } else if (value !== undefined) {
      mask = parseInt(value, 10);
      if (isNaN(mask) || mask < 0 || mask > 255) {
        return res.status(400).json({ error: 'value must be 0–255' });
      }
    } else {
      return res.status(400).json({ error: 'Provide { value } or { hex }' });
    }

    res.json(await device.writeAllOutputs(mask));
  } catch (err) {
    logger.error('[ADAM ctrl] setAll:', err.message);
    next(err);
  }
}

module.exports = {
  listDevices,
  getStatus,
  checkConnection,
  getConnection,
  readInput,
  readOutput,
  writeOutput,
  channelOn,
  channelOff,
  setAll,
};
