'use strict';

const { getPool, sql } = require('../config/db');
const logger     = require('../utils/logger');
const protocols  = require('./printing/protocols');
const transport  = require('./printing/transport');

const VALID_PROTOCOLS = ['ZPL', 'EPL', 'TSPL', 'CPCL', 'ESCPOS', 'RAW', 'WindowsDriver'];

let _ensured = false;
async function ensurePrinterTables(pool) {
    if (_ensured) return;

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_StationPrinters')
        CREATE TABLE GTP_StationPrinters (
            PrinterConfigID INT IDENTITY(1,1) PRIMARY KEY,
            DeviceCode      NVARCHAR(50)  NOT NULL UNIQUE,
            PrinterName     NVARCHAR(100) NOT NULL,
            IpAddress       NVARCHAR(45)  NOT NULL,
            Port            INT           NOT NULL DEFAULT 9100,
            PrinterType     NVARCHAR(30)  NOT NULL DEFAULT 'Generic',
            Protocol        NVARCHAR(20)  NOT NULL DEFAULT 'RAW',
            DPI             INT           NOT NULL DEFAULT 203,
            PaperWidthMm    DECIMAL(6,2)  NOT NULL DEFAULT 90,
            LabelHeightMm   DECIMAL(6,2)  NOT NULL DEFAULT 45,
            TimeoutMs       INT           NOT NULL DEFAULT 3000,
            RetryCount      INT           NOT NULL DEFAULT 2,
            IsActive        BIT           NOT NULL DEFAULT 1,
            CreatedAt       DATETIME      NOT NULL DEFAULT GETDATE(),
            UpdatedAt       DATETIME      NULL
        );
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_PrintLog')
        CREATE TABLE GTP_PrintLog (
            LogID        INT IDENTITY(1,1) PRIMARY KEY,
            DeviceCode   NVARCHAR(50) NOT NULL,
            BoxID        INT NULL,
            LabelType    NVARCHAR(20) NOT NULL,
            Status       NVARCHAR(10) NOT NULL,
            ErrorMessage NVARCHAR(500) NULL,
            CreatedAt    DATETIME NOT NULL DEFAULT GETDATE(),
            CompletedAt  DATETIME NULL
        );
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PrintLog_Device')
            CREATE INDEX IX_PrintLog_Device ON GTP_PrintLog (DeviceCode, CreatedAt DESC);
    `);

    _ensured = true;
}

function _validateProtocol(protocol) {
    const p = String(protocol || '').trim();
    if (!VALID_PROTOCOLS.includes(p)) {
        throw Object.assign(
            new Error(`Protocol must be one of: ${VALID_PROTOCOLS.join(', ')}`),
            { status: 400, code: 'INVALID_PROTOCOL' },
        );
    }
    return p;
}

async function _assertDeviceCodeUnique(pool, deviceCode, excludeId) {
    const res = await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .query(`SELECT PrinterConfigID FROM GTP_StationPrinters WHERE DeviceCode=@code`);
    const clash = res.recordset.find(r => r.PrinterConfigID !== excludeId);
    if (clash) {
        throw Object.assign(
            new Error(`A printer is already configured for device code "${deviceCode}"`),
            { status: 409, code: 'DEVICE_CODE_TAKEN' },
        );
    }
}

async function listAll() {
    const pool = await getPool();
    await ensurePrinterTables(pool);
    const res = await pool.request().query(`SELECT * FROM GTP_StationPrinters ORDER BY DeviceCode`);
    return res.recordset;
}

async function getByCode(deviceCode) {
    const pool = await getPool();
    await ensurePrinterTables(pool);
    const res = await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .query(`SELECT * FROM GTP_StationPrinters WHERE DeviceCode=@code`);
    return res.recordset[0] || null;
}

async function create(body) {
    const pool = await getPool();
    await ensurePrinterTables(pool);

    const deviceCode  = String(body.deviceCode || '').trim();
    const printerName = String(body.printerName || '').trim();
    const ip          = String(body.ipAddress || '').trim();
    const port        = parseInt(body.port ?? 9100, 10);
    const printerType = String(body.printerType || 'Generic').trim();
    const protocol     = _validateProtocol(body.protocol || 'RAW');
    const dpi          = parseInt(body.dpi ?? 203, 10);
    const widthMm       = Number(body.paperWidthMm ?? 90);
    const heightMm      = Number(body.labelHeightMm ?? 45);
    const timeoutMs     = parseInt(body.timeoutMs ?? 3000, 10);
    const retryCount    = parseInt(body.retryCount ?? 2, 10);

    if (!deviceCode)  throw Object.assign(new Error('deviceCode is required'),  { status: 400, code: 'DEVICE_CODE_REQUIRED' });
    if (!printerName) throw Object.assign(new Error('printerName is required'), { status: 400, code: 'PRINTER_NAME_REQUIRED' });
    if (!ip)          throw Object.assign(new Error('ipAddress is required'),   { status: 400, code: 'IP_REQUIRED' });

    await _assertDeviceCodeUnique(pool, deviceCode, null);

    await pool.request()
        .input('code', sql.NVarChar(50),  deviceCode)
        .input('name', sql.NVarChar(100), printerName)
        .input('ip',   sql.NVarChar(45),  ip)
        .input('port', sql.Int,           port)
        .input('type', sql.NVarChar(30),  printerType)
        .input('proto',sql.NVarChar(20),  protocol)
        .input('dpi',  sql.Int,           dpi)
        .input('w',    sql.Decimal(6,2),  widthMm)
        .input('h',    sql.Decimal(6,2),  heightMm)
        .input('to',   sql.Int,           timeoutMs)
        .input('rc',   sql.Int,           retryCount)
        .query(`
            INSERT INTO GTP_StationPrinters
                (DeviceCode, PrinterName, IpAddress, Port, PrinterType, Protocol, DPI, PaperWidthMm, LabelHeightMm, TimeoutMs, RetryCount)
            VALUES (@code, @name, @ip, @port, @type, @proto, @dpi, @w, @h, @to, @rc)
        `);

    return await getByCode(deviceCode);
}

async function update(printerConfigId, body) {
    const pool = await getPool();
    await ensurePrinterTables(pool);

    const id = parseInt(printerConfigId, 10);
    const existingRes = await pool.request()
        .input('id', sql.Int, id)
        .query(`SELECT * FROM GTP_StationPrinters WHERE PrinterConfigID=@id`);
    const existing = existingRes.recordset[0];
    if (!existing) throw Object.assign(new Error('Printer config not found'), { status: 404, code: 'NOT_FOUND' });

    const deviceCode  = String(body.deviceCode ?? existing.DeviceCode).trim();
    const printerName = String(body.printerName ?? existing.PrinterName).trim();
    const ip           = String(body.ipAddress ?? existing.IpAddress).trim();
    const port          = parseInt(body.port ?? existing.Port, 10);
    const printerType   = String(body.printerType ?? existing.PrinterType).trim();
    const protocol       = _validateProtocol(body.protocol ?? existing.Protocol);
    const dpi             = parseInt(body.dpi ?? existing.DPI, 10);
    const widthMm         = Number(body.paperWidthMm ?? existing.PaperWidthMm);
    const heightMm        = Number(body.labelHeightMm ?? existing.LabelHeightMm);
    const timeoutMs        = parseInt(body.timeoutMs ?? existing.TimeoutMs, 10);
    const retryCount        = parseInt(body.retryCount ?? existing.RetryCount, 10);
    const isActive           = body.isActive !== undefined ? Boolean(body.isActive) : existing.IsActive;

    if (!deviceCode)  throw Object.assign(new Error('deviceCode is required'),  { status: 400, code: 'DEVICE_CODE_REQUIRED' });
    if (!printerName) throw Object.assign(new Error('printerName is required'), { status: 400, code: 'PRINTER_NAME_REQUIRED' });

    await _assertDeviceCodeUnique(pool, deviceCode, id);

    await pool.request()
        .input('id',   sql.Int,           id)
        .input('code', sql.NVarChar(50),  deviceCode)
        .input('name', sql.NVarChar(100), printerName)
        .input('ip',   sql.NVarChar(45),  ip)
        .input('port', sql.Int,           port)
        .input('type', sql.NVarChar(30),  printerType)
        .input('proto',sql.NVarChar(20),  protocol)
        .input('dpi',  sql.Int,           dpi)
        .input('w',    sql.Decimal(6,2),  widthMm)
        .input('h',    sql.Decimal(6,2),  heightMm)
        .input('to',   sql.Int,           timeoutMs)
        .input('rc',   sql.Int,           retryCount)
        .input('act',  sql.Bit,           isActive)
        .query(`
            UPDATE GTP_StationPrinters
            SET DeviceCode=@code, PrinterName=@name, IpAddress=@ip, Port=@port,
                PrinterType=@type, Protocol=@proto, DPI=@dpi, PaperWidthMm=@w, LabelHeightMm=@h,
                TimeoutMs=@to, RetryCount=@rc, IsActive=@act, UpdatedAt=GETDATE()
            WHERE PrinterConfigID=@id
        `);

    return await getByCode(deviceCode);
}

async function remove(printerConfigId) {
    const pool = await getPool();
    await ensurePrinterTables(pool);
    await pool.request()
        .input('id', sql.Int, parseInt(printerConfigId, 10))
        .query(`UPDATE GTP_StationPrinters SET IsActive=0, UpdatedAt=GETDATE() WHERE PrinterConfigID=@id`);
}

async function checkStatus(deviceCode) {
    const config = await getByCode(deviceCode);
    if (!config) return { deviceCode, exists: false, online: false };
    const online = await transport.checkPort(config.IpAddress, config.Port, Math.min(config.TimeoutMs, 3000));
    return { deviceCode, exists: true, online, checkedAt: new Date().toISOString() };
}

async function _logPrint(deviceCode, boxId, labelType, status, errorMessage) {
    const pool = await getPool();
    await pool.request()
        .input('code', sql.NVarChar(50),  deviceCode)
        .input('bid',  sql.Int,           boxId ?? null)
        .input('lt',   sql.NVarChar(20),  labelType)
        .input('st',   sql.NVarChar(10),  status)
        .input('err',  sql.NVarChar(500), errorMessage ?? null)
        .query(`
            INSERT INTO GTP_PrintLog (DeviceCode, BoxID, LabelType, Status, ErrorMessage, CompletedAt)
            VALUES (@code, @bid, @lt, @st, @err, GETDATE())
        `);
}

async function getLogs(deviceCode, limit = 50) {
    const pool = await getPool();
    await ensurePrinterTables(pool);
    const res = await pool.request()
        .input('code', sql.NVarChar(50), deviceCode)
        .input('n',    sql.Int,          Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200))
        .query(`SELECT TOP (@n) * FROM GTP_PrintLog WHERE DeviceCode=@code ORDER BY CreatedAt DESC`);
    return res.recordset;
}

// One physical printer's socket must never receive two overlapping jobs —
// a simple per-DeviceCode serial promise chain, same idea as Adam6052Service's
// _withLock but scoped per device rather than shared.
const _queues = new Map();
function _enqueue(deviceCode, fn) {
    const prev = _queues.get(deviceCode) || Promise.resolve();
    const next = prev.then(fn, fn);
    _queues.set(deviceCode, next.catch(() => {}));
    return next;
}

async function _sendWithRetry(config, buffer) {
    const attempts = 1 + Math.max(0, config.RetryCount);
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        if (config.Protocol === 'WindowsDriver') {
            try {
                transport.sendWindowsDriver();
            } catch (err) {
                return { success: false, error: err.message };
            }
        }
        const result = await transport.sendRaw(config.IpAddress, config.Port, buffer, config.TimeoutMs);
        if (result.success) return result;
        lastError = result.error;
        logger.warn(`[PRINT] Attempt ${i + 1}/${attempts} to ${config.DeviceCode} (${config.IpAddress}:${config.Port}) failed: ${lastError}`);
    }
    return { success: false, error: lastError };
}

// Looks up the station's printer config, renders labelSpec via the configured
// protocol, sends it over TCP (with retry), and logs the outcome. Returns
// { printed: false } — never throws — when no active printer is configured,
// so callers can treat that as "fall back to the browser-print flow".
async function printLabel(deviceCode, labelType, labelSpec, boxId) {
    const config = await getByCode(deviceCode);
    if (!config || !config.IsActive) {
        return { printed: false, reason: config ? 'inactive' : 'not_configured' };
    }

    return _enqueue(deviceCode, async () => {
        try {
            const renderer = protocols[config.Protocol];
            if (!renderer && config.Protocol !== 'WindowsDriver') {
                throw new Error(`No renderer registered for protocol "${config.Protocol}"`);
            }
            const spec = {
                ...labelSpec,
                widthMm:  labelSpec.widthMm  ?? Number(config.PaperWidthMm),
                heightMm: labelSpec.heightMm ?? Number(config.LabelHeightMm),
                dpi:      labelSpec.dpi      ?? Number(config.DPI),
            };
            const buffer = config.Protocol === 'WindowsDriver' ? Buffer.alloc(0) : renderer.render(spec);
            const result = await _sendWithRetry(config, buffer);

            await _logPrint(deviceCode, boxId, labelType, result.success ? 'Success' : 'Failed', result.error);
            return { printed: result.success, error: result.error };
        } catch (err) {
            await _logPrint(deviceCode, boxId, labelType, 'Failed', err.message);
            return { printed: false, error: err.message };
        }
    });
}

async function testPrint(deviceCode) {
    const spec = {
        fields: [
            { label: 'Test Print', value: deviceCode },
            { label: 'Time',       value: new Date().toLocaleString() },
        ],
        qrData: `TEST-${deviceCode}`,
    };
    return printLabel(deviceCode, 'Test', spec, null);
}

module.exports = {
    ensurePrinterTables,
    listAll, getByCode, create, update, remove,
    checkStatus, getLogs,
    printLabel, testPrint,
};
