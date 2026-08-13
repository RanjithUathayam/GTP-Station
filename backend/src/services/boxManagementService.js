const { getPool, sql } = require('../config/db');
const logger = require('../utils/logger');
const printerSvc = require('./printerService');

const COMPANY_NAME = process.env.COMPANY_NAME || 'UATHAYAM';

// ── Idempotent schema evolution for box management ────────────
let _tablesEnsured = false;
async function ensureBoxTables(pool) {
    if (_tablesEnsured) return;

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_PickBoxes')
        CREATE TABLE GTP_PickBoxes (
            BoxID                  INT IDENTITY(1,1) PRIMARY KEY,
            SessionID              INT           NOT NULL,
            HeaderId               NVARCHAR(50)  NOT NULL,
            CardCode               NVARCHAR(50)  NOT NULL,
            ItemGroupName          NVARCHAR(100) NOT NULL,
            BoxNumber              INT           NOT NULL,
            TargetQty              DECIMAL(10,2) NOT NULL,
            PickedQty              DECIMAL(10,2) NOT NULL DEFAULT 0,
            Status                 NVARCHAR(20)  NOT NULL DEFAULT 'Pending',
            CompletionMethod       NVARCHAR(10)  NULL,
            CompletedAt            DATETIME      NULL,
            CompletedByOperatorID  INT           NULL,
            BoxCode                NVARCHAR(150) NOT NULL,
            CreatedAt              DATETIME      NOT NULL DEFAULT GETDATE(),
            CONSTRAINT UQ_PickBoxes_Slot UNIQUE (SessionID, CardCode, ItemGroupName, BoxNumber),
            CONSTRAINT UQ_PickBoxes_Code UNIQUE (BoxCode)
        );
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PickBoxes_Session')
            CREATE INDEX IX_PickBoxes_Session ON GTP_PickBoxes (SessionID, CardCode, ItemGroupName);
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PickProgress') AND name = 'ItemGroupName')
            ALTER TABLE GTP_PickProgress ADD ItemGroupName NVARCHAR(100) NULL;
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PickProgress') AND name = 'DocEntry')
            ALTER TABLE GTP_PickProgress ADD DocEntry INT NULL;
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_ScanLog') AND name = 'BoxID')
            ALTER TABLE GTP_ScanLog ADD BoxID INT NULL;
    `);

    // Box plans are now per (Session, CardCode, DocEntry, ItemGroupName) — every
    // Sales Order gets its own "Box 1", so DocEntry must join the unique key.
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PickBoxes') AND name = 'DocEntry')
            ALTER TABLE GTP_PickBoxes ADD DocEntry INT NULL;
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('GTP_PickBoxes') AND name = 'BoxTypeID')
            ALTER TABLE GTP_PickBoxes ADD BoxTypeID INT NULL;
    `);

    // Drop whatever the old 4-column (SessionID, CardCode, ItemGroupName,
    // BoxNumber) unique constraint is actually named — found by its shape, not
    // a hardcoded name, since it was created as 'UQ_PickBoxes' by schema.sql on
    // some installs and 'UQ_PickBoxes_Slot' by this function on others. Safe on
    // existing data: it already guaranteed no duplicates among old rows, so
    // adding a uniform NULL DocEntry to all of them can't collide.
    const oldConRes = await pool.request().query(`
        SELECT kc.name AS ConstraintName
        FROM sys.key_constraints kc
        INNER JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.name = kc.name
        WHERE kc.parent_object_id = OBJECT_ID('GTP_PickBoxes')
          AND kc.type = 'UQ'
          AND kc.name <> 'UQ_PickBoxes_SlotV2'
          AND (SELECT COUNT(*) FROM sys.index_columns ic
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id) = 4
          AND NOT EXISTS (
              SELECT 1 FROM sys.index_columns ic
              INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                AND c.name = 'DocEntry'
          )
    `);
    const oldConstraintName = oldConRes.recordset[0]?.ConstraintName;
    if (oldConstraintName) {
        // Not user input — this name always comes straight out of sys.key_constraints.
        const bracketed = `[${oldConstraintName.replace(/]/g, ']]')}]`;
        await pool.request().query(`ALTER TABLE GTP_PickBoxes DROP CONSTRAINT ${bracketed}`);
    }

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_PickBoxes_SlotV2')
            ALTER TABLE GTP_PickBoxes ADD CONSTRAINT UQ_PickBoxes_SlotV2
                UNIQUE (SessionID, CardCode, DocEntry, ItemGroupName, BoxNumber);
    `);

    // GTP_PickProgress used to key one row per (SessionID, CardCode, ItemCode),
    // aggregating an item's qty across every Sales Order it appeared on for that
    // customer. That collapsed split orders into one row, so box routing (keyed
    // by DocEntry) and per-order progress totals attributed picks to the wrong
    // order. Widen the key to include DocEntry — same pattern as
    // UQ_PickBoxes_SlotV2 above — so a split item gets one row per order. Safe on
    // existing data: the old key already guaranteed no duplicates among old rows.
    const oldProgConRes = await pool.request().query(`
        SELECT kc.name AS ConstraintName
        FROM sys.key_constraints kc
        INNER JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.name = kc.name
        WHERE kc.parent_object_id = OBJECT_ID('GTP_PickProgress')
          AND kc.type = 'UQ'
          AND kc.name <> 'UQ_PickProgress_V2'
          AND (SELECT COUNT(*) FROM sys.index_columns ic
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id) = 3
          AND NOT EXISTS (
              SELECT 1 FROM sys.index_columns ic
              INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
                AND c.name = 'DocEntry'
          )
    `);
    const oldProgConstraintName = oldProgConRes.recordset[0]?.ConstraintName;
    if (oldProgConstraintName) {
        const bracketed = `[${oldProgConstraintName.replace(/]/g, ']]')}]`;
        await pool.request().query(`ALTER TABLE GTP_PickProgress DROP CONSTRAINT ${bracketed}`);
    }

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_PickProgress_V2')
            ALTER TABLE GTP_PickProgress ADD CONSTRAINT UQ_PickProgress_V2
                UNIQUE (SessionID, CardCode, ItemCode, DocEntry);
    `);

    // Global, sequential, human-readable Box Number (BX000001, BX000002, ...) —
    // unique across every picklist ever run, not just the current session.
    // Stored directly in BoxCode (already the label/QR identifier column).
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.sequences WHERE name = 'GTP_BoxNumberSeq')
            CREATE SEQUENCE GTP_BoxNumberSeq AS INT START WITH 1 INCREMENT BY 1;
    `);

    // ── Box Types + capacity matrix (a physical box holds a different qty per
    // Item Group). This matrix is the single source of truth for box capacity.
    // An Item Group is expected to have MULTIPLE Box Types configured — box
    // plans are computed by bin-packing across all of them (see computeBoxPlan).
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_BoxTypes')
        CREATE TABLE GTP_BoxTypes (
            BoxTypeID  INT IDENTITY(1,1) PRIMARY KEY,
            Label      NVARCHAR(50) NOT NULL UNIQUE,
            SizeLWH    NVARCHAR(50) NULL,
            IsActive   BIT NOT NULL DEFAULT 1,
            CreatedAt  DATETIME NOT NULL DEFAULT GETDATE()
        );
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'GTP_BoxTypeCapacity')
        CREATE TABLE GTP_BoxTypeCapacity (
            BoxTypeID     INT NOT NULL REFERENCES GTP_BoxTypes(BoxTypeID) ON DELETE CASCADE,
            ItemGroupName NVARCHAR(100) NOT NULL,
            Capacity      INT NOT NULL,
            PRIMARY KEY (BoxTypeID, ItemGroupName)
        );
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM GTP_BoxTypes)
        INSERT INTO GTP_BoxTypes (Label, SizeLWH) VALUES
            ('5 Pcs',   '14.5x10.5x7.5'),
            ('15 Pcs',  '24.5x15.5x11'),
            ('120 Pcs', '32x14x12.5'),
            ('150 Pcs', '24x16x26'),
            ('35 Pcs',  '26.5x15x32'),
            ('50 Pcs',  '27.5x20x28');
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM GTP_BoxTypeCapacity)
        INSERT INTO GTP_BoxTypeCapacity (BoxTypeID, ItemGroupName, Capacity)
        SELECT T.BoxTypeID, V.ItemGroupName, V.Capacity
        FROM GTP_BoxTypes T
        CROSS APPLY (VALUES
            ('5 Pcs',   'SHIRT', 4),  ('5 Pcs',   'MENS TROUSERS', 10), ('5 Pcs',   'DHOTI (2M)', 20),
            ('5 Pcs',   'DHOTI (4M)', 10), ('5 Pcs', 'READY DHOTIE', 5), ('5 Pcs', 'COMBO SET', 1),
            ('15 Pcs',  'SHIRT', 12), ('15 Pcs',  'MENS TROUSERS', 30), ('15 Pcs',  'DHOTI (2M)', 80),
            ('15 Pcs',  'DHOTI (4M)', 50), ('15 Pcs', 'READY DHOTIE', 20), ('15 Pcs', 'COMBO SET', 2),
            ('120 Pcs', 'SHIRT', 17), ('120 Pcs', 'MENS TROUSERS', 40), ('120 Pcs', 'DHOTI (2M)', 120),
            ('120 Pcs', 'DHOTI (4M)', 100), ('120 Pcs', 'READY DHOTIE', 30),
            ('150 Pcs', 'SHIRT', 30), ('150 Pcs', 'MENS TROUSERS', 80), ('150 Pcs', 'DHOTI (2M)', 200),
            ('150 Pcs', 'DHOTI (4M)', 150), ('150 Pcs', 'READY DHOTIE', 50), ('150 Pcs', 'COMBO SET', 4),
            ('35 Pcs',  'SHIRT', 40), ('35 Pcs',  'DHOTI (4M)', 180), ('35 Pcs',  'READY DHOTIE', 65),
            ('35 Pcs',  'COMBO SET', 6),
            ('50 Pcs',  'SHIRT', 52)
        ) AS V(BoxTypeLabel, ItemGroupName, Capacity)
        WHERE T.Label = V.BoxTypeLabel;
    `);

    // Repair pass: an earlier version of this migration wrongly enforced "one
    // Box Type per Item Group" and deleted matrix rows outside the chosen
    // default on every restart. That enforcement is gone — this restores any
    // baseline (BoxType, ItemGroup) cell that's missing, without touching any
    // cell that already exists (so intentional edits made since aren't undone).
    await pool.request().query(`
        INSERT INTO GTP_BoxTypeCapacity (BoxTypeID, ItemGroupName, Capacity)
        SELECT T.BoxTypeID, V.ItemGroupName, V.Capacity
        FROM GTP_BoxTypes T
        CROSS APPLY (VALUES
            ('5 Pcs',   'SHIRT', 4),  ('5 Pcs',   'MENS TROUSERS', 10), ('5 Pcs',   'DHOTI (2M)', 20),
            ('5 Pcs',   'DHOTI (4M)', 10), ('5 Pcs', 'READY DHOTIE', 5), ('5 Pcs', 'COMBO SET', 1),
            ('15 Pcs',  'SHIRT', 12), ('15 Pcs',  'MENS TROUSERS', 30), ('15 Pcs',  'DHOTI (2M)', 80),
            ('15 Pcs',  'DHOTI (4M)', 50), ('15 Pcs', 'READY DHOTIE', 20), ('15 Pcs', 'COMBO SET', 2),
            ('120 Pcs', 'SHIRT', 17), ('120 Pcs', 'MENS TROUSERS', 40), ('120 Pcs', 'DHOTI (2M)', 120),
            ('120 Pcs', 'DHOTI (4M)', 100), ('120 Pcs', 'READY DHOTIE', 30),
            ('150 Pcs', 'SHIRT', 30), ('150 Pcs', 'MENS TROUSERS', 80), ('150 Pcs', 'DHOTI (2M)', 200),
            ('150 Pcs', 'DHOTI (4M)', 150), ('150 Pcs', 'READY DHOTIE', 50), ('150 Pcs', 'COMBO SET', 4),
            ('35 Pcs',  'SHIRT', 40), ('35 Pcs',  'DHOTI (4M)', 180), ('35 Pcs',  'READY DHOTIE', 65),
            ('35 Pcs',  'COMBO SET', 6),
            ('50 Pcs',  'SHIRT', 52)
        ) AS V(BoxTypeLabel, ItemGroupName, Capacity)
        WHERE T.Label = V.BoxTypeLabel
          AND NOT EXISTS (
              SELECT 1 FROM GTP_BoxTypeCapacity X
              WHERE X.BoxTypeID = T.BoxTypeID
                AND UPPER(LTRIM(RTRIM(X.ItemGroupName))) = UPPER(LTRIM(RTRIM(V.ItemGroupName)))
          );
    `);

    _tablesEnsured = true;
}

