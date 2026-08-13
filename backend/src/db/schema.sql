-- ============================================================
-- GTP Station Put-to-Light Database Schema
-- Database: GTP_Station (create this DB before running)
-- ============================================================

USE GTP_Station;
GO

-- ─── Operators ───────────────────────────────────────────────
CREATE TABLE GTP_Operators (
    OperatorID   INT PRIMARY KEY IDENTITY(1,1),
    OperatorCode NVARCHAR(50) NOT NULL UNIQUE,
    OperatorName NVARCHAR(100) NOT NULL,
    PIN          NVARCHAR(10) NULL,
    IsActive     BIT NOT NULL DEFAULT 1,
    CreatedAt    DATETIME NOT NULL DEFAULT GETDATE()
);

-- ─── Stations ────────────────────────────────────────────────
CREATE TABLE GTP_Stations (
    StationID    INT PRIMARY KEY IDENTITY(1,1),
    StationCode  NVARCHAR(50) NOT NULL UNIQUE,
    StationName  NVARCHAR(100) NOT NULL,
    Description  NVARCHAR(255) NULL,
    IsActive     BIT NOT NULL DEFAULT 1,
    CreatedAt    DATETIME NOT NULL DEFAULT GETDATE()
);

-- ─── Bins ────────────────────────────────────────────────────
CREATE TABLE GTP_Bins (
    BinID        INT PRIMARY KEY IDENTITY(1,1),
    StationID    INT NOT NULL REFERENCES GTP_Stations(StationID),
    BinCode      NVARCHAR(50) NOT NULL UNIQUE,
    BinRow       INT NOT NULL DEFAULT 1,
    BinColumn    INT NOT NULL DEFAULT 1,
    Capacity     INT NOT NULL DEFAULT 1,
    LightColor   NVARCHAR(20) NOT NULL DEFAULT 'green',  -- green/yellow/red
    IsActive     BIT NOT NULL DEFAULT 1,
    CurrentOrderID INT NULL  -- soft ref, set at runtime
);
CREATE INDEX IX_GTP_Bins_Station ON GTP_Bins(StationID);

-- ─── Orders ──────────────────────────────────────────────────
CREATE TABLE GTP_Orders (
    OrderID       INT PRIMARY KEY IDENTITY(1,1),
    OrderNumber   NVARCHAR(50) NOT NULL UNIQUE,
    CustomerCode  NVARCHAR(50) NULL,
    CustomerName  NVARCHAR(200) NULL,
    Priority      INT NOT NULL DEFAULT 1,  -- 1=Normal 2=High 3=Urgent
    Status        NVARCHAR(20) NOT NULL DEFAULT 'Pending',
        -- Pending | Assigned | InProgress | Completed | Cancelled
    AssignedBinID INT NULL REFERENCES GTP_Bins(BinID),
    OperatorID    INT NULL REFERENCES GTP_Operators(OperatorID),
    TotalItems    INT NOT NULL DEFAULT 0,
    PutItems      INT NOT NULL DEFAULT 0,
    Notes         NVARCHAR(500) NULL,
    CreatedAt     DATETIME NOT NULL DEFAULT GETDATE(),
    AssignedAt    DATETIME NULL,
    StartedAt     DATETIME NULL,
    CompletedAt   DATETIME NULL
);
CREATE INDEX IX_GTP_Orders_Status   ON GTP_Orders(Status);
CREATE INDEX IX_GTP_Orders_BinID    ON GTP_Orders(AssignedBinID);
CREATE INDEX IX_GTP_Orders_Created  ON GTP_Orders(CreatedAt DESC);

