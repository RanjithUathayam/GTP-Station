const { getPool, sql } = require('../config/db');
const sapApi = require('./sapApiService');

// ── Ensure GTP_DeliveryLog table exists (idempotent) ─────────
async function ensureTable() {
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
}

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
            ORDER  BY CreatedAt DESC
        `);
    return res.recordset;
}

module.exports = {
    triggerDocumentDelivery,
    getSessionDeliveries, buildDeliveryPayload,
};
