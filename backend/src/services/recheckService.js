const { getPool, sql } = require('../config/db');
const ws       = require('./websocketService');
const lights   = require('./lightControlService');
const boxSvc   = require('./boxManagementService');
const delivery = require('./deliveryService');
const logger   = require('../utils/logger');

// ════════════════════════════════════════════════════════════════════
// Picklist Recheck — reset & re-pick
//
// Rolls a Customer + Sales Order + Ship-To group (CardCode + DocEntry), or a single item
// within it, back to "not picked" so the operator can pick it again from scratch:
//   • its GTP_ScanLog rows move to GTP_RecheckScanArchive (so the same UniqueNumbers can be
//     scanned again — processScan's duplicate check only looks at GTP_ScanLog)
//   • its GTP_PickProgress rows go back to PickedQty=0 / Pending
//   • the affected item groups' box plans are re-filled from the scans that remain
//   • any OnHold/Failed SAP delivery for the group is Cancelled (it's re-held on re-completion)
//   • a Completed session is reopened, and the group's light is switched back on
// A group whose SAP Delivery Note is already posted can't be reset — re-picking it would post
// a second Delivery Note for the same order. Every reset is recorded in GTP_RecheckLog.
// ════════════════════════════════════════════════════════════════════

let _tablesEnsured = false;
async function ensureRecheckTables(pool) {
    if (_tablesEnsured) return;
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_RecheckLog')
        CREATE TABLE GTP_RecheckLog (
            RecheckID    INT IDENTITY(1,1) PRIMARY KEY,
            SessionID    INT            NOT NULL,
            HeaderId     NVARCHAR(50)   NOT NULL,
            CardCode     NVARCHAR(50)   NOT NULL,
            DocEntry     INT            NOT NULL,
            SalesOrderNo NVARCHAR(50)   NULL,
            ItemCode     NVARCHAR(50)   NULL,     -- NULL = the whole group was reset
            ResetQty     DECIMAL(10,2)  NOT NULL DEFAULT 0,
            ResetScans   INT            NOT NULL DEFAULT 0,
            Reason       NVARCHAR(255)  NULL,
            OperatorID   INT            NULL,
            CreatedAt    DATETIME       NOT NULL DEFAULT GETDATE()
        );
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RecheckLog_Session')
            CREATE INDEX IX_RecheckLog_Session ON GTP_RecheckLog (SessionID, CardCode, DocEntry);
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_RecheckScanArchive')
        CREATE TABLE GTP_RecheckScanArchive (
            ArchiveID    INT IDENTITY(1,1) PRIMARY KEY,
            RecheckID    INT            NOT NULL,
            ScanID       INT            NOT NULL,   -- original GTP_ScanLog.ScanID
            SessionID    INT            NOT NULL,
            HeaderId     NVARCHAR(50)   NOT NULL,
            CardCode     NVARCHAR(50)   NOT NULL,
            ItemCode     NVARCHAR(50)   NOT NULL,
            ScanType     NVARCHAR(10)   NULL,
            IDValue      NVARCHAR(100)  NULL,
            ItemGroup    NVARCHAR(50)   NULL,
            UniqueNumber NVARCHAR(50)   NULL,
            ScannedQty   DECIMAL(10,2)  NOT NULL,
            BoxID        INT            NULL,
            DocEntry     INT            NULL,
            ScannedAt    DATETIME       NOT NULL,
            ArchivedAt   DATETIME       NOT NULL DEFAULT GETDATE()
        );
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_RecheckScanArchive_Recheck')
            CREATE INDEX IX_RecheckScanArchive_Recheck ON GTP_RecheckScanArchive (RecheckID);
    `);
    _tablesEnsured = true;
}

// Pure part of rebuildBoxPlan: replays `scans` (ScanID order) into the boxes not in
// `keptClosed`, filling each to its target before spilling into the next. Returns each box's
// new picked qty + status (first non-full box Active, the rest Pending) and the box each scan
// now starts in.
function computeRefill(boxes, scans, keptClosed) {
    const fill = boxes
        .filter(b => !keptClosed.has(b.BoxID))
        .map(b => ({ boxId: b.BoxID, target: Number(b.TargetQty), picked: 0, status: 'Pending' }));
    const scanBox = new Map();   // ScanID -> BoxID it now starts in
    let idx = 0;
    for (const scan of scans) {
        if (keptClosed.has(scan.BoxID)) continue;   // stays in its sealed box
        let remaining = Number(scan.ScannedQty);
        let firstBoxId = null;
        while (remaining > 0 && idx < fill.length) {
            const box   = fill[idx];
            const space = box.target - box.picked;
            if (space <= 0) { idx++; continue; }
            const portion = Math.min(remaining, space);
            box.picked += portion;
            remaining  -= portion;
            if (firstBoxId == null) firstBoxId = box.boxId;
            if (box.picked >= box.target) idx++;
        }
        scanBox.set(scan.ScanID, firstBoxId);
    }

    let activeAssigned = false;
    for (const box of fill) {
        if (box.picked >= box.target) box.status = 'Completed';
        else if (!activeAssigned) { box.status = 'Active'; activeAssigned = true; }
    }
    return { fill, scanBox };
}

// Re-fills one (CardCode, DocEntry, ItemGroup) box plan from the scans still in GTP_ScanLog,
// in scan order, using the same sequential fill as boxManagementService.applyScanQtyToBoxes —
// so the result is exactly what the boxes would hold had the reset scans never happened, and
// each remaining scan's BoxID (used by the Box Contents label) is re-pointed to match.
// A box the operator closed manually is left closed if none of the reset scans were in it —
// it's physically sealed; otherwise it's re-opened and re-filled like the rest.
async function rebuildBoxPlan(tx, sessionId, cardCode, docEntry, itemGroupName, resetBoxIds) {
    const boxRes = await new sql.Request(tx)
        .input('sid', sql.Int,           sessionId)
        .input('cc',  sql.NVarChar(50),  cardCode)
        .input('de',  sql.Int,           docEntry)
        .input('ig',  sql.NVarChar(100), itemGroupName)
        .query(`SELECT BoxID, BoxNumber, TargetQty, PickedQty, Status, CompletionMethod
                FROM GTP_PickBoxes
                WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig
                ORDER BY BoxNumber`);
    const boxes = boxRes.recordset;
    if (!boxes.length) return;

    const keptClosed = new Set(
        boxes.filter(b => b.Status === 'Completed' && b.CompletionMethod === 'Manual' && !resetBoxIds.has(b.BoxID))
             .map(b => b.BoxID)
    );

    const scanRes = await new sql.Request(tx)
        .input('sid', sql.Int,           sessionId)
        .input('cc',  sql.NVarChar(50),  cardCode)
        .input('de',  sql.Int,           docEntry)
        .input('ig',  sql.NVarChar(100), itemGroupName)
        .query(`SELECT S.ScanID, S.ScannedQty, S.BoxID
                FROM GTP_ScanLog S
                INNER JOIN GTP_PickProgress P
                        ON P.SessionID = S.SessionID AND P.CardCode = S.CardCode
                       AND P.ItemCode  = S.ItemCode  AND P.DocEntry = S.DocEntry
                WHERE S.SessionID=@sid AND S.CardCode=@cc AND S.DocEntry=@de AND P.ItemGroupName=@ig
                ORDER BY S.ScanID`);

    const { fill, scanBox } = computeRefill(boxes, scanRes.recordset, keptClosed);
    for (const box of fill) {
        await new sql.Request(tx)
            .input('bid', sql.Int,           box.boxId)
            .input('pq',  sql.Decimal(10,2), box.picked)
            .input('st',  sql.NVarChar(20),  box.status)
            .query(`UPDATE GTP_PickBoxes
                    SET PickedQty=@pq, Status=@st,
                        CompletionMethod      = CASE WHEN @st='Completed' THEN ISNULL(CompletionMethod,'Auto') ELSE NULL END,
                        CompletedAt           = CASE WHEN @st='Completed' THEN ISNULL(CompletedAt, GETDATE()) ELSE NULL END,
                        CompletedByOperatorID = CASE WHEN @st='Completed' THEN CompletedByOperatorID ELSE NULL END
                    WHERE BoxID=@bid`);
    }

    for (const [scanId, boxId] of scanBox) {
        await new sql.Request(tx)
            .input('scid', sql.Int, scanId)
            .input('bid',  sql.Int, boxId)
            .query(`UPDATE GTP_ScanLog SET BoxID=@bid WHERE ScanID=@scid`);
    }
}

// ── Reset a group (or one item in it) for re-picking ──────────────────────
async function resetForRepick(sessionId, { cardCode, docEntry, itemCode = null, reason = null, operatorId = null }) {
    const pool = await getPool();
    await boxSvc.ensureBoxTables(pool);
    await delivery.ensureTable();
    await ensureRecheckTables(pool);

    const sesRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query('SELECT * FROM GTP_PicklistSessions WHERE SessionID=@sid');
    const session = sesRes.recordset[0];
    if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });
    if (session.Status === 'Abandoned') throw Object.assign(
        new Error('This picking session was abandoned — load the picklist again to recheck it'),
        { status: 409, code: 'SESSION_ABANDONED' }
    );

    // Another InProgress session for the same picklist means this one is stale — reopening
    // it would leave two live sessions for one picklist.
    if (session.Status === 'Completed') {
        const liveRes = await pool.request()
            .input('hid', sql.NVarChar(50), session.HeaderId)
            .input('sid', sql.Int,          sessionId)
            .query(`SELECT TOP 1 SessionID FROM GTP_PicklistSessions
                    WHERE HeaderId=@hid AND Status='InProgress' AND SessionID<>@sid`);
        if (liveRes.recordset.length) throw Object.assign(
            new Error(`Picklist ${session.HeaderId} is being picked in another session (#${liveRes.recordset[0].SessionID}) — recheck that one instead`),
            { status: 409, code: 'NEWER_SESSION_EXISTS' }
        );
    }

    const latest = await delivery.getLatestDelivery(sessionId, cardCode, docEntry);
    if (latest?.Status === 'Success') throw Object.assign(
        new Error(`SAP Delivery #${latest.SapDocNum ?? latest.SapDocEntry} is already posted for this order — cancel it in SAP before re-picking`),
        { status: 409, code: 'DELIVERY_ALREADY_POSTED' }
    );
    // Pending = an SAP call started and never logged its outcome (in flight, or the server
    // stopped mid-call). It may already exist in SAP, so it must be resolved first.
    if (latest?.Status === 'Pending') throw Object.assign(
        new Error('This order\'s SAP posting is still Pending — let it finish, or post it again from Delivery Status, before re-picking'),
        { status: 409, code: 'DELIVERY_IN_PROGRESS' }
    );

    const progReq = pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('de',  sql.Int,          docEntry);
    if (itemCode) progReq.input('ic', sql.NVarChar(50), itemCode);
    const progRes = await progReq.query(`
        SELECT ItemCode, ItemGroupName, PickedQty, SalesOrderNo FROM GTP_PickProgress
        WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de ${itemCode ? 'AND ItemCode=@ic' : ''}`);
    const targets = progRes.recordset;
    if (!targets.length) throw Object.assign(
        new Error(itemCode
            ? `Item "${itemCode}" is not in order ${docEntry} for this party`
            : `Order ${docEntry} for party ${cardCode} is not in this session`),
        { status: 404, code: 'NOT_IN_SESSION' }
    );
    const resetQty = targets.reduce((s, t) => s + Number(t.PickedQty), 0);
    if (resetQty <= 0) throw Object.assign(
        new Error(itemCode ? `Item "${itemCode}" has nothing picked yet — nothing to reset` : 'Nothing picked in this order yet — nothing to reset'),
        { status: 409, code: 'NOTHING_TO_RESET' }
    );

    const itemFilter = itemCode ? 'AND ItemCode=@ic' : '';
    const scoped = (req) => {
        req.input('sid', sql.Int,          sessionId)
           .input('cc',  sql.NVarChar(50), cardCode)
           .input('de',  sql.Int,          docEntry);
        if (itemCode) req.input('ic', sql.NVarChar(50), itemCode);
        return req;
    };

    const tx = new sql.Transaction(pool);
    await tx.begin();
    let recheckId, resetScans;
    try {
        const scanStatRes = await scoped(new sql.Request(tx)).query(`
            SELECT ScanID, BoxID FROM GTP_ScanLog
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de ${itemFilter}`);
        resetScans = scanStatRes.recordset.length;
        const resetBoxIds = new Set(scanStatRes.recordset.map(r => r.BoxID).filter(id => id != null));

        const logRes = await new sql.Request(tx)
            .input('sid',  sql.Int,           sessionId)
            .input('hid',  sql.NVarChar(50),  session.HeaderId)
            .input('cc',   sql.NVarChar(50),  cardCode)
            .input('de',   sql.Int,           docEntry)
            .input('son',  sql.NVarChar(50),  targets[0].SalesOrderNo || null)
            .input('ic',   sql.NVarChar(50),  itemCode)
            .input('rq',   sql.Decimal(10,2), resetQty)
            .input('rs',   sql.Int,           resetScans)
            .input('rsn',  sql.NVarChar(255), reason ? String(reason).slice(0, 255) : null)
            .input('opid', sql.Int,           operatorId)
            .query(`INSERT INTO GTP_RecheckLog
                        (SessionID, HeaderId, CardCode, DocEntry, SalesOrderNo, ItemCode, ResetQty, ResetScans, Reason, OperatorID)
                    OUTPUT INSERTED.RecheckID
                    VALUES (@sid, @hid, @cc, @de, @son, @ic, @rq, @rs, @rsn, @opid)`);
        recheckId = logRes.recordset[0].RecheckID;

        await scoped(new sql.Request(tx)).input('rid', sql.Int, recheckId).query(`
            INSERT INTO GTP_RecheckScanArchive
                (RecheckID, ScanID, SessionID, HeaderId, CardCode, ItemCode, ScanType, IDValue,
                 ItemGroup, UniqueNumber, ScannedQty, BoxID, DocEntry, ScannedAt)
            SELECT @rid, ScanID, SessionID, HeaderId, CardCode, ItemCode, ScanType, IDValue,
                   ItemGroup, UniqueNumber, ScannedQty, BoxID, DocEntry, ScannedAt
            FROM GTP_ScanLog
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de ${itemFilter};

            DELETE FROM GTP_ScanLog
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de ${itemFilter};

            UPDATE GTP_PickProgress
            SET PickedQty=0, Status='Pending', UpdatedAt=GETDATE()
            WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de ${itemFilter};`);

        const itemGroups = [...new Set(targets.map(t => t.ItemGroupName || 'UNSPECIFIED'))];
        for (const ig of itemGroups) {
            await rebuildBoxPlan(tx, sessionId, cardCode, docEntry, ig, resetBoxIds);
        }

        await new sql.Request(tx)
            .input('sid', sql.Int,           sessionId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('msg', sql.NVarChar(sql.MAX), `Cancelled by Picklist Recheck #${recheckId}`)
            .query(`UPDATE GTP_DeliveryLog SET Status='Cancelled', ErrorMessage=@msg, UpdatedAt=GETDATE()
                    WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND Status IN ('OnHold','Failed')`);

        await new sql.Request(tx)
            .input('sid', sql.Int, sessionId)
            .query(`UPDATE GTP_PicklistSessions SET Status='InProgress', CompletedAt=NULL
                    WHERE SessionID=@sid AND Status='Completed'`);

        await tx.commit();
    } catch (err) {
        try { await tx.rollback(); } catch (_) { /* already rolled back by the failed statement */ }
        throw err;
    }

    logger.info(`[RECHECK] #${recheckId} session=${sessionId} group=${cardCode}|${docEntry}`
        + `${itemCode ? ` item=${itemCode}` : ''} — reset ${resetQty} qty / ${resetScans} scan(s)`);

    // The group is pending again — light it so the operator re-picks into the right bin.
    lights.setActiveGroupLight(sessionId, cardCode, docEntry)
        .catch(err => logger.error(`[RECHECK] setActiveGroupLight error: ${err.message}`));

    ws.broadcast('PICKLIST_RECHECK', { sessionId, headerId: session.HeaderId, cardCode, docEntry, itemCode, recheckId });

    return {
        recheckId, cardCode, docEntry, itemCode, resetQty, resetScans,
        sessionReopened: session.Status === 'Completed',
    };
}

// ── Reset history for a session (audit trail shown in the recheck dialog) ──
async function getRecheckHistory(sessionId) {
    const pool = await getPool();
    await ensureRecheckTables(pool);
    const res = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`SELECT RecheckID, CardCode, DocEntry, SalesOrderNo, ItemCode, ResetQty, ResetScans,
                       Reason, OperatorID, CreatedAt
                FROM GTP_RecheckLog WHERE SessionID=@sid
                ORDER BY CreatedAt DESC, RecheckID DESC`);
    return res.recordset.map(r => ({
        recheckId:    r.RecheckID,
        cardCode:     r.CardCode,
        docEntry:     r.DocEntry,
        salesOrderNo: r.SalesOrderNo,
        itemCode:     r.ItemCode,
        resetQty:     Number(r.ResetQty),
        resetScans:   r.ResetScans,
        reason:       r.Reason,
        operatorId:   r.OperatorID,
        createdAt:    r.CreatedAt,
    }));
}

module.exports = { resetForRepick, getRecheckHistory, ensureRecheckTables, computeRefill };
