const { getPool, sql } = require('../config/db');
const { ensureSessionReportColumns } = require('./gtpPickingService');

// mssql/tedious encodes a SQL `DATE` value as a JS Date pinned to UTC midnight for that
// calendar day (no timezone conversion applied) — so it must be read back with the UTC
// getters, not the local ones, or the date can shift by a day depending on server TZ.
function toDateOnlyString(d) {
    if (!d) return null;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ── Main grouped report query ───────────────────────────────────────────────
async function getPickingReport(filters) {
    const pool = await getPool();
    await ensureSessionReportColumns(pool);

    const { fromDate, toDate, stationId, headerId, operatorId } = filters;

    const result = await pool.request()
        .input('FromDate',        sql.Date,          fromDate)
        .input('ToDate',          sql.Date,          toDate)
        .input('StationId',       sql.NVarChar(50),  stationId || null)
        .input('HeaderIdPattern', sql.NVarChar(102), headerId ? `%${headerId}%` : null)
        .input('OperatorId',      sql.Int,           operatorId || null)
        .query(`
            ;WITH FilteredSessions AS (
                SELECT
                    S.SessionID, S.HeaderId, S.Status, S.OperatorID, S.StartedAt, S.CompletedAt, S.TotalOrders,
                    ISNULL(S.StationId, 'UNKNOWN') AS StationId,
                    CAST(S.StartedAt AS DATE)      AS ReportDate
                FROM GTP_PicklistSessions S
                WHERE S.StartedAt >= @FromDate
                  AND S.StartedAt <  DATEADD(DAY, 1, @ToDate)
                  AND (@StationId       IS NULL OR ISNULL(S.StationId, 'UNKNOWN') = @StationId)
                  AND (@HeaderIdPattern IS NULL OR S.HeaderId LIKE @HeaderIdPattern)
                  AND (@OperatorId      IS NULL OR S.OperatorID = @OperatorId)
            ),
            ProgressAgg AS (
                SELECT
                    PP.SessionID,
                    COUNT(CASE WHEN PP.Status = 'Completed' THEN 1 END)                 AS ItemsPicked,
                    SUM(CASE WHEN PP.Status = 'Completed' THEN PP.PickedQty ELSE 0 END) AS PickedQty
                FROM GTP_PickProgress PP
                INNER JOIN FilteredSessions FS ON FS.SessionID = PP.SessionID
                GROUP BY PP.SessionID
            ),
            OperatorAgg AS (
                SELECT DISTINCT FS.ReportDate, FS.StationId,
                    STUFF((
                        SELECT ', ' + O.OperatorName
                        FROM FilteredSessions FS2
                        INNER JOIN GTP_Operators O ON O.OperatorID = FS2.OperatorID
                        WHERE FS2.ReportDate = FS.ReportDate AND FS2.StationId = FS.StationId
                        GROUP BY O.OperatorName
                        FOR XML PATH(''), TYPE
                    ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS OperatorNames
                FROM FilteredSessions FS
            )
            SELECT
                FS.ReportDate                                                       AS ReportDate,
                FS.StationId                                                        AS GtpStation,
                COUNT(DISTINCT FS.SessionID)                                        AS TotalPicklistsProcessed,
                SUM(FS.TotalOrders)                                                 AS TotalOrdersProcessed,
                SUM(ISNULL(PA.ItemsPicked, 0))                                      AS TotalItemsPicked,
                SUM(ISNULL(PA.PickedQty, 0))                                        AS TotalPickedQuantity,
                SUM(CASE WHEN FS.Status = 'Completed'  THEN 1 ELSE 0 END)           AS TotalCompletedPicklists,
                SUM(CASE WHEN FS.Status = 'InProgress' THEN 1 ELSE 0 END)           AS TotalPendingPicklists,
                SUM(CASE WHEN FS.Status = 'Abandoned'  THEN 1 ELSE 0 END)           AS TotalAbandonedPicklists,
                MIN(FS.StartedAt)                                                   AS ProcessingStartTime,
                MAX(CASE WHEN FS.Status = 'Completed' THEN FS.CompletedAt END)      AS ProcessingEndTime,
                SUM(CASE WHEN FS.Status = 'Completed'
                         THEN CAST(DATEDIFF(SECOND, FS.StartedAt, FS.CompletedAt) AS BIGINT)
                         ELSE 0 END)                                                AS TotalProcessingDurationSec,
                OA.OperatorNames
            FROM FilteredSessions FS
            LEFT JOIN ProgressAgg PA ON PA.SessionID  = FS.SessionID
            LEFT JOIN OperatorAgg OA ON OA.ReportDate = FS.ReportDate AND OA.StationId = FS.StationId
            GROUP BY FS.ReportDate, FS.StationId, OA.OperatorNames
            ORDER BY FS.ReportDate, FS.StationId
        `);

    return result.recordset.map(r => {
        const completed = r.TotalCompletedPicklists;
        const durationSec = Number(r.TotalProcessingDurationSec) || 0;
        return {
            reportDate:                     toDateOnlyString(r.ReportDate),
            gtpStation:                     r.GtpStation,
            totalPicklists:                 r.TotalPicklistsProcessed,
            totalOrders:                    r.TotalOrdersProcessed,
            totalItemsPicked:               r.TotalItemsPicked,
            totalPickedQty:                 Number(r.TotalPickedQuantity) || 0,
            completedPicklists:             completed,
            pendingPicklists:               r.TotalPendingPicklists,
            abandonedPicklists:             r.TotalAbandonedPicklists,
            processingStartTime:            r.ProcessingStartTime ? r.ProcessingStartTime.toISOString() : null,
            processingEndTime:              r.ProcessingEndTime   ? r.ProcessingEndTime.toISOString()   : null,
            totalProcessingDurationSeconds: durationSec,
            avgPickingTimeSeconds:          completed > 0 ? durationSec / completed : null,
            operatorNames:                  r.OperatorNames || '',
        };
    });
}

// ── Grand totals across the full (unpaginated) row set ─────────────────────
function computeSummary(rows) {
    const summary = {
        totalStations:      new Set(rows.map(r => r.gtpStation)).size,
        totalPicklists:     0,
        totalOrders:        0,
        totalItemsPicked:   0,
        totalPickedQty:     0,
        completedPicklists: 0,
        pendingPicklists:   0,
        abandonedPicklists: 0,
    };
    for (const r of rows) {
        summary.totalPicklists     += r.totalPicklists;
        summary.totalOrders        += r.totalOrders;
        summary.totalItemsPicked   += r.totalItemsPicked;
        summary.totalPickedQty     += r.totalPickedQty;
        summary.completedPicklists += r.completedPicklists;
        summary.pendingPicklists   += r.pendingPicklists;
        summary.abandonedPicklists += r.abandonedPicklists;
    }
    return summary;
}

// ── Filter option lists ─────────────────────────────────────────────────────
async function getFilterStations() {
    const pool = await getPool();
    await ensureSessionReportColumns(pool);
    const result = await pool.request().query(`
        SELECT DeviceCode AS StationId FROM GTP_AdamDevices WHERE IsActive = 1
        UNION
        SELECT DISTINCT StationId FROM GTP_PicklistSessions WHERE StationId IS NOT NULL
        ORDER BY 1
    `);
    return result.recordset.map(r => r.StationId);
}

async function getFilterOperators() {
    const pool = await getPool();
    const result = await pool.request().query(`
        SELECT OperatorID, OperatorName FROM GTP_Operators WHERE IsActive = 1 ORDER BY OperatorName
    `);
    return result.recordset;
}

module.exports = { getPickingReport, computeSummary, getFilterStations, getFilterOperators };
