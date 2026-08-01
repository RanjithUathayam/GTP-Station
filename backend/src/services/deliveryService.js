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
            Status         NVARCHAR(20)  NOT NULL DEFAULT 'Pending',
            SapDocEntry    INT           NULL,
            SapDocNum      INT           NULL,
            ErrorMessage   NVARCHAR(MAX) NULL,
            RequestPayload NVARCHAR(MAX) NULL,
            CreatedAt      DATETIME      NOT NULL DEFAULT GETDATE(),
            UpdatedAt      DATETIME      NULL
        )
    `);
}

// ── Format today as YYYY-MM-DD ────────────────────────────────
function today() {
    return new Date().toISOString().slice(0, 10);
}

// ── Build the SAP delivery payload for one party ─────────────
async function buildDeliveryPayload(sessionId, cardCode) {
    const pool = await getPool();

    const result = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .query(`
            SELECT DISTINCT
                PP.ItemCode,
                PP.PickedQty            AS Quantity,
                PP.HeaderId,
                TD.DocEntry             AS BaseEntry,
                ISNULL((
                    SELECT TOP 1 LineNum
                    FROM   BBLive.dbo.RDR1
                    WHERE  DocEntry = TD.DocEntry
                      AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                    ORDER  BY LineNum
                ), 0)                   AS BaseLine,
                ISNULL((
                    SELECT TOP 1 Price
                    FROM   BBLive.dbo.RDR1
                    WHERE  DocEntry = TD.DocEntry
                      AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                    ORDER  BY LineNum
                ), 0)                   AS UnitPrice,
                ISNULL((
                    SELECT TOP 1 DiscPrcnt
                    FROM   BBLive.dbo.RDR1
                    WHERE  DocEntry = TD.DocEntry
                      AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                    ORDER  BY LineNum
                ), 0)                   AS DiscountPercent,
                ISNULL((
                    SELECT TOP 1 TaxCode
                    FROM   BBLive.dbo.RDR1
                    WHERE  DocEntry = TD.DocEntry
                      AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                    ORDER  BY LineNum
                ), '')                  AS TaxCode,
                ISNULL((
                    SELECT TOP 1 WhsCode
                    FROM   BBLive.dbo.RDR1
                    WHERE  DocEntry = TD.DocEntry
                      AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                    ORDER  BY LineNum
                ), '01')                AS WarehouseCode
            FROM GTP_PickProgress PP
            CROSS APPLY (
                SELECT TOP 1 TD2.DocEntry
                FROM   WMS.dbo.Tran_TransDetails TD2
                INNER  JOIN BBLive.dbo.ORDR O2
                       ON O2.DocEntry = TD2.DocEntry
                      AND O2.CardCode COLLATE DATABASE_DEFAULT = PP.CardCode
                WHERE  TD2.HeaderId    = PP.HeaderId
                  AND  TD2.ProductCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                ORDER  BY TD2.DocEntry
            ) TD
            WHERE PP.SessionID = @sid
              AND PP.CardCode  = @cc
              AND PP.Status    = 'Completed'
        `);

    if (!result.recordset.length) {
        throw new Error(`No completed items found for party ${cardCode} in session ${sessionId}`);
    }

    const docDate  = today();
    const headerId = result.recordset[0].HeaderId;

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

    return {
        CardCode:   cardCode,
        DocDate:    docDate,
        DocDueDate: docDate,
        TaxDate:    docDate,
        Comments:   `GTP Station Pick List: ${headerId}`,
        DocumentLines: documentLines,
    };
}

// ── Trigger SAP delivery for a completed party ────────────────
async function triggerPartyDelivery(sessionId, cardCode) {
    await ensureTable();
    const pool = await getPool();
    let logId = null;

    try {
        // Resolve headerId
        const sesRes = await pool.request()
            .input('sid', sql.Int, sessionId)
            .query('SELECT HeaderId FROM GTP_PicklistSessions WHERE SessionID = @sid');
        const headerId = sesRes.recordset[0]?.HeaderId;
        if (!headerId) throw new Error(`Session ${sessionId} not found`);

        // Build SAP payload
        const payload = await buildDeliveryPayload(sessionId, cardCode);

        // Insert Pending log
        const logRes = await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('hid', sql.NVarChar(50),  headerId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('pl',  sql.NVarChar(sql.MAX), JSON.stringify(payload))
            .query(`
                INSERT INTO GTP_DeliveryLog
                    (SessionID, HeaderId, CardCode, Status, RequestPayload)
                OUTPUT INSERTED.LogID
                VALUES (@sid, @hid, @cc, 'Pending', @pl)
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

        console.log(`✅ SAP Delivery created — DocEntry: ${sapResult.DocEntry}, DocNum: ${sapResult.DocNum}, Party: ${cardCode}`);
        return { success: true, docEntry: sapResult.DocEntry, docNum: sapResult.DocNum };

    } catch (err) {
        console.error(`❌ SAP Delivery failed — Party: ${cardCode} |`, err.message);

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

        return { success: false, error: err.message };
    }
}

// ── Get all delivery log records for a session ────────────────
async function getSessionDeliveries(sessionId) {
    await ensureTable();
    const pool = await getPool();
    const res = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`
            SELECT LogID, CardCode, Status, SapDocEntry, SapDocNum,
                   ErrorMessage, CreatedAt, UpdatedAt
            FROM   GTP_DeliveryLog
            WHERE  SessionID = @sid
            ORDER  BY CreatedAt DESC
        `);
    return res.recordset;
}

module.exports = { triggerPartyDelivery, getSessionDeliveries, buildDeliveryPayload };