// Every active Box Type configured for this Item Group, sorted by capacity
// descending (largest first) — the candidate set computeBoxPlan bin-packs over.
async function getCapacityOptions(pool, itemGroupName) {
    const res = await pool.request()
        .input('ig', sql.NVarChar(100), itemGroupName || '')
        .query(`
            SELECT TC.BoxTypeID, BT.Label, TC.Capacity
            FROM GTP_BoxTypeCapacity TC
            INNER JOIN GTP_BoxTypes BT ON BT.BoxTypeID = TC.BoxTypeID AND BT.IsActive = 1
            WHERE UPPER(LTRIM(RTRIM(TC.ItemGroupName))) = UPPER(LTRIM(RTRIM(@ig)))
            ORDER BY TC.Capacity DESC
        `);
    return res.recordset.map(r => ({ boxTypeId: r.BoxTypeID, label: r.Label, capacity: r.Capacity }));
}

// Greedy bin-packing: fill as many full boxes of the LARGEST available
// capacity as fit, then pack whatever's left into a single box using the
// SMALLEST capacity that can still hold it all (best fit — avoids both
// over-splitting into many small boxes and wasting a big box on a small
// remainder). `options` must be sorted by capacity descending.
function computeBoxPlan(totalQty, options) {
    if (!options.length || totalQty <= 0) return null;

    const largest  = options[0];
    const byAsc    = [...options].sort((a, b) => a.capacity - b.capacity);
    const plan     = [];

    const numFull = Math.floor(totalQty / largest.capacity);
    for (let i = 0; i < numFull; i++) {
        plan.push({ boxTypeId: largest.boxTypeId, label: largest.label, targetQty: largest.capacity });
    }

    const remaining = totalQty - numFull * largest.capacity;
    if (remaining > 0) {
        const bestFit = byAsc.find(o => o.capacity >= remaining) || largest;
        plan.push({ boxTypeId: bestFit.boxTypeId, label: bestFit.label, targetQty: remaining });
    }

    return plan;
}