-- ─── Order Items ─────────────────────────────────────────────
CREATE TABLE GTP_OrderItems (
    ItemID      INT PRIMARY KEY IDENTITY(1,1),
    OrderID     INT NOT NULL REFERENCES GTP_Orders(OrderID) ON DELETE CASCADE,
    SortSeq     INT NOT NULL DEFAULT 1,
    ItemCode    NVARCHAR(50) NOT NULL,
    ItemName    NVARCHAR(200) NOT NULL,
    SKU         NVARCHAR(100) NULL,
    RequiredQty DECIMAL(10,2) NOT NULL,
    PutQty      DECIMAL(10,2) NOT NULL DEFAULT 0,
    UOM         NVARCHAR(20) NULL DEFAULT 'PCS',
    Status      NVARCHAR(20) NOT NULL DEFAULT 'Pending',
        -- Pending | InProgress | Completed | Skipped
    CompletedAt DATETIME NULL
);
CREATE INDEX IX_GTP_OrderItems_Order  ON GTP_OrderItems(OrderID);
CREATE INDEX IX_GTP_OrderItems_Status ON GTP_OrderItems(Status);

-- ─── Inventory ───────────────────────────────────────────────
CREATE TABLE GTP_Inventory (
    InventoryID   INT PRIMARY KEY IDENTITY(1,1),
    ItemCode      NVARCHAR(50) NOT NULL UNIQUE,
    ItemName      NVARCHAR(200) NOT NULL,
    Brand         NVARCHAR(100) NULL,
    Category      NVARCHAR(100) NULL,
    StyleCode     NVARCHAR(50) NULL,
    SizeCode      NVARCHAR(50) NULL,
    ColorCode     NVARCHAR(50) NULL,
    UOM           NVARCHAR(20) NOT NULL DEFAULT 'PCS',
    AvailableQty  DECIMAL(10,2) NOT NULL DEFAULT 0,
    ReservedQty   DECIMAL(10,2) NOT NULL DEFAULT 0,
    MinQty        DECIMAL(10,2) NOT NULL DEFAULT 0,
    WarehouseCode NVARCHAR(20) NULL DEFAULT 'ASRS',
    LastUpdated   DATETIME NOT NULL DEFAULT GETDATE(),
    IsActive      BIT NOT NULL DEFAULT 1
);
CREATE INDEX IX_GTP_Inventory_ItemCode ON GTP_Inventory(ItemCode);

-- ─── Put-to-Light Events (Audit Log) ─────────────────────────
CREATE TABLE GTP_PTLEvents (
    EventID    INT PRIMARY KEY IDENTITY(1,1),
    OrderID    INT NOT NULL REFERENCES GTP_Orders(OrderID),
    BinID      INT NULL REFERENCES GTP_Bins(BinID),
    ItemCode   NVARCHAR(50) NULL,
    Quantity   DECIMAL(10,2) NULL,
    EventType  NVARCHAR(30) NOT NULL,
        -- LightOn | LightOff | ItemConfirmed | ItemSkipped
        -- OrderStarted | OrderCompleted | OrderCancelled | BinAssigned
    OperatorID INT NULL REFERENCES GTP_Operators(OperatorID),
    EventTime  DATETIME NOT NULL DEFAULT GETDATE(),
    Notes      NVARCHAR(500) NULL
);
CREATE INDEX IX_GTP_PTLEvents_Order  ON GTP_PTLEvents(OrderID);
CREATE INDEX IX_GTP_PTLEvents_Time   ON GTP_PTLEvents(EventTime DESC);

-- ─── Seed Data ───────────────────────────────────────────────
INSERT INTO GTP_Operators (OperatorCode, OperatorName, PIN)
VALUES
    ('OP001', 'Operator 1', '1234'),
    ('OP002', 'Operator 2', '2345'),
    ('OP003', 'Supervisor', '9999');

INSERT INTO GTP_Stations (StationCode, StationName, Description)
VALUES
    ('STN-01', 'Station A', 'Primary GTP Station - Left'),
    ('STN-02', 'Station B', 'Primary GTP Station - Right');

