'use strict';

const { getPool, sql } = require('../config/db');
const { normalizeMac, getMacForIp } = require('../utils/macAddress');

let _ensured = false;

async function ensureTable() {
    if (_ensured) return;
    const pool = await getPool();

    // Migrate the old per-station schema (StationID FK) to the flat DeviceCode schema.
    // Safe to drop-and-recreate: the station-based config was never used in the field
    // (this feature shipped and was immediately revised before any real rows existed).
    const oldSchema = await pool.request().query(`
        SELECT 1 AS found FROM sys.columns
        WHERE object_id = OBJECT_ID('GTP_AdamDevices') AND name = 'StationID'
    `);
    if (oldSchema.recordset.length) {
        await pool.request().query(`DROP TABLE GTP_AdamDevices;`);
    }

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_AdamDevices')
        CREATE TABLE GTP_AdamDevices (
            DeviceConfigID     INT PRIMARY KEY IDENTITY(1,1),
            DeviceCode         NVARCHAR(50) NOT NULL UNIQUE,
            IpAddress          NVARCHAR(45) NOT NULL,
            Port               INT NOT NULL DEFAULT 502,
            UnitId             INT NOT NULL DEFAULT 1,
            OutputStartChannel INT NOT NULL,
            OutputEndChannel   INT NOT NULL,
            MacAddress         NVARCHAR(17) NULL,
            IsActive           BIT NOT NULL DEFAULT 1,
            CreatedAt          DATETIME NOT NULL DEFAULT GETDATE(),
            UpdatedAt          DATETIME NULL
        );
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AdamDevices_Ip')
        CREATE INDEX IX_AdamDevices_Ip ON GTP_AdamDevices(IpAddress);
    `);
    _ensured = true;
}

function _validateChannels(startCh, endCh) {
    const start = parseInt(startCh, 10);
    const end   = parseInt(endCh, 10);
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end > 7 || start > end) {
        throw Object.assign(
            new Error('Output channel range must be within 0-7 with start <= end'),
            { status: 400, code: 'INVALID_CHANNEL_RANGE' }
        );
    }
    return { start, end };
}

async function _assertNoChannelOverlap(pool, { ip, port, start, end, excludeDeviceConfigId }) {
    const res = await pool.request()
        .input('ip',  sql.NVarChar(45), ip)
        .input('port', sql.Int,         port)
        .query(`SELECT DeviceConfigID, DeviceCode, OutputStartChannel, OutputEndChannel
                FROM GTP_AdamDevices
                WHERE IpAddress=@ip AND Port=@port AND IsActive=1`);

    for (const row of res.recordset) {
        if (excludeDeviceConfigId && row.DeviceConfigID === excludeDeviceConfigId) continue;
        const overlap = start <= row.OutputEndChannel && end >= row.OutputStartChannel;
        if (overlap) {
            throw Object.assign(
                new Error(`Output channels ${start}-${end} overlap with an existing active config (device "${row.DeviceCode}", channels ${row.OutputStartChannel}-${row.OutputEndChannel}) on ${ip}:${port}`),
                { status: 409, code: 'CHANNEL_RANGE_OVERLAP' }
            );
        }
    }
}

async function _assertDeviceCodeUnique(pool, deviceCode, excludeDeviceConfigId) {
    const res = await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .query(`SELECT DeviceConfigID FROM GTP_AdamDevices WHERE DeviceCode=@code`);
    const clash = res.recordset.find(r => r.DeviceConfigID !== excludeDeviceConfigId);
    if (clash) {
        throw Object.assign(
            new Error(`Device code "${deviceCode}" is already in use`),
            { status: 409, code: 'DEVICE_CODE_TAKEN' }
        );
    }
}

async function listAll() {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request().query(`SELECT * FROM GTP_AdamDevices ORDER BY DeviceCode`);
    return res.recordset;
}

async function listActive() {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request().query(`SELECT * FROM GTP_AdamDevices WHERE IsActive = 1`);
    return res.recordset;
}

async function getByCode(deviceCode) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .query(`SELECT * FROM GTP_AdamDevices WHERE DeviceCode = @code`);
    return res.recordset[0] || null;
}

async function create(body) {
    await ensureTable();
    const pool = await getPool();

    const deviceCode = String(body.deviceCode || '').trim();
    const port        = parseInt(body.port ?? 502, 10);
    const unitId      = parseInt(body.unitId ?? 1, 10);
    const { start, end } = _validateChannels(body.outputStartChannel, body.outputEndChannel);
    const ip  = String(body.ipAddress || '').trim();
    const mac = body.macAddress ? normalizeMac(body.macAddress) : null;

    if (!deviceCode) {
        throw Object.assign(new Error('deviceCode is required'), { status: 400, code: 'DEVICE_CODE_REQUIRED' });
    }
    if (!ip) {
        throw Object.assign(new Error('ipAddress is required'), { status: 400, code: 'IP_REQUIRED' });
    }

    await _assertDeviceCodeUnique(pool, deviceCode, null);
    await _assertNoChannelOverlap(pool, { ip, port, start, end });

    await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .input('ip',  sql.NVarChar(45), ip)
        .input('port', sql.Int,         port)
        .input('uid', sql.Int,          unitId)
        .input('sc',  sql.Int,          start)
        .input('ec',  sql.Int,          end)
        .input('mac', sql.NVarChar(17), mac)
        .query(`
            INSERT INTO GTP_AdamDevices
                (DeviceCode, IpAddress, Port, UnitId, OutputStartChannel, OutputEndChannel, MacAddress)
            VALUES (@code, @ip, @port, @uid, @sc, @ec, @mac)
        `);

    return await getByCode(deviceCode);
}

async function update(deviceConfigId, body) {
    await ensureTable();
    const pool = await getPool();

    const id = parseInt(deviceConfigId, 10);
    const existingRes = await pool.request()
        .input('id', sql.Int, id)
        .query(`SELECT * FROM GTP_AdamDevices WHERE DeviceConfigID=@id`);
    const existing = existingRes.recordset[0];
    if (!existing) {
        throw Object.assign(new Error('Device config not found'), { status: 404, code: 'NOT_FOUND' });
    }

    const deviceCode = String(body.deviceCode ?? existing.DeviceCode).trim();
    const port   = parseInt(body.port ?? existing.Port, 10);
    const unitId = parseInt(body.unitId ?? existing.UnitId, 10);
    const { start, end } = _validateChannels(
        body.outputStartChannel ?? existing.OutputStartChannel,
        body.outputEndChannel   ?? existing.OutputEndChannel,
    );
    const ip  = String(body.ipAddress ?? existing.IpAddress).trim();
    const mac = body.macAddress !== undefined
        ? (body.macAddress ? normalizeMac(body.macAddress) : null)
        : existing.MacAddress;
    const isActive = body.isActive !== undefined ? Boolean(body.isActive) : existing.IsActive;

    if (!deviceCode) {
        throw Object.assign(new Error('deviceCode is required'), { status: 400, code: 'DEVICE_CODE_REQUIRED' });
    }

    await _assertDeviceCodeUnique(pool, deviceCode, id);
    await _assertNoChannelOverlap(pool, { ip, port, start, end, excludeDeviceConfigId: id });

    await pool.request()
        .input('id',  sql.Int,          id)
        .input('code', sql.NVarChar(50), deviceCode)
        .input('ip',  sql.NVarChar(45), ip)
        .input('port', sql.Int,         port)
        .input('uid', sql.Int,          unitId)
        .input('sc',  sql.Int,          start)
        .input('ec',  sql.Int,          end)
        .input('mac', sql.NVarChar(17), mac)
        .input('act', sql.Bit,          isActive)
        .query(`
            UPDATE GTP_AdamDevices
            SET DeviceCode=@code, IpAddress=@ip, Port=@port, UnitId=@uid,
                OutputStartChannel=@sc, OutputEndChannel=@ec,
                MacAddress=@mac, IsActive=@act, UpdatedAt=GETDATE()
            WHERE DeviceConfigID=@id
        `);

    return await getByCode(deviceCode);
}

async function remove(deviceConfigId) {
    await ensureTable();
    const pool = await getPool();
    await pool.request()
        .input('id', sql.Int, parseInt(deviceConfigId, 10))
        .query(`UPDATE GTP_AdamDevices SET IsActive=0, UpdatedAt=GETDATE() WHERE DeviceConfigID=@id`);
}

async function detectMac(ip) {
    const trimmed = String(ip || '').trim();
    if (!trimmed) {
        throw Object.assign(new Error('ip query param is required'), { status: 400, code: 'IP_REQUIRED' });
    }
    const mac = await getMacForIp(trimmed);
    return { ip: trimmed, mac };
}

module.exports = {
    ensureTable,
    listAll,
    listActive,
    getByCode,
    create,
    update,
    remove,
    detectMac,
};
