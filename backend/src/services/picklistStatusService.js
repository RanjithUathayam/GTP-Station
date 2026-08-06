const { getPool, sql } = require('../config/db');

// Ensure GTP_DeliveryLog exists before any query that touches it
async function ensureDeliveryTable(pool) {
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

// ── Fetch all sessions with per-party, per-document (DocEntry) delivery detail ──
async function listSessions() {
    const pool = await getPool();
    await ensureDeliveryTable(pool);

    const result = await pool.request().query(`
        SELECT
            S.SessionID,
            S.HeaderId,
            S.Status          AS SessionStatus,
            S.StartedAt,
            S.CompletedAt,
            PP.CardCode,
            PP.TotalQty,
            PP.PickedQty,
            (PP.TotalQty - PP.PickedQty) AS RemainingQty,
            CASE WHEN PP.TotalQty <= PP.PickedQty THEN 'Completed'
                 ELSE 'InProgress' END AS PartyPickStatus,
            DE.DocEntry,
            DE.CardName,
            DL.DeliveryStatus,
            DL.SapDocEntry,
            DL.SapDocNum,
            DL.ErrorMessage   AS DeliveryError,
            DL.UpdatedAt      AS DeliveryUpdatedAt
        FROM GTP_PicklistSessions S
        INNER JOIN (
            SELECT SessionID, CardCode,
                   SUM(RequiredQty) AS TotalQty,
                   SUM(PickedQty)   AS PickedQty
            FROM   GTP_PickProgress
            GROUP  BY SessionID, CardCode
        ) PP ON PP.SessionID = S.SessionID
        -- One row per real SAP order (DocEntry) this party's picklist covers —
        -- OUTER (not CROSS) APPLY so the party still surfaces even if, unexpectedly,
        -- no matching order line is found.
        OUTER APPLY (
            SELECT DISTINCT TD.DocEntry, O.CardName
            FROM   WMS.dbo.Tran_TransDetails TD
            INNER  JOIN BBLive.dbo.ORDR O
                   ON O.DocEntry = TD.DocEntry
                  AND O.CardCode COLLATE DATABASE_DEFAULT = PP.CardCode
            WHERE  TD.HeaderId = S.HeaderId
        ) DE
        LEFT JOIN (
            SELECT SessionID, CardCode, DocEntry,
                   Status       AS DeliveryStatus,
                   SapDocEntry, SapDocNum, ErrorMessage, UpdatedAt,
                   ROW_NUMBER() OVER (
                       PARTITION BY SessionID, CardCode, DocEntry ORDER BY CreatedAt DESC
                   ) AS rn
            FROM   GTP_DeliveryLog
        ) DL ON DL.SessionID = S.SessionID AND DL.CardCode = PP.CardCode
             AND DL.DocEntry = DE.DocEntry AND DL.rn = 1
        ORDER BY S.StartedAt DESC, PP.CardCode, DE.DocEntry
    `);

    // Group flat rows → sessions → parties → documents (one per real DocEntry)
    const sessionMap = new Map();
    for (const row of result.recordset) {
        if (!sessionMap.has(row.SessionID)) {
            sessionMap.set(row.SessionID, {
                sessionId:     row.SessionID,
                headerId:      row.HeaderId,
                sessionStatus: row.SessionStatus,
                startedAt:     row.StartedAt,
                completedAt:   row.CompletedAt,
                partyMap:      new Map(),
            });
        }
        const session = sessionMap.get(row.SessionID);

        if (!session.partyMap.has(row.CardCode)) {
            session.partyMap.set(row.CardCode, {
                cardCode:     row.CardCode,
                cardName:     row.CardName || row.CardCode,
                totalQty:     Number(row.TotalQty),
                pickedQty:    Number(row.PickedQty),
                remainingQty: Number(row.RemainingQty),
                pickStatus:   row.PartyPickStatus,
                documents:    [],
            });
        }
        const party = session.partyMap.get(row.CardCode);
        if (row.DocEntry != null) {
            party.documents.push({
                docEntry:          row.DocEntry,
                deliveryStatus:    row.DeliveryStatus || null,
                sapDocEntry:       row.SapDocEntry    || null,
                sapDocNum:         row.SapDocNum      || null,
                deliveryError:     row.DeliveryError  || null,
                deliveryUpdatedAt: row.DeliveryUpdatedAt || null,
            });
        }
    }

    // Flatten party maps → arrays and compute session-level aggregates
    return Array.from(sessionMap.values()).map(s => {
        const parties      = Array.from(s.partyMap.values());
        const totalQty      = parties.reduce((n, p) => n + p.totalQty,  0);
        const pickedQty     = parties.reduce((n, p) => n + p.pickedQty, 0);
        const totalParties  = parties.length;
        const doneParties   = parties.filter(p => p.pickStatus === 'Completed').length;
        return {
            sessionId:     s.sessionId,
            headerId:      s.headerId,
            sessionStatus: s.sessionStatus,
            startedAt:     s.startedAt,
            completedAt:   s.completedAt,
            parties, totalQty, pickedQty, remainingQty: totalQty - pickedQty,
            totalParties, completedParties: doneParties,
        };
    });
}

module.exports = { listSessions };