-- 8 bins per station (4 rows x 2 columns)
INSERT INTO GTP_Bins (StationID, BinCode, BinRow, BinColumn, LightColor)
VALUES
    (1, 'A-R1C1', 1, 1, 'green'), (1, 'A-R1C2', 1, 2, 'green'),
    (1, 'A-R2C1', 2, 1, 'green'), (1, 'A-R2C2', 2, 2, 'green'),
    (1, 'A-R3C1', 3, 1, 'green'), (1, 'A-R3C2', 3, 2, 'green'),
    (1, 'A-R4C1', 4, 1, 'green'), (1, 'A-R4C2', 4, 2, 'green'),

    (2, 'B-R1C1', 1, 1, 'green'), (2, 'B-R1C2', 1, 2, 'green'),
    (2, 'B-R2C1', 2, 1, 'green'), (2, 'B-R2C2', 2, 2, 'green'),
    (2, 'B-R3C1', 3, 1, 'green'), (2, 'B-R3C2', 3, 2, 'green'),
    (2, 'B-R4C1', 4, 1, 'green'), (2, 'B-R4C2', 4, 2, 'green');

-- Sample inventory
INSERT INTO GTP_Inventory (ItemCode, ItemName, Brand, Category, UOM, AvailableQty)
VALUES
    ('ITM-001', 'White Cotton Shirt S', 'UATHAYAM', 'SHIRTING', 'PCS', 100),
    ('ITM-002', 'White Cotton Shirt M', 'UATHAYAM', 'SHIRTING', 'PCS', 120),
    ('ITM-003', 'White Cotton Shirt L', 'UATHAYAM', 'SHIRTING', 'PCS', 90),
    ('ITM-004', 'Blue Dhoti 2.5M',     'UATHAYAM', 'DHOTIE',   'PCS', 60),
    ('ITM-005', 'Ariser Formal Shirt M','ARISER',  'SHIRT',    'PCS', 75);
GO

-- ============================================================
-- GTP Picking Process Tables
-- ============================================================

-- Active picklist sessions
CREATE TABLE GTP_PicklistSessions (
    SessionID    INT IDENTITY(1,1) PRIMARY KEY,
    HeaderId     NVARCHAR(50)  NOT NULL,
    Status       NVARCHAR(20)  NOT NULL DEFAULT 'InProgress',  -- InProgress | Completed | Abandoned
    OperatorID   INT           NULL REFERENCES GTP_Operators(OperatorID),
    StartedAt    DATETIME      NOT NULL DEFAULT GETDATE(),
    CompletedAt  DATETIME      NULL,
    StationId    NVARCHAR(50)  NULL,          -- device code, e.g. 'STN-01'; snapshotted at session start
    TotalOrders  INT           NOT NULL DEFAULT 0  -- distinct SAP order count for this picklist, snapshotted at session start
);
GO
CREATE INDEX IX_PicklistSessions_HeaderId ON GTP_PicklistSessions (HeaderId);
GO

-- Covering index for the day-wise/station-wise picking report (reportService.js)
CREATE INDEX IX_PicklistSessions_Report ON GTP_PicklistSessions (StartedAt)
    INCLUDE (StationId, OperatorID, Status, HeaderId, CompletedAt, TotalOrders);
GO

-- Picked quantity tracker (one row per session + party + item)
CREATE TABLE GTP_PickProgress (
    ProgressID    INT IDENTITY(1,1) PRIMARY KEY,
    SessionID     INT              NOT NULL REFERENCES GTP_PicklistSessions(SessionID) ON DELETE CASCADE,
    HeaderId      NVARCHAR(50)     NOT NULL,
    CardCode      NVARCHAR(50)     NOT NULL,
    ItemCode      NVARCHAR(50)     NOT NULL,
    RequiredQty   DECIMAL(10,2)    NOT NULL DEFAULT 0,
    PickedQty     DECIMAL(10,2)    NOT NULL DEFAULT 0,
    Status        NVARCHAR(20)     NOT NULL DEFAULT 'Pending',  -- Pending | InProgress | Completed
    ItemGroupName NVARCHAR(100)    NULL,     -- box-management grouping, snapshotted at seed time
    DocEntry      INT              NULL,     -- Sales Order this item's box plan belongs to, snapshotted at seed time
    UpdatedAt     DATETIME         NULL,
    CONSTRAINT UQ_PickProgress UNIQUE (SessionID, CardCode, ItemCode, DocEntry)
);
GO
CREATE INDEX IX_PickProgress_Session ON GTP_PickProgress (SessionID, CardCode);
GO
CREATE INDEX IX_PickProgress_Report ON GTP_PickProgress (SessionID) INCLUDE (Status, PickedQty);
GO

