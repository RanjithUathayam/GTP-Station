'use strict';

const svc           = require('../services/adamDeviceConfigService');
const deviceManager = require('../services/adamDeviceManager');

async function listAll(req, res, next) {
    try {
        res.json({ success: true, data: await svc.listAll() });
    } catch (err) { next(err); }
}

async function getByCode(req, res, next) {
    try {
        const row = await svc.getByCode(req.params.deviceCode);
        if (!row) return res.status(404).json({ success: false, message: 'No device config with that code', code: 'NOT_FOUND' });
        res.json({ success: true, data: row });
    } catch (err) { next(err); }
}

async function create(req, res, next) {
    try {
        const row = await svc.create(req.body);
        await deviceManager.reloadAll();
        res.json({ success: true, data: row });
    } catch (err) { next(err); }
}

async function update(req, res, next) {
    try {
        const row = await svc.update(parseInt(req.params.id, 10), req.body);
        await deviceManager.reloadAll();
        res.json({ success: true, data: row });
    } catch (err) { next(err); }
}

async function remove(req, res, next) {
    try {
        await svc.remove(parseInt(req.params.id, 10));
        await deviceManager.reloadAll();
        res.json({ success: true });
    } catch (err) { next(err); }
}

async function detectMac(req, res, next) {
    try {
        res.json({ success: true, data: await svc.detectMac(req.query.ip) });
    } catch (err) { next(err); }
}

// ── GET /api/adam-devices/:deviceCode/status ───────────────────────────────────
// Combines the DB config with the live device-manager state so the picking
// screen can show IP/Output Series/MAC/Status *and* gate scanning on a single
// call, right after the operator picks a GTP Station — before they can touch
// the Picklist Number field.
async function getRuntimeStatus(req, res, next) {
    try {
        const code = req.params.deviceCode;
        const row  = await svc.getByCode(code);

        if (!row) {
            return res.json({
                success: true,
                data: {
                    deviceCode: code, exists: false, usable: false,
                    reason: `No ADAM device configured for "${code}"`,
                },
            });
        }

        const entry     = deviceManager.getDevice(code);
        const macStatus = entry?.macStatus || 'unknown';

        let usable = true, reason = null;
        if (!row.IsActive) {
            usable = false;
            reason = `Device "${code}" is configured but marked Inactive`;
        } else if (!entry) {
            usable = false;
            reason = `Device "${code}" is Active but failed to initialize — check server logs`;
        } else if (macStatus === 'mismatch') {
            usable = false;
            reason = `MAC address mismatch for "${code}" — communication blocked`;
        }

        res.json({
            success: true,
            data: {
                deviceCode:         code,
                exists:             true,
                ipAddress:          row.IpAddress,
                port:               row.Port,
                unitId:             row.UnitId,
                outputStartChannel: row.OutputStartChannel,
                outputEndChannel:   row.OutputEndChannel,
                macAddress:         row.MacAddress,
                isActive:           row.IsActive,
                connected:          !!entry?.device?.isConnected,
                macStatus,
                usable,
                reason,
            },
        });
    } catch (err) { next(err); }
}

module.exports = { listAll, getByCode, create, update, remove, detectMac, getRuntimeStatus };
