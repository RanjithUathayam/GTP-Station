const { getPool, sql } = require('../config/db');
const ws     = require('./websocketService');
const delivery = require('./deliveryService');
const lights = require('./lightControlService');
const boxSvc = require('./boxManagementService');
const { BLOCKING_ERROR_CODES } = require('./adamDeviceManager');

// ── Idempotent schema evolution for report support (StationId/TotalOrders) ───
let _reportColumnsEnsured = false;
async function ensureSessionReportColumns(pool) {
    if (_reportColumnsEnsured) return;
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PicklistSessions') AND name = 'StationId')
            ALTER TABLE GTP_PicklistSessions ADD StationId NVARCHAR(50) NULL;

        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PicklistSessions') AND name = 'TotalOrders')
            ALTER TABLE GTP_PicklistSessions ADD TotalOrders INT NOT NULL DEFAULT 0;
    `);

    // Best-effort, naturally idempotent backfill of StationId for pre-existing rows
    await pool.request().query(`
        IF EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_StationLightStatus')
        UPDATE S SET S.StationId = SL.StationId
        FROM GTP_PicklistSessions S
        INNER JOIN (
            SELECT SessionID, MIN(StationId) AS StationId
            FROM GTP_StationLightStatus
            GROUP BY SessionID
        ) SL ON SL.SessionID = S.SessionID
        WHERE S.StationId IS NULL;
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PicklistSessions_Report')
            CREATE INDEX IX_PicklistSessions_Report ON GTP_PicklistSessions (StartedAt)
                INCLUDE (StationId, OperatorID, Status, HeaderId, CompletedAt, TotalOrders);

        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PickProgress_Report')
            CREATE INDEX IX_PickProgress_Report ON GTP_PickProgress (SessionID) INCLUDE (Status, PickedQty);
    `);

    _reportColumnsEnsured = true;
}

// ── Parse barcode: ITEMCODE|ST|IDVALUE|GROUP|UNIQUENUM|QTY ────
function parseBarcode(raw) {
    const parts = raw.trim().split('|');
    if (parts.length < 1) return null;
    return {
        itemCode:    parts[0] || null,
        scanType:    parts[1] || null,
        idValue:     parts[2] || null,
        itemGroup:   parts[3] || null,
        uniqueNumber:parts[4] || null,
        qty:         parts[5] ? parseFloat(parts[5]) : 1,
    };
}

// ── Load picklist data from WMS + BBLive ──────────────────────
async function loadPicklistData(headerId) {
    const pool = await getPool();
    const result = await pool.request()
        .input('hid', sql.NVarChar(50), headerId)
        .query(`
            SELECT T0.headerid                AS HeaderId,
                T0.docentry                   AS DocEntry,
                T1.cardcode                   AS CardCode,
                T1.cardname                   AS CardName,
                T1.u_arcode                   AS U_Arcode,
                T1.u_brand                    AS U_Brand,
                T0.productcode                AS ProductCode,
                T0.productname                AS ProductName,
                Isnull(T0.orderqty, 0)     AS OrderQty,
                Isnull(T0.reqqty, 0)       AS ReqQty,
                T2.u_salpricecode             AS U_SalPriceCode,
                D.countoforder                AS CountofOrder,
                T4.itmsgrpnam              AS ItemGroupName,
                Ltrim(Rtrim(T3.u_subgrp5)) AS ItemSize,
                T3.u_style                 AS ItemSleeve,
                Ltrim(Rtrim(T3.u_subgrp6)) AS ItemColor,
                T1.u_jointorder AS JoinOrder,
                T1.u_foldngtyp,
                T1.u_packngtyp,
                T1.u_falo,
                T1.shiptocode,
				T3.U_SubGrp3 AS ITEMGROUP,
				T3.U_SubGrp4,
				T3.U_SubGrp7
            FROM   (SELECT DISTINCT headerid,
                                    docentry,
                                    productcode,
                                    productname,
                                    orderqty,
                                    reqqty,
                                    [lineno]
                    FROM   wms.dbo.tran_transdetails
                    WHERE  headerid = @hid) AS T0
                INNER JOIN bblive.dbo.ordr AS T1
                        ON T0.docentry = T1.docentry
                INNER JOIN (SELECT cardcode,
                                    Max(u_salpricecode) AS U_SalPriceCode
                            FROM   bblive.dbo.ocrd
                            GROUP  BY cardcode) AS T2
                        ON T2.cardcode = T1.cardcode
                CROSS JOIN (SELECT Count(DISTINCT TD.docentry) AS CountofOrder
                            FROM   wms.dbo.tran_transdetails TD
                            WHERE  TD.headerid = @hid) AS D
                LEFT JOIN bblive.dbo.oitm AS T3
                        ON T3.itemcode = T0.productcode COLLATE database_default
                LEFT JOIN bblive.dbo.oitb AS T4
                        ON T4.itmsgrpcod = T3.itmsgrpcod
            ORDER  BY T0.docentry 
        `);
    return result.recordset;
}

// ── Start a new picking session ────────────────────────────────
async function startSession(headerId, operatorId, stationId = 'STN-01') {
    const pool = await getPool();
    await ensureSessionReportColumns(pool);
    await boxSvc.ensureBoxTables(pool);

    // Deactivate any existing InProgress session for this picklist
    await pool.request()
        .input('hid', sql.NVarChar(50), headerId)
        .query(`UPDATE GTP_PicklistSessions SET Status='Abandoned'
                WHERE HeaderId=@hid AND Status='InProgress'`);

    const rows = await loadPicklistData(headerId);
    if (!rows.length) throw Object.assign(
        new Error(`Picklist "${headerId}" not found or has no items`),
        { status: 404, code: 'PICKLIST_NOT_FOUND' }
    );

    // Create session — StationId/TotalOrders are snapshotted now so the picking
    // report never needs a live WMS join or a GTP_StationLightStatus lookup.
    const sesRes = await pool.request()
        .input('hid',  sql.NVarChar(50), headerId)
        .input('opid', sql.Int,          operatorId || null)
        .input('stn',  sql.NVarChar(50), stationId  || null)
        .input('ords', sql.Int,          rows[0].CountofOrder || 0)
        .query(`INSERT INTO GTP_PicklistSessions (HeaderId, OperatorID, StationId, TotalOrders)
                OUTPUT INSERTED.SessionID
                VALUES (@hid, @opid, @stn, @ords)`);
    const sessionId = sesRes.recordset[0].SessionID;

    // Seed GTP_PickProgress — one row per CardCode + ProductCode, with RequiredQty
    // summed across every WMS order line for that pair (the same item can appear
    // on more than one line/order for a customer); also aggregate per
    // (CardCode, DocEntry, ItemGroupName) totals for the box-management
    // plan below — box plans are per Sales Order, not per customer.
    const progressTotals = new Map(); // "CardCode|ProductCode" -> { cardCode, itemCode, itemGroupName, docEntry, reqQty }
    const groupTotals = new Map(); // composite key -> { cardCode, docEntry, itemGroupName, totalQty }
    for (const r of rows) {
        const itemGroupName = r.ItemGroupName || 'UNSPECIFIED';

        const key = `${r.CardCode}|${r.ProductCode}`;
        const existingProgress = progressTotals.get(key);
        if (existingProgress) {
            existingProgress.reqQty += Number(r.ReqQty);
        } else {
            progressTotals.set(key, {
                cardCode: r.CardCode, itemCode: r.ProductCode, itemGroupName,
                docEntry: r.DocEntry, reqQty: Number(r.ReqQty),
            });
        }

        const gKey = `${r.CardCode}|${r.DocEntry}|${itemGroupName}`;
        const existingGroup = groupTotals.get(gKey);
        if (existingGroup) {
            existingGroup.totalQty += Number(r.ReqQty);
        } else {
            groupTotals.set(gKey, {
                cardCode: r.CardCode, docEntry: r.DocEntry, itemGroupName, totalQty: Number(r.ReqQty),
            });
        }
    }
    for (const { cardCode, itemCode, itemGroupName, docEntry, reqQty } of progressTotals.values()) {
        await pool.request()
            .input('sid',  sql.Int,           sessionId)
            .input('hid',  sql.NVarChar(50),  headerId)
            .input('cc',   sql.NVarChar(50),  cardCode)
            .input('ic',   sql.NVarChar(50),  itemCode)
            .input('rqty', sql.Decimal(10,2), reqQty)
            .input('ig',   sql.NVarChar(100), itemGroupName)
            .input('de',   sql.Int,           docEntry)
            .query(`INSERT INTO GTP_PickProgress
                        (SessionID, HeaderId, CardCode, ItemCode, RequiredQty, ItemGroupName, DocEntry)
                    VALUES (@sid, @hid, @cc, @ic, @rqty, @ig, @de)`);
    }

    // Build the box plan — one set of boxes per (CardCode, DocEntry, ItemGroupName)
    for (const { cardCode, docEntry, itemGroupName, totalQty } of groupTotals.values()) {
        await boxSvc.createBoxPlanForSession(sessionId, headerId, cardCode, docEntry, itemGroupName, totalQty);
    }

    // Collect unique parties in seeding order for light-channel assignment
    const seenParties = [];
    const seenCodes   = new Set();
    for (const r of rows) {
        if (!seenCodes.has(r.CardCode)) {
            seenCodes.add(r.CardCode);
            seenParties.push({ cardCode: r.CardCode });
        }
    }
    // Awaited so the party→channel mapping is fully persisted before the session is
    // handed back — otherwise a fast first scan can race ahead of this write and fall
    // through to _rebuildMapping()'s fallback path before the real mapping exists.
    try {
        await lights.activatePicklistLights(sessionId, stationId, headerId, seenParties);
    } catch (err) {
        // Missing config / inactive device / MAC mismatch / init failure must fail session
        // start with a clear message; any other (transient hardware/network) error is
        // logged and swallowed as before.
        if (BLOCKING_ERROR_CODES.includes(err.code)) throw err;
        console.error('[LIGHTS] activatePicklistLights error:', err.message);
    }

    ws.broadcast('PICKLIST_STARTED', { sessionId, headerId });

    const session = await getSession(sessionId);

    // Batch-print every box group's first ID label now, before the picker
    // starts filling any box — if this station has an active printer
    // configured, this replaces the picking-shell's own browser-print tab.
    const autoPrintedBoxIds = [];
    for (const party of session.parties) {
        for (const order of party.orders || []) {
            for (const group of order.boxGroups || []) {
                if (group.currentBox && group.currentBox.boxNumber === 1) {
                    const result = await boxSvc.printIdLabelForBox(group.currentBox.boxId);
                    if (result.printed) autoPrintedBoxIds.push(group.currentBox.boxId);
                }
            }
        }
    }
    session.autoPrintedBoxIds = autoPrintedBoxIds;
    return session;
}

// ── Get full session state ─────────────────────────────────────
async function getSession(sessionId) {
    const pool = await getPool();

    const sesRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query('SELECT * FROM GTP_PicklistSessions WHERE SessionID=@sid');
    const session = sesRes.recordset[0];
    if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });

    // StationId is snapshotted on GTP_PicklistSessions at session start; fall back to
    // the light-status side table only for pre-migration sessions that predate that column.
    let stationId = session.StationId || null;
    if (!stationId) {
        const stationRes = await pool.request()
            .input('sid', sql.Int, sessionId)
            .query(`SELECT TOP 1 StationId FROM GTP_StationLightStatus WHERE SessionID=@sid`);
        stationId = stationRes.recordset[0]?.StationId || null;
    }

    const rawRows = await loadPicklistData(session.HeaderId);
    if (!rawRows.length) throw Object.assign(
        new Error(`Picklist "${session.HeaderId}" data unavailable`), { status: 404 }
    );
    const countofOrder = rawRows[0].CountofOrder;
    const joinOrderRow = rawRows.find(r => r.JoinOrder != null && String(r.JoinOrder).trim() !== '');
    const joinOrder    = joinOrderRow ? String(joinOrderRow.JoinOrder).trim() : null;

    const progRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query('SELECT * FROM GTP_PickProgress WHERE SessionID=@sid');
    const progMap = {};
    for (const p of progRes.recordset) progMap[`${p.CardCode}|${p.ItemCode}`] = p;

    const scanLogRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`SELECT CardCode, ItemCode, UniqueNumber, ScannedQty
                FROM GTP_ScanLog WHERE SessionID=@sid ORDER BY ScanID`);
    const scanPartsMap = {};
    for (const s of scanLogRes.recordset) {
        const key = `${s.CardCode}|${s.ItemCode}`;
        if (!scanPartsMap[key]) scanPartsMap[key] = [];
        scanPartsMap[key].push({ uniqueNumber: s.UniqueNumber, qty: Number(s.ScannedQty) });
    }

    // Box plans are per (CardCode, DocEntry, ItemGroupName) — key box groups the
    // same way so each order gets only its own box groups (see `orders` below).
    const boxGroupsList = await boxSvc.getBoxesForSession(sessionId);
    const boxGroupsByPartyOrder = {};
    for (const g of boxGroupsList) {
        const key = `${g.cardCode}|${g.docEntry}`;
        if (!boxGroupsByPartyOrder[key]) boxGroupsByPartyOrder[key] = [];
        boxGroupsByPartyOrder[key].push(g);
    }

    // Group by CardCode (party), DocEntries tracked for orderCount
    const partyMap = {};
    for (const r of rawRows) {
        if (!partyMap[r.CardCode]) {
            partyMap[r.CardCode] = {
                cardCode:     r.CardCode,
                cardName:     r.CardName,
                uArcode:      r.U_Arcode      || '',
                uBrand:       r.U_Brand       || '',
                uSalPriceCode:r.U_SalPriceCode || '',
                docEntries:   new Set(),
                items:        [],
            };
        }
        partyMap[r.CardCode].docEntries.add(r.DocEntry);
        const prog      = progMap[`${r.CardCode}|${r.ProductCode}`] || {};
        const pickedQty = prog.PickedQty != null ? Number(prog.PickedQty) : 0;
        partyMap[r.CardCode].items.push({
            itemCode:     r.ProductCode,
            itemName:     r.ProductName,
            itemGroupName:r.ItemGroupName || '',
            size:         r.ItemSize      || '',
            sleeve:       r.ItemSleeve    || '',
            color:        r.ItemColor    || '',
            docEntry:     r.DocEntry,
            orderQty:     Number(r.OrderQty),
            requiredQty:  Number(r.ReqQty),
            pickedQty,
            uSalPriceCode:r.U_SalPriceCode || '',
            status:       prog.Status || 'Pending',
            scannedParts: scanPartsMap[`${r.CardCode}|${r.ProductCode}`] || [],
        });
    }

    const parties = Object.values(partyMap).map(p => {
        const items       = p.items;
        const totalReq    = items.reduce((s, i) => s + i.requiredQty, 0);
        // PickedQty is stored once per (CardCode, ItemCode) in GTP_PickProgress, but an
        // item can appear as multiple order-line rows (one per DocEntry) when the same
        // item spans several orders for this party — dedupe by itemCode so its picked
        // qty isn't added once per duplicate order line.
        const uniquePicked = new Map();
        items.forEach(i => uniquePicked.set(i.itemCode, i.pickedQty));
        const totalPicked = [...uniquePicked.values()].reduce((s, v) => s + v, 0);
        const allDone     = items.every(i => i.status === 'Completed');
        const anyActive   = items.some(i  => i.status === 'InProgress');

        // Split this party's items by DocEntry (order) — each row already carries
        // its own DocEntry from the WMS join, one row per (DocEntry, ProductCode).
        const orderMap = new Map();
        for (const item of items) {
            if (!orderMap.has(item.docEntry)) orderMap.set(item.docEntry, []);
            orderMap.get(item.docEntry).push(item);
        }
        const orders = [...orderMap.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([docEntry, orderItems]) => {
                const oReq       = orderItems.reduce((s, i) => s + i.requiredQty, 0);
                const oPicked    = orderItems.reduce((s, i) => s + Math.min(i.pickedQty, i.requiredQty), 0);
                const oAllDone   = orderItems.every(i => i.status === 'Completed');
                const oAnyActive = orderItems.some(i => i.status === 'InProgress');
                return {
                    docEntry,
                    totalRequiredQty: oReq,
                    totalPickedQty:   oPicked,
                    status:           oAllDone ? 'completed' : oAnyActive ? 'active' : 'pending',
                    items:            orderItems,
                    boxGroups:        boxGroupsByPartyOrder[`${p.cardCode}|${docEntry}`] || [],
                };
            });

        return {
            cardCode:         p.cardCode,
            cardName:         p.cardName,
            uArcode:          p.uArcode,
            uBrand:           p.uBrand,
            uSalPriceCode:    p.uSalPriceCode,
            orderCount:       p.docEntries.size,
            totalRequiredQty: totalReq,
            totalPickedQty:   totalPicked,
            status:           allDone ? 'completed' : anyActive ? 'active' : 'pending',
            items,
            orders,
        };
    });

    const completedParties = parties.filter(p => p.status === 'completed').length;

    return {
        sessionId,
        headerId:        session.HeaderId,
        stationId,
        countofOrder,
        joinOrder,
        status:          session.Status,
        startedAt:       session.StartedAt,
        parties,
        totalParties:    parties.length,
        completedParties,
    };
}

// ── Process a scan ─────────────────────────────────────────────
async function processScan(sessionId, barcode, cardCode) {
    const pool = await getPool();

    const parsed = parseBarcode(barcode);
    if (!parsed?.itemCode) throw Object.assign(
        new Error('Invalid barcode format'), { status: 400, code: 'INVALID_BARCODE' }
    );

    const sesRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query('SELECT * FROM GTP_PicklistSessions WHERE SessionID=@sid');
    const session = sesRes.recordset[0];
    if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });
    if (session.Status !== 'InProgress') throw Object.assign(
        new Error('Picklist already completed'), { status: 409, code: 'PICKLIST_DONE' }
    );

    // Duplicate scan prevention (same ItemCode + UniqueNumber in this session)
    if (parsed.uniqueNumber) {
        const dupRes = await pool.request()
            .input('sid',  sql.Int,          sessionId)
            .input('ic',   sql.NVarChar(50), parsed.itemCode)
            .input('unum', sql.NVarChar(50), parsed.uniqueNumber)
            .query(`SELECT ScanID FROM GTP_ScanLog
                    WHERE SessionID=@sid AND ItemCode=@ic AND UniqueNumber=@unum`);
        if (dupRes.recordset.length) throw Object.assign(
            new Error(`Uniqueno ${parsed.uniqueNumber} already scanned for ${parsed.itemCode}`),
            { status: 409, code: 'DUPLICATE_SCAN' }
        );
    }

    // Validate item in picklist for this party
    const progRes = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .input('ic',  sql.NVarChar(50), parsed.itemCode)
        .query(`SELECT * FROM GTP_PickProgress
                WHERE SessionID=@sid AND CardCode=@cc AND ItemCode=@ic`);
    const prog = progRes.recordset[0];
    if (!prog) throw Object.assign(
        new Error(`Item "${parsed.itemCode}" not in picklist for this party`),
        { status: 404, code: 'ITEM_NOT_IN_PICKLIST' }
    );
    if (prog.Status === 'Completed') throw Object.assign(
        new Error(`Item "${parsed.itemCode}" already completed`),
        { status: 409, code: 'ITEM_ALREADY_DONE' }
    );

    // Cap qty to remaining
    const remaining = prog.RequiredQty - prog.PickedQty;
    const scanQty   = Math.min(parsed.qty, remaining);
    const newPicked = prog.PickedQty + scanQty;
    const itemDone  = newPicked >= prog.RequiredQty;

    // Update progress
    await pool.request()
        .input('qty',  sql.Decimal(10,2), newPicked)
        .input('st',   sql.NVarChar(20),  itemDone ? 'Completed' : 'InProgress')
        .input('sid',  sql.Int,           sessionId)
        .input('cc',   sql.NVarChar(50),  cardCode)
        .input('ic',   sql.NVarChar(50),  parsed.itemCode)
        .query(`UPDATE GTP_PickProgress
                SET PickedQty=@qty, Status=@st, UpdatedAt=GETDATE()
                WHERE SessionID=@sid AND CardCode=@cc AND ItemCode=@ic`);

    // Log scan
    const scanInsertRes = await pool.request()
        .input('sid',  sql.Int,           sessionId)
        .input('hid',  sql.NVarChar(50),  session.HeaderId)
        .input('cc',   sql.NVarChar(50),  cardCode)
        .input('ic',   sql.NVarChar(50),  parsed.itemCode)
        .input('st',   sql.NVarChar(10),  parsed.scanType)
        .input('idv',  sql.NVarChar(100), parsed.idValue)
        .input('grp',  sql.NVarChar(50),  parsed.itemGroup)
        .input('unum', sql.NVarChar(50),  parsed.uniqueNumber)
        .input('qty',  sql.Decimal(10,2), scanQty)
        .query(`INSERT INTO GTP_ScanLog
                    (SessionID, HeaderId, CardCode, ItemCode, ScanType,
                     IDValue, ItemGroup, UniqueNumber, ScannedQty)
                OUTPUT INSERTED.ScanID
                VALUES (@sid, @hid, @cc, @ic, @st, @idv, @grp, @unum, @qty)`);
    const scanId = scanInsertRes.recordset[0].ScanID;

    // Route the picked qty into this item's Sales Order + item-group box plan
    const { completedBoxes, firstBoxId, nextActivatedBox } = await boxSvc.applyScanQtyToBoxes(
        sessionId, cardCode, prog.DocEntry, prog.ItemGroupName, scanQty,
    );
    if (firstBoxId != null) {
        await pool.request()
            .input('bid',  sql.Int, firstBoxId)
            .input('scid', sql.Int, scanId)
            .query(`UPDATE GTP_ScanLog SET BoxID=@bid WHERE ScanID=@scid`);
    }
    completedBoxes.forEach(b => ws.broadcast('BOX_COMPLETED', { sessionId, ...b }));

    // The next box just went Active — print its ID label before the picker
    // starts filling it; picking-shell skips its own browser-print tab when
    // this reports true (station has an active printer configured).
    if (nextActivatedBox) {
        const printResult = await boxSvc.printIdLabelForBox(nextActivatedBox.boxId);
        nextActivatedBox.autoPrinted = printResult.printed;
    }

    // Check party completion
    const partyProgRes = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .query(`SELECT Status FROM GTP_PickProgress
                WHERE SessionID=@sid AND CardCode=@cc`);
    const partyDone = partyProgRes.recordset.every(r => r.Status === 'Completed');

    // Check picklist completion
    const allProgRes = await pool.request()
        .input('sid', sql.Int, sessionId)
        .query(`SELECT Status FROM GTP_PickProgress WHERE SessionID=@sid`);
    const picklistDone = allProgRes.recordset.every(r => r.Status === 'Completed');

    if (picklistDone) {
        await pool.request()
            .input('sid', sql.Int, sessionId)
            .query(`UPDATE GTP_PicklistSessions
                    SET Status='Completed', CompletedAt=GETDATE()
                    WHERE SessionID=@sid`);
        ws.broadcast('PICKLIST_COMPLETED', { sessionId, headerId: session.HeaderId });
        // All parties done — turn OFF all channels
        lights.resetStationLights(sessionId)
            .catch(err => console.error('[LIGHTS] resetStationLights error:', err.message));
        delivery.triggerPartyDeliveries(sessionId, cardCode)
            .catch(err => console.error('SAP delivery trigger error:', err.message));
    } else if (partyDone) {
        ws.broadcast('PARTY_COMPLETED', { sessionId, cardCode });
        // This party is done — turn OFF its channel only
        lights.handlePartyComplete(sessionId, cardCode)
            .catch(err => console.error('[LIGHTS] handlePartyComplete error:', err.message));
        delivery.triggerPartyDeliveries(sessionId, cardCode)
            .catch(err => console.error('SAP delivery trigger error:', err.message));
    } else {
        // Spotlight: turn ON only this party's channel, all others OFF
        lights.setActivePartyLight(sessionId, cardCode)
            .catch(err => console.error('[LIGHTS] setActivePartyLight error:', err.message));
    }

    ws.broadcast('ITEM_PICKED', {
        sessionId, cardCode,
        itemCode: parsed.itemCode,
        scannedQty: scanQty,
        newPickedQty: newPicked,
        itemCompleted: itemDone,
    });

    // Find next pending item for this party
    const nextItemRes = await pool.request()
        .input('sid', sql.Int,          sessionId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .query(`SELECT TOP 1 ItemCode FROM GTP_PickProgress
                WHERE SessionID=@sid AND CardCode=@cc AND Status<>'Completed'
                ORDER BY ItemCode`);
    const nextItemCode = nextItemRes.recordset[0]?.ItemCode || null;

    return {
        itemCode:         parsed.itemCode,
        scannedQty:       scanQty,
        newPickedQty:     newPicked,
        requiredQty:      prog.RequiredQty,
        itemCompleted:    itemDone,
        partyCompleted:   partyDone,
        picklistCompleted:picklistDone,
        nextItemCode,
        completedBoxes,
        nextActivatedBox,
    };
}

// ── Resume an existing session ─────────────────────────────────
async function resumeSession(headerId) {
    const pool = await getPool();
    const res = await pool.request()
        .input('hid', sql.NVarChar(50), headerId)
        .query(`SELECT TOP 1 * FROM GTP_PicklistSessions
                WHERE HeaderId=@hid AND Status='InProgress'
                ORDER BY StartedAt DESC`);
    return res.recordset[0] || null;
}

module.exports = {
    startSession, getSession, processScan, resumeSession, loadPicklistData,
    ensureSessionReportColumns,
};