-- Individual scan transaction log
CREATE TABLE GTP_ScanLog (
    ScanID       INT IDENTITY(1,1) PRIMARY KEY,
    SessionID    INT              NOT NULL REFERENCES GTP_PicklistSessions(SessionID) ON DELETE CASCADE,
    HeaderId     NVARCHAR(50)     NOT NULL,
    CardCode     NVARCHAR(50)     NOT NULL,
    ItemCode     NVARCHAR(50)     NOT NULL,
    ScanType     NVARCHAR(10)     NULL,
    IDValue      NVARCHAR(100)    NULL,
    ItemGroup    NVARCHAR(50)     NULL,
    UniqueNumber NVARCHAR(50)     NULL,
    ScannedQty   DECIMAL(10,2)    NOT NULL DEFAULT 1,
    BoxID        INT              NULL,  -- soft ref to GTP_PickBoxes(BoxID); box this scan was attributed to
    ScannedAt    DATETIME         NOT NULL DEFAULT GETDATE()
);
GO
CREATE INDEX IX_ScanLog_IDValue ON GTP_ScanLog (SessionID, IDValue);
GO

-- ============================================================
-- Station Light Status (ADAM-6052 DO channel tracking)
-- ============================================================

CREATE TABLE GTP_StationLightStatus (
    StatusID     INT           IDENTITY(1,1) PRIMARY KEY,
    SessionID    INT           NOT NULL,
    StationId    NVARCHAR(50)  NOT NULL,
    PicklistId   NVARCHAR(50)  NULL,          -- HeaderId of the picklist
    CardCode     NVARCHAR(50)  NOT NULL,
    PartyId      INT           NOT NULL,       -- 1..4
    Channel      INT           NOT NULL,       -- ADAM DO channel 0..7
    ChannelName  NVARCHAR(10)  NOT NULL,       -- D0..D7
    Status       NVARCHAR(5)   NOT NULL DEFAULT 'OFF',  -- ON | OFF
    UpdatedTime  DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT UQ_StationLight UNIQUE (SessionID, CardCode)
);
GO
CREATE INDEX IX_StationLight_Session ON GTP_StationLightStatus (SessionID);
GO
CREATE INDEX IX_StationLight_Station ON GTP_StationLightStatus (StationId, SessionID);
GO

-- ============================================================
-- SAP B1 Delivery Integration Log
-- Created automatically by deliveryService on first trigger.
-- ============================================================

CREATE TABLE GTP_DeliveryLog (
    LogID          INT IDENTITY(1,1) PRIMARY KEY,
    SessionID      INT              NOT NULL,
    HeaderId       NVARCHAR(50)     NOT NULL,
    CardCode       NVARCHAR(50)     NOT NULL,
    DocEntry       INT              NULL,   -- the specific SAP order (Sales Order DocEntry) this delivery covers; one SAP Delivery Note per (CardCode, DocEntry)
    Status         NVARCHAR(20)     NOT NULL DEFAULT 'Pending',
        -- Pending | Success | Failed
    SapDocEntry    INT              NULL,   -- SAP Delivery document entry
    SapDocNum      INT              NULL,   -- SAP Delivery document number
    ErrorMessage   NVARCHAR(MAX)    NULL,
    RequestPayload NVARCHAR(MAX)    NULL,   -- Full JSON sent to SAP B1
    CreatedAt      DATETIME         NOT NULL DEFAULT GETDATE(),
    UpdatedAt      DATETIME         NULL
);
GO
CREATE INDEX IX_DeliveryLog_Session ON GTP_DeliveryLog (SessionID, CardCode, DocEntry);
GO