// ── Box Types + capacity matrix CRUD ────────────────────────────
async function listBoxTypes() {
    const pool = await getPool();
    await ensureBoxTables(pool);
    const res = await pool.request().query(
        `SELECT BoxTypeID, Label, SizeLWH, IsActive, CreatedAt FROM GTP_BoxTypes ORDER BY BoxTypeID`
    );
    return res.recordset;
}

async function upsertBoxType(label, sizeLWH) {
    const pool = await getPool();
    await ensureBoxTables(pool);
    const lbl = (label || '').trim();
    if (!lbl) throw Object.assign(new Error('Box type label is required'), { status: 400 });
    await pool.request()
        .input('lbl', sql.NVarChar(50), lbl)
        .input('sz',  sql.NVarChar(50), sizeLWH || null)
        .query(`
            MERGE GTP_BoxTypes AS T
            USING (SELECT @lbl AS Label) AS S ON UPPER(T.Label) = UPPER(S.Label)
            WHEN MATCHED THEN UPDATE SET SizeLWH=@sz, IsActive=1
            WHEN NOT MATCHED THEN INSERT (Label, SizeLWH) VALUES (@lbl, @sz);
        `);
    return listBoxTypes();
}

// Deleting a Box Type cascades its GTP_BoxTypeCapacity rows (ON DELETE CASCADE) —
// any Item Group that pointed at it simply has no capacity anywhere until
// re-added, which createBoxPlanForSession already handles with a single-box
// fallback + warning log.
async function deleteBoxType(boxTypeId) {
    const pool = await getPool();
    await ensureBoxTables(pool);
    await pool.request().input('bt', sql.Int, boxTypeId).query(`DELETE FROM GTP_BoxTypes WHERE BoxTypeID=@bt`);
    return listBoxTypes();
}

