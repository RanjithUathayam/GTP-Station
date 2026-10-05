const { getPool, sql } = require('../config/db');
const sapApi = require('./sapApiService');

// Status lifecycle of a GTP_DeliveryLog row:
//   OnHold    — group finished picking, waiting for the operator to release it to SAP
//               (only when the recheck hold is enabled — see isHoldEnabled)
//   Released  — an OnHold row that was released; the Pending row inserted next supersedes it
//   Pending   — SAP call in flight
//   Success   — SAP Delivery Note created (final — the group can no longer be reset)
//   Failed    — SAP call failed; can be re-posted
//   Cancelled — superseded by a Picklist Recheck reset of the group (it'll be re-held/posted
//               when the group completes again)

// Hold every completed group's SAP delivery until it's explicitly released, so the operator
// has a window to recheck (reset & re-pick) a group before it's dispatched. On by default;
// set DELIVERY_HOLD_FOR_RECHECK=false to restore post-on-completion. Read per call (not at
// require time) so it always reflects the loaded .env.
function isHoldEnabled() {
    return String(process.env.DELIVERY_HOLD_FOR_RECHECK ?? 'true').trim().toLowerCase() !== 'false';
}

// ── Ensure GTP_DeliveryLog table exists (idempotent) ─────────
let _tableEnsured = false;
async function ensureTable() {
    if (_tableEnsured) return;
    const pool = await getPool();
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_DeliveryLog')
        CREATE TABLE GTP_DeliveryLog (
            LogID          INT IDENTITY(1,1) PRIMARY KEY,
            SessionID      INT           NOT NULL,
            HeaderId       NVARCHAR(50)  NOT NULL,
            CardCode       NVARCHAR(50)  NOT NULL,
            DocEntry       INT           NULL,
            Status         NVARCHAR(20)  NOT NULL DEFAULT 'Pending',
            SapDocEntry    INT           NULL,
            SapDocNum      INT           NULL,
            ErrorMessage   NVARCHAR(MAX) NULL,
            RequestPayload NVARCHAR(MAX) NULL,
            CreatedAt      DATETIME      NOT NULL DEFAULT GETDATE(),
            UpdatedAt      DATETIME      NULL
        )
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_DeliveryLog') AND name = 'DocEntry')
            ALTER TABLE GTP_DeliveryLog ADD DocEntry INT NULL;
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_DeliveryLog') AND name = 'ShipToCode')
            ALTER TABLE GTP_DeliveryLog ADD ShipToCode NVARCHAR(50) NULL;

        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_DeliveryLog') AND name = 'SalesOrderNo')
            ALTER TABLE GTP_DeliveryLog ADD SalesOrderNo NVARCHAR(50) NULL;
    `);

    _tableEnsured = true;
}

// Latest delivery log row for one group — the row that decides its current delivery state.
// LogID breaks CreatedAt ties (DATETIME is only ~3ms precise).
async function getLatestDelivery(sessionId, cardCode, docEntry) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('de',  sql.Int,          docEntry)
        .query(`SELECT TOP 1 LogID, Status, SapDocEntry, SapDocNum, ErrorMessage, CreatedAt
                FROM GTP_DeliveryLog
                WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de
                ORDER BY CreatedAt DESC, LogID DESC`);
    return res.recordset[0] || null;
}

// Groups with a release/post currently running in this process — stops a double-click (or two
// screens) from posting the same group to SAP twice. A Pending row NOT in this set is left over
// from a crashed/restarted server and may be re-posted, same as before.
const _inFlight = new Set();
const inFlightKey = (sessionId, cardCode, docEntry) => `${sessionId}|${cardCode}|${docEntry}`;

// ── Format today as YYYY-MM-DD ────────────────────────────────
function today() {
    return new Date().toISOString().slice(0, 10);
}

// ── Build the SAP delivery payload for one party + one specific order ────
async function buildDeliveryPayload(sessionId, cardCode, docEntry) {
    const pool = await getPool();

    const result = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('de',  sql.Int,          docEntry)
        .query(`
            SELECT
                PP.ItemCode,
                PP.PickedQty            AS Quantity,
                PP.HeaderId,
                PP.DocEntry             AS BaseEntry,
                PP.ShipToCode,
                PP.SalesOrderNo,
                ISNULL(R.LineNum,   0)  AS BaseLine,
                ISNULL(R.Price,     0)  AS UnitPrice,
                ISNULL(R.DiscPrcnt, 0)  AS DiscountPercent,
                ISNULL(R.TaxCode,  '')  AS TaxCode,
                ISNULL(R.WhsCode, '01') AS WarehouseCode
            FROM GTP_PickProgress PP
            INNER JOIN BBLive.dbo.ORDR O
                    ON O.DocEntry = PP.DocEntry
                   AND O.CardCode COLLATE DATABASE_DEFAULT = PP.CardCode
            -- PP now has one row per (CardCode, ItemCode, DocEntry), so PP.PickedQty
            -- is already this specific order's own picked qty — no more risk of
            -- double-billing an item that's split across multiple orders.
            OUTER APPLY (
                SELECT TOP 1 LineNum, Price, DiscPrcnt, TaxCode, WhsCode
                FROM   BBLive.dbo.RDR1
                WHERE  DocEntry = PP.DocEntry
                  AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                ORDER  BY LineNum
            ) R
            WHERE PP.SessionID = @sid
              AND PP.CardCode  = @cc
              AND PP.DocEntry  = @de
              AND PP.Status    = 'Completed'
        `);

    if (!result.recordset.length) {
        throw new Error(`No completed items found for party ${cardCode} / order ${docEntry} in session ${sessionId}`);
    }

    const docDate      = today();
    const headerId     = result.recordset[0].HeaderId;
    const shipToCode   = result.recordset[0].ShipToCode   || null;
    const salesOrderNo = result.recordset[0].SalesOrderNo || null;

    const documentLines = result.recordset.map(r => ({
        ItemCode:        r.ItemCode,
        Quantity:        Number(r.Quantity),
        UnitPrice:       Number(r.UnitPrice),
        DiscountPercent: Number(r.DiscountPercent),
        ...(r.TaxCode ? { TaxCode: r.TaxCode } : {}),
        WarehouseCode:   r.WarehouseCode || '01',
        BaseType:        17,          // 17 = Sales Order
        BaseEntry:       r.BaseEntry,
        BaseLine:        r.BaseLine,
    }));

    const comments = `GTP Station Pick List: ${headerId} | Order: ${docEntry}`
        + (salesOrderNo ? ` (${salesOrderNo})` : '')
        + (shipToCode ? ` | Ship-To: ${shipToCode}` : '');

    const payload = {
        CardCode:   cardCode,
        DocDate:    docDate,
        DocDueDate: docDate,
        TaxDate:    docDate,
        Comments:   comments,
        DocumentLines: documentLines,
    };

    return { payload, shipToCode, salesOrderNo };
}

// ── Trigger SAP delivery for one party + one specific order ──────────────
async function triggerDocumentDelivery(sessionId, cardCode, docEntry, headerIdHint) {
    await ensureTable();
    const pool = await getPool();
    let logId = null;

    try {
        let headerId = headerIdHint;
        if (!headerId) {
            const sesRes = await pool.request()
                .input('sid', sql.Int, sessionId)
                .query('SELECT HeaderId FROM GTP_PicklistSessions WHERE SessionID = @sid');
            headerId = sesRes.recordset[0]?.HeaderId;
            if (!headerId) throw new Error(`Session ${sessionId} not found`);
        }

        const { payload, shipToCode, salesOrderNo } = await buildDeliveryPayload(sessionId, cardCode, docEntry);

        // Insert Pending log
        const logRes = await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('hid', sql.NVarChar(50),  headerId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('stc', sql.NVarChar(50),  shipToCode)
            .input('son', sql.NVarChar(50),  salesOrderNo)
            .input('pl',  sql.NVarChar(sql.MAX), JSON.stringify(payload))
            .query(`
                INSERT INTO GTP_DeliveryLog
                    (SessionID, HeaderId, CardCode, DocEntry, ShipToCode, SalesOrderNo, Status, RequestPayload)
                OUTPUT INSERTED.LogID
                VALUES (@sid, @hid, @cc, @de, @stc, @son, 'Pending', @pl)
            `);
        logId = logRes.recordset[0].LogID;

        // Call SAP B1
        const sapResult = await sapApi.createDelivery(payload);

        // Mark Success
        await pool.request()
            .input('lid', sql.Int, logId)
            .input('de',  sql.Int, sapResult.DocEntry ?? null)
            .input('dn',  sql.Int, sapResult.DocNum   ?? null)
            .query(`
                UPDATE GTP_DeliveryLog
                SET Status='Success', SapDocEntry=@de, SapDocNum=@dn, UpdatedAt=GETDATE()
                WHERE LogID = @lid
            `);

        console.log(`✅ SAP Delivery created — Order: ${docEntry}, SAP DocEntry: ${sapResult.DocEntry}, SAP DocNum: ${sapResult.DocNum}, Party: ${cardCode}`);
        return { success: true, orderDocEntry: docEntry, sapDocEntry: sapResult.DocEntry, sapDocNum: sapResult.DocNum };

    } catch (err) {
        console.error(`❌ SAP Delivery failed — Party: ${cardCode}, Order: ${docEntry} |`, err.message);

        if (logId) {
            try {
                await pool.request()
                    .input('lid', sql.Int,           logId)
                    .input('err', sql.NVarChar(sql.MAX), err.message)
                    .query(`
                        UPDATE GTP_DeliveryLog
                        SET Status='Failed', ErrorMessage=@err, UpdatedAt=GETDATE()
                        WHERE LogID = @lid
                    `);
            } catch (logErr) {
                console.error('Failed to update delivery log:', logErr.message);
            }
        }

        return { success: false, orderDocEntry: docEntry, error: err.message };
    }
}

// ── Group finished picking — post it, or park it OnHold for recheck ──────
// Called by processScan the moment a (CardCode, DocEntry) group completes.
async function onGroupCompleted(sessionId, cardCode, docEntry, headerId) {
    if (!isHoldEnabled()) return triggerDocumentDelivery(sessionId, cardCode, docEntry, headerId);
    return holdDocumentDelivery(sessionId, cardCode, docEntry, headerId);
}

async function holdDocumentDelivery(sessionId, cardCode, docEntry, headerId) {
    await ensureTable();
    const pool = await getPool();

    const latest = await getLatestDelivery(sessionId, cardCode, docEntry);
    if (latest && ['OnHold', 'Pending', 'Success'].includes(latest.Status)) return { held: false, status: latest.Status };

    const progRes = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('de',  sql.Int,          docEntry)
        .query(`SELECT TOP 1 HeaderId, ShipToCode, SalesOrderNo FROM GTP_PickProgress
                WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de`);
    const prog = progRes.recordset[0] || {};

    await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('hid', sql.NVarChar(50), headerId || prog.HeaderId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('de',  sql.Int,          docEntry)
        .input('stc', sql.NVarChar(50), prog.ShipToCode   || null)
        .input('son', sql.NVarChar(50), prog.SalesOrderNo || null)
        .query(`INSERT INTO GTP_DeliveryLog
                    (SessionID, HeaderId, CardCode, DocEntry, ShipToCode, SalesOrderNo, Status)
                VALUES (@sid, @hid, @cc, @de, @stc, @son, 'OnHold')`);

    console.log(`⏸  SAP Delivery on hold for recheck — Party: ${cardCode}, Order: ${docEntry}`);
    return { held: true };
}

// ── Release (or re-post) one group's delivery to SAP ─────────────────────
// Used by both "Release to SAP" (OnHold) and "Post Delivery" (Failed / stale Pending).
// Guards against the two ways this could create a duplicate or wrong SAP Delivery Note:
// posting a group that's already posted, and posting a group that isn't fully picked
// (e.g. mid re-pick after a recheck reset).
async function releaseDocumentDelivery(sessionId, cardCode, docEntry) {
    const key = inFlightKey(sessionId, cardCode, docEntry);
    if (_inFlight.has(key)) throw Object.assign(
        new Error(`Delivery for order ${docEntry} is already being posted`),
        { status: 409, code: 'DELIVERY_IN_PROGRESS' }
    );
    _inFlight.add(key);
    try {
        const pool = await getPool();

        const latest = await getLatestDelivery(sessionId, cardCode, docEntry);
        if (latest?.Status === 'Success') throw Object.assign(
            new Error(`Order ${docEntry} is already posted to SAP (Delivery #${latest.SapDocNum ?? latest.SapDocEntry})`),
            { status: 409, code: 'DELIVERY_ALREADY_POSTED' }
        );

        const progRes = await pool.request()
            .input('sid', sql.Int,          sessionId)
            .input('cc',  sql.NVarChar(50), cardCode)
            .input('de',  sql.Int,          docEntry)
            .query(`SELECT Status FROM GTP_PickProgress WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de`);
        if (!progRes.recordset.length) throw Object.assign(
            new Error(`Order ${docEntry} for party ${cardCode} is not in this session`), { status: 404 }
        );
        if (!progRes.recordset.every(r => r.Status === 'Completed')) throw Object.assign(
            new Error(`Order ${docEntry} is not fully picked yet — finish picking before posting to SAP`),
            { status: 409, code: 'GROUP_NOT_COMPLETE' }
        );

        const result = await triggerDocumentDelivery(sessionId, cardCode, docEntry);

        // Retire the OnHold row only once the post actually logged a newer row (Success/Failed) —
        // if it failed before logging anything, the group simply stays OnHold and releasable.
        if (latest?.Status === 'OnHold') {
            await pool.request()
                .input('lid', sql.Int, latest.LogID)
                .query(`UPDATE H SET Status='Released', UpdatedAt=GETDATE()
                        FROM GTP_DeliveryLog H
                        WHERE H.LogID=@lid AND EXISTS (
                            SELECT 1 FROM GTP_DeliveryLog N
                            WHERE N.SessionID=H.SessionID AND N.CardCode=H.CardCode
                              AND N.DocEntry=H.DocEntry AND N.LogID > H.LogID)`);
        }

        return result;
    } finally {
        _inFlight.delete(key);
    }
}

