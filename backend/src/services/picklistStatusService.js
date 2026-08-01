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

// ── Fetch all sessions with per-party delivery detail ────────
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
            -- CardName via WMS → BBLive lookup
            (
                SELECT TOP 1 O2.CardName
                FROM   WMS.dbo.Tran_TransDetails TD2
                INNER  JOIN BBLive.dbo.ORDR O2
                       ON O2.DocEntry = TD2.DocEntry
                      AND O2.CardCode COLLATE DATABASE_DEFAULT = PP.CardCode
                WHERE  TD2.HeaderId = S.HeaderId
            )                 AS CardName,
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
        LEFT JOIN (
            SELECT DL1.SessionID, DL1.CardCode,
                   DL1.Status       AS DeliveryStatus,
                   DL1.SapDocEntry,
                   DL1.SapDocNum,
                   DL1.ErrorMessage,
                   DL1.UpdatedAt
            FROM   GTP_DeliveryLog DL1
            WHERE  DL1.LogID = (
                SELECT TOP 1 LogID
                FROM   GTP_DeliveryLog DL2
                WHERE  DL2.SessionID = DL1.SessionID
                   AND DL2.CardCode  = DL1.CardCode
                ORDER  BY DL2.CreatedAt DESC
            )
        ) DL ON DL.SessionID = S.SessionID AND DL.CardCode = PP.CardCode
        ORDER BY S.StartedAt DESC
    `);

    // Group flat rows → sessions with nested parties array
    const sessionMap = new Map();
    for (const row of result.recordset) {
        if (!sessionMap.has(row.SessionID)) {
            sessionMap.set(row.SessionID, {
                sessionId:     row.SessionID,
                headerId:      row.HeaderId,
                sessionStatus: row.SessionStatus,
                startedAt:     row.StartedAt,
                completedAt:   row.CompletedAt,
                parties:       [],
            });
        }
        sessionMap.get(row.SessionID).parties.push({
            cardCode:          row.CardCode,
            cardName:          row.CardName || row.CardCode,
            totalQty:          Number(row.TotalQty),
            pickedQty:         Number(row.PickedQty),
            remainingQty:      Number(row.RemainingQty),
            pickStatus:        row.PartyPickStatus,
            deliveryStatus:    row.DeliveryStatus || null,
            sapDocEntry:       row.SapDocEntry    || null,
            sapDocNum:         row.SapDocNum      || null,
            deliveryError:     row.DeliveryError  || null,
            deliveryUpdatedAt: row.DeliveryUpdatedAt || null,
        });
    }

    // Compute session-level aggregates
    return Array.from(sessionMap.values()).map(s => {
        const totalQty     = s.parties.reduce((n, p) => n + p.totalQty,  0);
        const pickedQty    = s.parties.reduce((n, p) => n + p.pickedQty, 0);
        const totalParties = s.parties.length;
        const doneParties  = s.parties.filter(p => p.pickStatus === 'Completed').length;
        return { ...s, totalQty, pickedQty, remainingQty: totalQty - pickedQty,
                 totalParties, completedParties: doneParties };
    });
}

module.exports = { listSessions };