async function getBoxTypeMatrix() {
    const pool = await getPool();
    await ensureBoxTables(pool);
    const types = await pool.request().query(
        `SELECT BoxTypeID, Label, SizeLWH, IsActive FROM GTP_BoxTypes ORDER BY BoxTypeID`
    );
    const cells = await pool.request().query(
        `SELECT BoxTypeID, ItemGroupName, Capacity FROM GTP_BoxTypeCapacity`
    );
    const byType = {};
    for (const c of cells.recordset) {
        if (!byType[c.BoxTypeID]) byType[c.BoxTypeID] = [];
        byType[c.BoxTypeID].push({ itemGroupName: c.ItemGroupName, capacity: c.Capacity });
    }
    return types.recordset.map(t => ({ ...t, capacities: byType[t.BoxTypeID] || [] }));
}

// An Item Group can have a capacity under multiple Box Types — box-plan
// creation bin-packs across all of them (see computeBoxPlan). Upserting one
// cell only ever touches that (BoxType, ItemGroup) pair.
async function upsertBoxTypeCapacity(boxTypeId, itemGroupName, capacity) {
    const pool = await getPool();
    await ensureBoxTables(pool);
    const name = (itemGroupName || '').trim();
    const cap  = Number(capacity);
    if (!name || !Number.isFinite(cap) || cap <= 0) throw Object.assign(
        new Error('itemGroupName and a positive capacity are required'), { status: 400 }
    );

    await pool.request()
        .input('bt',  sql.Int,           boxTypeId)
        .input('ig',  sql.NVarChar(100), name)
        .input('cap', sql.Int,           cap)
        .query(`
            MERGE GTP_BoxTypeCapacity AS T
            USING (SELECT @bt AS BoxTypeID, @ig AS ItemGroupName) AS S
              ON T.BoxTypeID = S.BoxTypeID AND UPPER(T.ItemGroupName) = UPPER(S.ItemGroupName)
            WHEN MATCHED THEN UPDATE SET Capacity=@cap
            WHEN NOT MATCHED THEN INSERT (BoxTypeID, ItemGroupName, Capacity) VALUES (@bt, @ig, @cap);
        `);
    return getBoxTypeMatrix();
}