// ── Release every OnHold group in a session ──────────────────────────────
// Sequential — one SAP call at a time, same as individual releases.
async function releaseSessionDeliveries(sessionId) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`
            SELECT CardCode, DocEntry FROM (
                SELECT CardCode, DocEntry, Status,
                       ROW_NUMBER() OVER (PARTITION BY CardCode, DocEntry ORDER BY CreatedAt DESC, LogID DESC) AS rn
                FROM GTP_DeliveryLog WHERE SessionID=@sid
            ) X
            WHERE rn = 1 AND Status = 'OnHold'
            ORDER BY CardCode, DocEntry
        `);

    const results = [];
    for (const { CardCode, DocEntry } of res.recordset) {
        try {
            const r = await releaseDocumentDelivery(sessionId, CardCode, DocEntry);
            results.push({ cardCode: CardCode, docEntry: DocEntry, ...r });
        } catch (err) {
            results.push({ cardCode: CardCode, docEntry: DocEntry, success: false, error: err.message });
        }
    }
    return results;
}

// ── Get all delivery log records for a session ────────────────
async function getSessionDeliveries(sessionId) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`
            SELECT LogID, CardCode, DocEntry, Status, SapDocEntry, SapDocNum,
                   ErrorMessage, CreatedAt, UpdatedAt
            FROM   GTP_DeliveryLog
            WHERE  SessionID = @sid
            ORDER  BY CreatedAt DESC, LogID DESC
        `);
    return res.recordset;
}

// Latest delivery state per (CardCode, DocEntry) group — embedded in getSession() so the
// picking board / recheck dialog know whether a group is on hold, posted, or resettable.
async function getLatestDeliveriesBySession(sessionId) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`
            SELECT CardCode, DocEntry, Status, SapDocNum, ErrorMessage FROM (
                SELECT CardCode, DocEntry, Status, SapDocNum, ErrorMessage,
                       ROW_NUMBER() OVER (PARTITION BY CardCode, DocEntry ORDER BY CreatedAt DESC, LogID DESC) AS rn
                FROM GTP_DeliveryLog WHERE SessionID=@sid
            ) X WHERE rn = 1
        `);
    return res.recordset;
}

module.exports = {
    ensureTable, isHoldEnabled,
    triggerDocumentDelivery, onGroupCompleted, holdDocumentDelivery,
    releaseDocumentDelivery, releaseSessionDeliveries,
    getLatestDelivery, getLatestDeliveriesBySession,
    getSessionDeliveries, buildDeliveryPayload,
};
