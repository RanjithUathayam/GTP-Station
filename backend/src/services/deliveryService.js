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
}

// ── Format today as YYYY-MM-DD ────────────────────────────────
function today() {
    return new Date().toISOString().slice(0, 10);
}

// ── The party's distinct real SAP orders (DocEntries) for this picklist ──
async function getPartyDocEntries(sessionId, cardCode) {
    const pool = await getPool();

    const sesRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query('SELECT HeaderId FROM GTP_PicklistSessions WHERE SessionID = @sid');
    const headerId = sesRes.recordset[0]?.HeaderId;
    if (!headerId) throw new Error(`Session ${sessionId} not found`);

    const res = await pool.request()
        .input('hid', sql.NVarChar(50), headerId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .query(`
            SELECT DISTINCT TD.DocEntry
            FROM   WMS.dbo.Tran_TransDetails TD
            INNER  JOIN BBLive.dbo.ORDR O
                    ON O.DocEntry = TD.DocEntry
                   AND O.CardCode COLLATE DATABASE_DEFAULT = @cc
            WHERE  TD.HeaderId = @hid
            ORDER  BY TD.DocEntry
        `);
    return { headerId, docEntries: res.recordset.map(r => r.DocEntry) };
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
                ItemQty.ReqQtyForOrder  AS Quantity,
                PP.HeaderId,
                @de                     AS BaseEntry,
                ISNULL(R.LineNum,   0)  AS BaseLine,
                ISNULL(R.Price,     0)  AS UnitPrice,
                ISNULL(R.DiscPrcnt, 0)  AS DiscountPercent,
                ISNULL(R.TaxCode,  '')  AS TaxCode,
                ISNULL(R.WhsCode, '01') AS WarehouseCode
            FROM GTP_PickProgress PP
            INNER JOIN BBLive.dbo.ORDR O
                    ON O.DocEntry = @de
                   AND O.CardCode COLLATE DATABASE_DEFAULT = PP.CardCode
            -- Quantity to bill on THIS order = that order's own required qty from the
            -- WMS picklist (loadPicklistData source), summed across any duplicate lines
            -- for the item within this order. PP.PickedQty/RequiredQty are aggregated
            -- across every order the item appears on for this customer, so they can't
            -- be posted as-is without double-billing an item that spans multiple orders.
            CROSS APPLY (
                SELECT SUM(ISNULL(TD.ReqQty, 0)) AS ReqQtyForOrder
                FROM   WMS.dbo.Tran_TransDetails TD
                WHERE  TD.HeaderId    = PP.HeaderId
                  AND  TD.DocEntry    = @de
                  AND  TD.ProductCode COLLATE DATABASE_DEFAULT = PP.ItemCode
            ) ItemQty
            OUTER APPLY (
                SELECT TOP 1 LineNum, Price, DiscPrcnt, TaxCode, WhsCode
                FROM   BBLive.dbo.RDR1
                WHERE  DocEntry = @de
                  AND  ItemCode COLLATE DATABASE_DEFAULT = PP.ItemCode
                ORDER  BY LineNum
            ) R
            WHERE PP.SessionID = @sid
              AND PP.CardCode  = @cc
              AND PP.Status    = 'Completed'
              AND ItemQty.ReqQtyForOrder > 0
        `);

    if (!result.recordset.length) {
        throw new Error(`No completed items found for party ${cardCode} / order ${docEntry} in session ${sessionId}`);
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
        Comments:   `GTP Station Pick List: ${headerId} | Order: ${docEntry}`,
        DocumentLines: documentLines,
    };
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

        const payload = await buildDeliveryPayload(sessionId, cardCode, docEntry);

        // Insert Pending log
        const logRes = await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('hid', sql.NVarChar(50),  headerId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('pl',  sql.NVarChar(sql.MAX), JSON.stringify(payload))
            .query(`
                INSERT INTO GTP_DeliveryLog
                    (SessionID, HeaderId, CardCode, DocEntry, Status, RequestPayload)
                OUTPUT INSERTED.LogID
                VALUES (@sid, @hid, @cc, @de, 'Pending', @pl)
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

// ── Trigger SAP delivery for a completed party — one document per order ──
// (DocEntry), even though they all belong to the same customer.
async function triggerPartyDeliveries(sessionId, cardCode) {
    const { headerId, docEntries } = await getPartyDocEntries(sessionId, cardCode);
    if (!docEntries.length) {
        console.error(`❌ SAP Delivery skipped — no orders found for party ${cardCode} in session ${sessionId}`);
        return [];
    }

    // Sequential, not parallel — posts against the same SAP session/customer
    // one at a time, which is the safer choice for a live financial system.
    const results = [];
    for (const docEntry of docEntries) {
        results.push(await triggerDocumentDelivery(sessionId, cardCode, docEntry, headerId));
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
            ORDER  BY CreatedAt DESC
        `);
    return res.recordset;
}

module.exports = {
    triggerPartyDeliveries, triggerDocumentDelivery,
    getSessionDeliveries, buildDeliveryPayload,
};