async function deleteBoxTypeCapacity(boxTypeId, itemGroupName) {
    const pool = await getPool();
    await ensureBoxTables(pool);
    await pool.request()
        .input('bt', sql.Int, boxTypeId)
        .input('ig', sql.NVarChar(100), itemGroupName)
        .query(`DELETE FROM GTP_BoxTypeCapacity WHERE BoxTypeID=@bt AND UPPER(ItemGroupName)=UPPER(@ig)`);
    return getBoxTypeMatrix();
}

// ── Box plan creation (called once per party+order+item-group at session start) ──
async function createBoxPlanForSession(sessionId, headerId, cardCode, docEntry, itemGroupName, totalQty) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    const groupName = (itemGroupName || 'UNSPECIFIED').trim();
    const options    = await getCapacityOptions(pool, groupName);

    let plan = options.length ? computeBoxPlan(totalQty, options) : null;
    if (!plan) {
        logger.warn(`[BOXES] No box capacity configured for item group "${groupName}" — defaulting to a single box (qty=${totalQty})`);
        plan = [{ boxTypeId: null, label: null, targetQty: totalQty }];
    }

    for (let i = 0; i < plan.length; i++) {
        const n = i + 1;
        const { targetQty, boxTypeId } = plan[i];
        const status = n === 1 ? 'Active' : 'Pending';

        const seqRes = await pool.request().query(`SELECT NEXT VALUE FOR GTP_BoxNumberSeq AS Seq`);
        const boxCode = 'BX' + String(seqRes.recordset[0].Seq).padStart(6, '0');

        await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('hid', sql.NVarChar(50),  headerId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('ig',  sql.NVarChar(100), groupName)
            .input('bn',  sql.Int,           n)
            .input('tq',  sql.Decimal(10,2), targetQty)
            .input('st',  sql.NVarChar(20),  status)
            .input('bc',  sql.NVarChar(150), boxCode)
            .input('bt',  sql.Int,           boxTypeId)
            .query(`INSERT INTO GTP_PickBoxes
                        (SessionID, HeaderId, CardCode, DocEntry, ItemGroupName, BoxNumber, TargetQty, Status, BoxCode, BoxTypeID)
                    VALUES (@sid, @hid, @cc, @de, @ig, @bn, @tq, @st, @bc, @bt)`);
    }
}

// ── Scan → box distribution ─────────────────────────────────────
// Adds `qty` to the current Active box for (session, cardCode, docEntry,
// itemGroup); overflow spills into subsequent Pending boxes, auto-completing
// each one that reaches its target and activating the next. Returns the
// boxes that were auto-completed by this call, plus the box the scan was
// first routed to.
async function applyScanQtyToBoxes(sessionId, cardCode, docEntry, itemGroupName, qty) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    let remaining = qty;
    const completedBoxes = [];
    let firstBoxId = null;

    while (remaining > 0) {
        const boxRes = await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('ig',  sql.NVarChar(100), itemGroupName)
            .query(`SELECT TOP 1 * FROM GTP_PickBoxes
                    WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig AND Status IN ('Active','Pending')
                    ORDER BY BoxNumber`);
        const box = boxRes.recordset[0];
        if (!box) break; // plan exhausted (unexpected overflow scan) — nothing more to allocate

        if (firstBoxId == null) firstBoxId = box.BoxID;

        const boxRemaining = Number(box.TargetQty) - Number(box.PickedQty);
        const portion      = Math.min(remaining, boxRemaining);
        const newPicked    = Number(box.PickedQty) + portion;
        const boxDone      = newPicked >= Number(box.TargetQty);

        await pool.request()
            .input('bid', sql.Int,           box.BoxID)
            .input('pq',  sql.Decimal(10,2), newPicked)
            .input('st',  sql.NVarChar(20),  boxDone ? 'Completed' : 'Active')
            .query(`UPDATE GTP_PickBoxes
                    SET PickedQty=@pq, Status=@st,
                        CompletionMethod = CASE WHEN @st='Completed' THEN 'Auto' ELSE CompletionMethod END,
                        CompletedAt      = CASE WHEN @st='Completed' THEN GETDATE() ELSE CompletedAt END
                    WHERE BoxID=@bid`);

        if (boxDone) {
            await pool.request()
                .input('sid', sql.Int,           sessionId)
                .input('cc',  sql.NVarChar(50),  cardCode)
                .input('de',  sql.Int,           docEntry)
                .input('ig',  sql.NVarChar(100), itemGroupName)
                .input('bn',  sql.Int,           box.BoxNumber + 1)
                .query(`UPDATE GTP_PickBoxes SET Status='Active'
                        WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig AND BoxNumber=@bn AND Status='Pending'`);

            completedBoxes.push({
                boxId: box.BoxID, boxNumber: box.BoxNumber, itemGroupName, cardCode, docEntry,
                targetQty: Number(box.TargetQty),
            });
        }

        remaining -= portion;
    }

    // The box now Active for this group, if a completion moved the plan
    // forward this call — the frontend prints its ID label before the
    // picker starts filling it. Stays null if the group's last box just
    // completed (nothing left to print for).
    let nextActivatedBox = null;
    if (completedBoxes.length) {
        const activeRes = await pool.request()
            .input('sid', sql.Int,           sessionId)
            .input('cc',  sql.NVarChar(50),  cardCode)
            .input('de',  sql.Int,           docEntry)
            .input('ig',  sql.NVarChar(100), itemGroupName)
            .query(`SELECT TOP 1 BoxID, BoxNumber FROM GTP_PickBoxes
                    WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig AND Status='Active'`);
        if (activeRes.recordset[0]) {
            nextActivatedBox = { boxId: activeRes.recordset[0].BoxID, boxNumber: activeRes.recordset[0].BoxNumber };
        }
    }

    return { completedBoxes, firstBoxId, nextActivatedBox };
}