-- ============================================================
-- ADAM-6052 Device Configuration (flat device list)
-- Created automatically by adamDeviceConfigService on first use.
-- Replaces the old hardcoded ADAM_IP / STATION_CHANNELS config.
-- DeviceCode is a free-text key (e.g. "STN-01") that the picking flow
-- (gtpPickingService/lightControlService) matches against — not a
-- foreign key into GTP_Stations, so device count isn't limited to
-- however many GTP stations exist.
-- ============================================================

CREATE TABLE GTP_AdamDevices (
    DeviceConfigID     INT PRIMARY KEY IDENTITY(1,1),
    DeviceCode         NVARCHAR(50) NOT NULL UNIQUE,
    IpAddress          NVARCHAR(45) NOT NULL,
    Port               INT NOT NULL DEFAULT 502,
    UnitId             INT NOT NULL DEFAULT 1,
    OutputStartChannel INT NOT NULL,       -- ADAM DO channel 0-7
    OutputEndChannel   INT NOT NULL,       -- ADAM DO channel 0-7, >= start
    MacAddress         NVARCHAR(17) NULL,  -- AA:BB:CC:DD:EE:FF; NULL = not yet locked
    IsActive           BIT NOT NULL DEFAULT 1,
    CreatedAt          DATETIME NOT NULL DEFAULT GETDATE(),
    UpdatedAt          DATETIME NULL
);
GO
CREATE INDEX IX_AdamDevices_Ip ON GTP_AdamDevices(IpAddress);
GO

-- ============================================================
-- Box Management (packing) — per Customer + Item Group box tracking
-- Created automatically by boxManagementService on first use.
-- ============================================================

-- Physical box types available on the floor (S.No/Box/Size(LxWxH) from the
-- packing reference sheet). The same box type holds a different quantity of
-- each Item Group — see GTP_BoxTypeCapacity.
CREATE TABLE GTP_BoxTypes (
    BoxTypeID  INT IDENTITY(1,1) PRIMARY KEY,
    Label      NVARCHAR(50) NOT NULL UNIQUE,   -- e.g. '5 Pcs', '15 Pcs', '120 Pcs'
    SizeLWH    NVARCHAR(50) NULL,              -- e.g. '14.5x10.5x7.5'
    IsActive   BIT NOT NULL DEFAULT 1,
    CreatedAt  DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- The matrix: how many pieces of a given Item Group fit in a given Box Type.
-- Absence of a row = that Item Group isn't packed in that Box Type ("-" on the
-- sheet). This is the single source of truth for box capacity — each Item Group
-- must map to exactly one Box Type (enforced on write in boxManagementService).
CREATE TABLE GTP_BoxTypeCapacity (
    BoxTypeID     INT NOT NULL REFERENCES GTP_BoxTypes(BoxTypeID) ON DELETE CASCADE,
    ItemGroupName NVARCHAR(100) NOT NULL,
    Capacity      INT NOT NULL,
    PRIMARY KEY (BoxTypeID, ItemGroupName)
);
GO

INSERT INTO GTP_BoxTypes (Label, SizeLWH) VALUES
    ('5 Pcs',   '14.5x10.5x7.5'),
    ('15 Pcs',  '24.5x15.5x11'),
    ('120 Pcs', '32x14x12.5'),
    ('150 Pcs', '24x16x26'),
    ('35 Pcs',  '26.5x15x32'),
    ('50 Pcs',  '27.5x20x28');
GO

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
GO

