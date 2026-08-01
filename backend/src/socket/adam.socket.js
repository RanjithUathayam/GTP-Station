'use strict';

const deviceManager = require('../services/adamDeviceManager');
const adam          = deviceManager.getLegacyDevice();
const logger        = require('../utils/logger');

function _statusFor(deviceCode) {
  if (!deviceCode) return { deviceCode: null, ...adam.getStatus() };
  const entry = deviceManager.getDevice(deviceCode);
  return entry ? { deviceCode, ...entry.device.getStatus() } : { deviceCode, connected: false, error: 'Device not configured' };
}

function init(io) {
  const adamNs = io.of('/adam');

  // Forward every service event to all connected Socket.IO clients.
  // Fires on every poll (1 s) AND on connect/reconnect/error state changes.
  adam.on('status', (payload) => {
    const tagged = { deviceCode: null, ...payload };
    adamNs.emit('adam-status', tagged);
    io.emit('adam-status', tagged);            // root '/' namespace — Angular client
  });

  // Per-configured-device status, tagged with deviceCode so the dashboard can
  // filter to whichever device is currently selected.
  deviceManager.statusBus.on('status', (payload) => {
    adamNs.emit('adam-status', payload);
    io.emit('adam-status', payload);
  });

  // ── /adam namespace (optional — for clients that join /adam explicitly) ──
  adamNs.on('connection', (socket) => {
    logger.info(`[ADAM socket] /adam client connected  (id: ${socket.id})`);
    socket.emit('adam-status', _statusFor(null));
    socket.on('request-status', (deviceCode) => socket.emit('adam-status', _statusFor(deviceCode)));
    socket.on('disconnect', () =>
      logger.info(`[ADAM socket] /adam client disconnected (id: ${socket.id})`)
    );
  });

  // ── Root '/' namespace — Angular service connects here ────────────────────
  io.on('connection', (socket) => {
    logger.info(`[ADAM socket] Root client connected   (id: ${socket.id})`);
    // Push current state immediately — Angular won't wait for the next poll tick
    socket.emit('adam-status', _statusFor(null));
    socket.on('request-status', (deviceCode) => socket.emit('adam-status', _statusFor(deviceCode)));
    socket.on('disconnect', () =>
      logger.info(`[ADAM socket] Root client disconnected (id: ${socket.id})`)
    );
  });

  logger.info('[ADAM socket] Initialized — status pushed on connect + every poll');
}

module.exports = { init };