// ── Manual box completion ────────────────────────────────────────
async function completeBoxManually(boxId, operatorId) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    const boxRes = await pool.request().input('bid', sql.Int, boxId)
        .query(`SELECT * FROM GTP_PickBoxes WHERE BoxID=@bid`);
    const box = boxRes.recordset[0];
    if (!box) throw Object.assign(new Error('Box not found'), { status: 404 });
    if (box.Status === 'Completed') throw Object.assign(
        new Error('Box already completed'), { status: 409, code: 'BOX_ALREADY_DONE' }
    );

    await pool.request()
        .input('bid',  sql.Int, boxId)
        .input('opid', sql.Int, operatorId || null)
        .query(`UPDATE GTP_PickBoxes
                SET Status='Completed', CompletionMethod='Manual', CompletedAt=GETDATE(), CompletedByOperatorID=@opid
                WHERE BoxID=@bid`);

    await pool.request()
        .input('sid', sql.Int,           box.SessionID)
        .input('cc',  sql.NVarChar(50),  box.CardCode)
        .input('de',  sql.Int,           box.DocEntry)
        .input('ig',  sql.NVarChar(100), box.ItemGroupName)
        .input('bn',  sql.Int,           box.BoxNumber + 1)
        .query(`UPDATE GTP_PickBoxes SET Status='Active'
                WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig AND BoxNumber=@bn AND Status='Pending'`);

    const nextRes = await pool.request()
        .input('sid', sql.Int,           box.SessionID)
        .input('cc',  sql.NVarChar(50),  box.CardCode)
        .input('de',  sql.Int,           box.DocEntry)
        .input('ig',  sql.NVarChar(100), box.ItemGroupName)
        .input('bn',  sql.Int,           box.BoxNumber + 1)
        .query(`SELECT BoxID, BoxNumber FROM GTP_PickBoxes
                WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig AND BoxNumber=@bn AND Status='Active'`);
    const nextActivatedBox = nextRes.recordset[0]
        ? { boxId: nextRes.recordset[0].BoxID, boxNumber: nextRes.recordset[0].BoxNumber }
        : null;

    const updated = await pool.request().input('bid', sql.Int, boxId)
        .query(`SELECT * FROM GTP_PickBoxes WHERE BoxID=@bid`);
    return { ...updated.recordset[0], nextActivatedBox };
}

