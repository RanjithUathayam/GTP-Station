'use strict';

const EventEmitter = require('events');
const AdamDevice   = require('./Adam6052Service');
const configSvc    = require('./adamDeviceConfigService');
const { getMacForIp, normalizeMac } = require('../utils/macAddress');
const logger       = require('../utils/logger');

const MAC_RECHECK_MS = 5 * 60 * 1000;

// Legacy singleton — powers the existing /api/adam/* debug dashboard when no
// ?device= is specified, env-configured. Unaffected by per-device config.
const legacyDevice = new AdamDevice();

// Map<DeviceCode, { device, config, macStatus: 'ok'|'mismatch'|'unknown' }>
const _devices = new Map();
let _macTimer = null;

// Re-emits { deviceCode, ...statusPayload } for every configured device so the
// socket layer can forward device-tagged status pushes without knowing about
// individual Adam6052Service instances (which get torn down/rebuilt on reload).
const statusBus = new EventEmitter();

function getLegacyDevice() {
    return legacyDevice;
}

async function _validateMac(entry) {
    const { config } = entry;
    if (!config.MacAddress) {
        entry.macStatus = 'unknown';
        logger.warn(`[ADAM-MGR] No MAC address configured for device=${config.DeviceCode} — validation skipped (device is usable, but not locked)`);
        return;
    }
    const actual = await getMacForIp(config.IpAddress);
    if (!actual) {
        entry.macStatus = 'unknown';
        logger.warn(`[ADAM-MGR] Could not resolve MAC for ${config.IpAddress} (device ${config.DeviceCode}) via ARP — device unreachable or off-subnet`);
        return;
    }
    const expected = normalizeMac(config.MacAddress);
    entry.macStatus = actual === expected ? 'ok' : 'mismatch';
    if (entry.macStatus === 'mismatch') {
        logger.error(`[ADAM-MGR] MAC MISMATCH device=${config.DeviceCode} ip=${config.IpAddress} expected=${expected} actual=${actual}`);
    } else {
        logger.info(`[ADAM-MGR] MAC validated OK — device=${config.DeviceCode} ip=${config.IpAddress} mac=${expected}`);
    }
}

async function _buildEntry(config) {
    const device = new AdamDevice({ ip: config.IpAddress, port: config.Port, unitId: config.UnitId });
    const entry  = { device, config, macStatus: 'unknown' };
    device.on('status', (payload) => statusBus.emit('status', { deviceCode: config.DeviceCode, ...payload }));
    await device.start();
    await _validateMac(entry);
    return entry;
}

/** Tears down and rebuilds every configured device from the DB. Called at startup
 *  and after any create/update/delete through the config screen. */
async function reloadAll() {
    for (const entry of _devices.values()) {
        try { entry.device.destroy(); } catch (_) {}
    }
    _devices.clear();

    const rows = await configSvc.listActive();
    for (const row of rows) {
        try {
            const entry = await _buildEntry(row);
            _devices.set(row.DeviceCode, entry);
            logger.info(`[ADAM-MGR] Device ready — code=${row.DeviceCode} ip=${row.IpAddress} channels=${row.OutputStartChannel}-${row.OutputEndChannel} mac=${entry.macStatus}`);
        } catch (err) {
            logger.error(`[ADAM-MGR] Failed to init device for code=${row.DeviceCode}: ${err.message}`);
        }
    }
}

/** Called once at server startup, after the DB pool is up. */
async function init() {
    await reloadAll();

    if (!_macTimer) {
        _macTimer = setInterval(() => {
            for (const entry of _devices.values()) {
                _validateMac(entry).catch(e => logger.error(`[ADAM-MGR] MAC recheck error: ${e.message}`));
            }
        }, MAC_RECHECK_MS);
    }
}

function getDevice(deviceCode) {
    return _devices.get(deviceCode) || null;
}

function listDeviceCodes() {
    return [..._devices.keys()];
}

function getChannels(deviceCode) {
    const entry = _devices.get(deviceCode);
    if (!entry) return null;
    const { OutputStartChannel: start, OutputEndChannel: end } = entry.config;
    const channels = [];
    for (let c = start; c <= end; c++) channels.push(c);
    return channels;
}

// Error codes that must fail picking-session start / light activation outright
// (as opposed to transient Modbus/network errors, which are logged and swallowed
// so momentary hardware hiccups don't take down an otherwise-valid station).
const BLOCKING_ERROR_CODES = [
    'ADAM_CONFIG_MISSING',
    'ADAM_DEVICE_INACTIVE',
    'ADAM_MAC_MISMATCH',
    'ADAM_DEVICE_INIT_FAILED',
];

/**
 * Returns { device, channels } for a device code, or throws a typed, user-facing
 * error identifying exactly why the device can't be used — no config row, the
 * config exists but is Inactive, it's Active but failed to connect/initialize,
 * or its live MAC doesn't match what's configured (device swapped/miswired).
 */
async function assertUsable(deviceCode) {
    const entry = _devices.get(deviceCode);

    if (entry) {
        if (entry.macStatus === 'mismatch') {
            logger.error(`[ADAM-MGR] BLOCKED — MAC mismatch for device="${deviceCode}" ip=${entry.config.IpAddress}`);
            throw Object.assign(
                new Error(`ADAM device MAC address mismatch for "${deviceCode}" — communication blocked`),
                { status: 409, code: 'ADAM_MAC_MISMATCH' }
            );
        }
        const channels = getChannels(deviceCode);
        logger.info(`[ADAM-MGR] Device usable — code=${deviceCode} ip=${entry.config.IpAddress}:${entry.config.Port} outputSeries=D${channels[0]}-D${channels[channels.length - 1]} mac=${entry.macStatus}`);
        return { device: entry.device, channels };
    }

    // Not currently connected — look up the DB row to give a precise reason.
    const row = await configSvc.getByCode(deviceCode);
    if (!row) {
        logger.error(`[ADAM-MGR] BLOCKED — no ADAM device configured for code="${deviceCode}"`);
        throw Object.assign(
            new Error(`No ADAM device configured for "${deviceCode}" — add one in ADAM Device Configuration`),
            { status: 400, code: 'ADAM_CONFIG_MISSING' }
        );
    }
    if (!row.IsActive) {
        logger.error(`[ADAM-MGR] BLOCKED — ADAM device "${deviceCode}" is configured but Inactive`);
        throw Object.assign(
            new Error(`ADAM device "${deviceCode}" is configured but marked Inactive — activate it in ADAM Device Configuration`),
            { status: 409, code: 'ADAM_DEVICE_INACTIVE' }
        );
    }
    logger.error(`[ADAM-MGR] BLOCKED — ADAM device "${deviceCode}" is Active but failed to initialize (see earlier [ADAM-MGR] errors)`);
    throw Object.assign(
        new Error(`ADAM device "${deviceCode}" failed to initialize — check server logs`),
        { status: 502, code: 'ADAM_DEVICE_INIT_FAILED' }
    );
}

module.exports = {
    init,
    reloadAll,
    getDevice,
    listDeviceCodes,
    getChannels,
    assertUsable,
    getLegacyDevice,
    statusBus,
    BLOCKING_ERROR_CODES,
};