-- One row per (Session, CardCode, DocEntry, ItemGroupName, BoxNumber) — the box
-- plan for that customer's Sales Order + item group, computed at session start
-- via a bin-packing pass over GTP_BoxTypeCapacity (see computeBoxPlan in
-- boxManagementService.js) — a box plan can mix Box Types across its boxes.
CREATE TABLE GTP_PickBoxes (
    BoxID                  INT IDENTITY(1,1) PRIMARY KEY,
    SessionID              INT           NOT NULL REFERENCES GTP_PicklistSessions(SessionID) ON DELETE CASCADE,
    HeaderId               NVARCHAR(50)  NOT NULL,
    CardCode               NVARCHAR(50)  NOT NULL,
    DocEntry               INT           NOT NULL,  -- the Sales Order this box belongs to
    ItemGroupName          NVARCHAR(100) NOT NULL,
    BoxNumber              INT           NOT NULL,
    TargetQty              DECIMAL(10,2) NOT NULL,   -- this box's capacity (varies by Box Type used)
    PickedQty              DECIMAL(10,2) NOT NULL DEFAULT 0,
    Status                 NVARCHAR(20)  NOT NULL DEFAULT 'Pending',  -- Pending | Active | Completed
    CompletionMethod       NVARCHAR(10)  NULL,        -- Auto | Manual
    CompletedAt            DATETIME      NULL,
    CompletedByOperatorID  INT           NULL REFERENCES GTP_Operators(OperatorID),
    BoxTypeID              INT           NULL REFERENCES GTP_BoxTypes(BoxTypeID),  -- physical Box Type used for this box
    BoxCode                NVARCHAR(150) NOT NULL UNIQUE,  -- QR/label code, e.g. HeaderId-CardCode-DocEntry-Group-B1
    CreatedAt              DATETIME      NOT NULL DEFAULT GETDATE(),
    CONSTRAINT UQ_PickBoxes_SlotV2 UNIQUE (SessionID, CardCode, DocEntry, ItemGroupName, BoxNumber)
);
GO
CREATE INDEX IX_PickBoxes_Session ON GTP_PickBoxes (SessionID, CardCode, DocEntry, ItemGroupName);
GO

-- Global, sequential, human-readable Box Number (BX000001, BX000002, ...) —
-- unique across every picklist ever run. Stored directly in BoxCode above.
CREATE SEQUENCE GTP_BoxNumberSeq AS INT START WITH 1 INCREMENT BY 1;
GO

-- ============================================================
-- Station Label Printers — direct TCP printing, replacing the browser-tab
-- print flow when a station has an active printer configured.
-- Created automatically by printerService on first use.
-- ============================================================

CREATE TABLE GTP_StationPrinters (
    PrinterConfigID INT IDENTITY(1,1) PRIMARY KEY,
    DeviceCode      NVARCHAR(50)  NOT NULL UNIQUE,  -- same free-text station code GTP_AdamDevices uses
    PrinterName     NVARCHAR(100) NOT NULL,
    IpAddress       NVARCHAR(45)  NOT NULL,
    Port            INT           NOT NULL DEFAULT 9100,
    PrinterType     NVARCHAR(30)  NOT NULL DEFAULT 'Generic',  -- Zebra/TSC/Honeywell/SATO/Godex/Citizen/Brother/Epson/Generic
    Protocol        NVARCHAR(20)  NOT NULL DEFAULT 'RAW',      -- ZPL/EPL/TSPL/CPCL/ESCPOS/RAW/WindowsDriver
    DPI             INT           NOT NULL DEFAULT 203,
    PaperWidthMm    DECIMAL(6,2)  NOT NULL DEFAULT 90,
    LabelHeightMm   DECIMAL(6,2)  NOT NULL DEFAULT 45,
    TimeoutMs       INT           NOT NULL DEFAULT 3000,
    RetryCount      INT           NOT NULL DEFAULT 2,
    IsActive        BIT           NOT NULL DEFAULT 1,
    CreatedAt       DATETIME      NOT NULL DEFAULT GETDATE(),
    UpdatedAt       DATETIME      NULL
);
GO

CREATE TABLE GTP_PrintLog (
    LogID        INT IDENTITY(1,1) PRIMARY KEY,
    DeviceCode   NVARCHAR(50) NOT NULL,
    BoxID        INT NULL REFERENCES GTP_PickBoxes(BoxID),
    LabelType    NVARCHAR(20) NOT NULL,   -- Identification | Contents | Test
    Status       NVARCHAR(10) NOT NULL,   -- Success | Failed
    ErrorMessage NVARCHAR(500) NULL,
    CreatedAt    DATETIME NOT NULL DEFAULT GETDATE(),
    CompletedAt  DATETIME NULL
);
GO
CREATE INDEX IX_PrintLog_Device ON GTP_PrintLog (DeviceCode, CreatedAt DESC);
GO