// ── Box summary for a session (embedded in getSession() + dashboard) ──────
async function getBoxesForSession(sessionId) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    const res = await pool.request().input('sid', sql.Int, sessionId)
        .query(`
            SELECT PB.*, BT.Label AS BoxTypeLabel
            FROM GTP_PickBoxes PB
            LEFT JOIN GTP_BoxTypes BT ON BT.BoxTypeID = PB.BoxTypeID
            WHERE PB.SessionID=@sid
            ORDER BY PB.CardCode, PB.DocEntry, PB.ItemGroupName, PB.BoxNumber
        `);

    const groupMap = {};
    for (const b of res.recordset) {
        const key = `${b.CardCode}|${b.DocEntry}|${b.ItemGroupName}`;
        if (!groupMap[key]) groupMap[key] = {
            cardCode: b.CardCode, docEntry: b.DocEntry, itemGroupName: b.ItemGroupName, boxes: [],
        };
        groupMap[key].boxes.push(b);
    }

    return Object.values(groupMap).map(g => {
        const boxes          = g.boxes;
        const totalQty        = boxes.reduce((s, b) => s + Number(b.TargetQty), 0);
        const capacity         = Math.max(...boxes.map(b => Number(b.TargetQty)));
        const completedBoxes   = boxes.filter(b => b.Status === 'Completed').length;
        const activeBox         = boxes.find(b => b.Status === 'Active') || null;
        const currentBoxNumber  = activeBox ? activeBox.BoxNumber
            : (completedBoxes === boxes.length ? boxes.length : null);

        return {
            cardCode:      g.cardCode,
            docEntry:      g.docEntry,
            itemGroupName: g.itemGroupName,
            totalQty,
            capacity,
            boxesRequired: boxes.length,
            completedBoxes,
            pendingBoxes: boxes.length - completedBoxes,
            currentBoxNumber,
            currentBox: activeBox ? {
                boxId: activeBox.BoxID, boxNumber: activeBox.BoxNumber,
                targetQty: Number(activeBox.TargetQty), pickedQty: Number(activeBox.PickedQty),
                status: activeBox.Status, boxTypeLabel: activeBox.BoxTypeLabel || null,
            } : null,
            boxes: boxes.map(b => ({
                boxId: b.BoxID, boxNumber: b.BoxNumber,
                targetQty: Number(b.TargetQty), pickedQty: Number(b.PickedQty),
                status: b.Status, completionMethod: b.CompletionMethod,
                boxCode: b.BoxCode, completedAt: b.CompletedAt, boxTypeLabel: b.BoxTypeLabel || null,
            })),
        };
    });
}

// ── Box label data ────────────────────────────────────────────────
async function getItemMeta(pool, itemCode) {
    const res = await pool.request()
        .input('ic', sql.NVarChar(50), itemCode)
        .query(`SELECT TOP 1 T3.itemcode AS ItemCode,
                    T3.itemname                AS ProductName,
                    Ltrim(Rtrim(T3.u_subgrp5)) AS ItemSize,
                    T3.u_style                 AS StyleNo,
                    Ltrim(Rtrim(T3.u_subgrp6)) AS ItemColor
                FROM bblive.dbo.oitm T3
                WHERE T3.itemcode = @ic COLLATE database_default`);
    return res.recordset[0] || {};
}

async function getCardName(pool, headerId, cardCode) {
    const nameRes = await pool.request()
        .input('hid', sql.NVarChar(50), headerId)
        .input('cc',  sql.NVarChar(50), cardCode)
        .query(`SELECT TOP 1 O2.CardName
                FROM WMS.dbo.Tran_TransDetails TD2
                INNER JOIN BBLive.dbo.ORDR O2
                       ON O2.DocEntry = TD2.DocEntry AND O2.CardCode COLLATE DATABASE_DEFAULT = @cc
                WHERE TD2.HeaderId = @hid`);
    return nameRes.recordset[0]?.CardName || cardCode;
}

// ── Box Identification Label — printed for an empty box, before packing ──
async function getBoxIdentificationLabelData(boxId) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    const boxRes = await pool.request().input('bid', sql.Int, boxId)
        .query(`
            SELECT PB.*, BT.Label AS BoxTypeLabel
            FROM GTP_PickBoxes PB
            LEFT JOIN GTP_BoxTypes BT ON BT.BoxTypeID = PB.BoxTypeID
            WHERE PB.BoxID=@bid
        `);
    const box = boxRes.recordset[0];
    if (!box) throw Object.assign(new Error('Box not found'), { status: 404 });

    const cardName = await getCardName(pool, box.HeaderId, box.CardCode);

    const totalRes = await pool.request()
        .input('sid', sql.Int,           box.SessionID)
        .input('cc',  sql.NVarChar(50),  box.CardCode)
        .input('de',  sql.Int,           box.DocEntry)
        .input('ig',  sql.NVarChar(100), box.ItemGroupName)
        .query(`SELECT COUNT(*) AS Total FROM GTP_PickBoxes WHERE SessionID=@sid AND CardCode=@cc AND DocEntry=@de AND ItemGroupName=@ig`);
    const totalBoxes = totalRes.recordset[0].Total;

    return {
        companyName:      COMPANY_NAME,
        customerName:     cardName,
        picklistNumber:   box.HeaderId,
        salesOrderNumber: box.DocEntry,
        itemGroupName:    box.ItemGroupName,
        boxNumber:        box.BoxCode,
        boxTypeLabel:     box.BoxTypeLabel || null,
        boxSequence:      box.BoxNumber,
        totalBoxes,
        createdAt:        box.CreatedAt,
    };
}

// ── Box Contents Label — printed on-demand after a QR scan, once the box is
// packed. Looked up by the human Box Number (BoxCode), not the internal id.
async function getBoxContentsLabelData(boxCode) {
    const pool = await getPool();
    await ensureBoxTables(pool);

    const boxRes = await pool.request().input('bc', sql.NVarChar(150), boxCode)
        .query(`SELECT * FROM GTP_PickBoxes WHERE BoxCode=@bc`);
    const box = boxRes.recordset[0];
    if (!box) throw Object.assign(new Error(`Box "${boxCode}" not found`), { status: 404 });

    const cardName = await getCardName(pool, box.HeaderId, box.CardCode);

    const lineRes = await pool.request().input('bid', sql.Int, box.BoxID)
        .query(`SELECT ItemCode, SUM(ScannedQty) AS Qty
                FROM GTP_ScanLog WHERE BoxID=@bid GROUP BY ItemCode`);

    // Pivot: rows = Product Name, columns = Size, cell = qty
    const products = [];   // ordered list of distinct product names
    const sizes    = [];   // ordered list of distinct sizes
    const matrix   = {};   // matrix[product][size] = qty

    for (const row of lineRes.recordset) {
        const meta = await getItemMeta(pool, row.ItemCode);
        const product = meta.ProductName || row.ItemCode;
        const size    = meta.ItemSize || '-';
        const qty     = Number(row.Qty);

        if (!products.includes(product)) products.push(product);
        if (!sizes.includes(size)) sizes.push(size);
        if (!matrix[product]) matrix[product] = {};
        matrix[product][size] = (matrix[product][size] || 0) + qty;
    }
    sizes.sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));

    const rowTotals = {};
    const colTotals = {};
    let grandTotal = 0;
    for (const product of products) {
        let rowSum = 0;
        for (const size of sizes) {
            const qty = matrix[product]?.[size] || 0;
            rowSum += qty;
            colTotals[size] = (colTotals[size] || 0) + qty;
        }
        rowTotals[product] = rowSum;
        grandTotal += rowSum;
    }

    return {
        companyName:      COMPANY_NAME,
        customerName:     cardName,
        picklistNumber:   box.HeaderId,
        salesOrderNumber: box.DocEntry,
        boxNumber:        box.BoxCode,
        itemGroupName:    box.ItemGroupName,
        products, sizes, matrix, rowTotals, colTotals, grandTotal,
    };
}

// ── Auto-print (replaces the browser-tab flow when a station has an active
// printer configured) ────────────────────────────────────────────────────
function buildIdLabelSpec(idData) {
    const fields = [
        { label: 'Company',    value: idData.companyName },
        { label: 'Customer',   value: idData.customerName },
        { label: 'Picklist',   value: idData.picklistNumber },
        { label: 'Order',      value: idData.salesOrderNumber },
        { label: 'Item Group', value: idData.itemGroupName },
        { label: 'Box',        value: `${idData.boxSequence} of ${idData.totalBoxes}` },
    ];
    if (idData.boxTypeLabel) fields.push({ label: 'Box Type', value: idData.boxTypeLabel });
    return { fields, qrData: idData.boxNumber };
}

// Looks up the box's station (via its session) and, if that station has an
// active printer configured, prints its Identification label directly —
// the picking-shell frontend skips its own browser-print fallback whenever
// this reports `printed: true`. Never throws — a print failure shouldn't
// break the picking flow, it just falls back to `printed: false`.
async function printIdLabelForBox(boxId) {
    try {
        const pool = await getPool();
        const boxRes = await pool.request().input('bid', sql.Int, boxId)
            .query(`SELECT SessionID FROM GTP_PickBoxes WHERE BoxID=@bid`);
        const sessionId = boxRes.recordset[0]?.SessionID;
        if (!sessionId) return { printed: false };

        const stnRes = await pool.request().input('sid', sql.Int, sessionId)
            .query(`SELECT StationId FROM GTP_PicklistSessions WHERE SessionID=@sid`);
        const stationId = stnRes.recordset[0]?.StationId;
        if (!stationId) return { printed: false };

        const idData = await getBoxIdentificationLabelData(boxId);
        return await printerSvc.printLabel(stationId, 'Identification', buildIdLabelSpec(idData), boxId);
    } catch (err) {
        logger.error(`[PRINT] Auto-print box ${boxId} ID label failed: ${err.message}`);
        return { printed: false, error: err.message };
    }
}

module.exports = {
    ensureBoxTables,
    listBoxTypes, upsertBoxType, deleteBoxType,
    getBoxTypeMatrix, upsertBoxTypeCapacity, deleteBoxTypeCapacity,
    createBoxPlanForSession, applyScanQtyToBoxes, completeBoxManually,
    getBoxesForSession, getBoxIdentificationLabelData, getBoxContentsLabelData,
    printIdLabelForBox,
};
