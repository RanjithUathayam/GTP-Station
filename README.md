# GTP Station — Put-to-Light Process System

A full-stack warehouse management application for **Goods-to-Person (GTP)** stations with
real-time **Put-to-Light** guidance, order fulfillment tracking, and inventory management.

## Stack

| Layer    | Technology                          |
|----------|-------------------------------------|
| Frontend | Angular 17 + Angular Material       |
| Backend  | Node.js + Express.js                |
| Database | Microsoft SQL Server (MSSQL)        |
| Realtime | WebSocket (ws library)              |

---

## Project Structure

```
GTP Station/
├── backend/                # Node.js Express API + WebSocket
│   ├── server.js
│   ├── .env.example
│   └── src/
│       ├── config/db.js
│       ├── db/schema.sql          ← Run this first
│       ├── middleware/
│       ├── services/
│       │   ├── websocketService.js
│       │   ├── orderService.js
│       │   ├── inventoryService.js
│       │   ├── stationService.js
│       │   └── putToLightService.js
│       ├── controllers/
│       └── routes/
│
└── frontend/               # Angular 17 SPA
    └── src/app/modules/
        ├── dashboard/      ← Overview stats + station status
        ├── orders/         ← Order list, detail, create dialog
        ├── put-to-light/   ← Operator view (main screen)
        │   ├── station-view/    ← 3-panel layout
        │   ├── bin-display/     ← Animated bin grid
        │   └── operator-panel/  ← Confirm-put UI
        ├── inventory/      ← Stock levels + adjustment
        └── stations/       ← Station & bin configuration
```

---

## Setup & Run

### 1. Create the Database

Open SQL Server Management Studio, create a database named `GTP_Station`, then run:

```sql
-- In SSMS, connect to your instance and run:
backend/src/db/schema.sql
```

### 2. Configure Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your DB credentials
npm install
npm run dev          # starts on http://localhost:3000
```

**`.env` example:**
```
DB_SERVER=localhost
DB_USER=sa
DB_PASS=YourPassword
DB_NAME=GTP_Station
DB_PORT=1433
PORT=3000
```

### 3. Start Frontend

```bash
cd frontend
npm install
npm start            # starts on http://localhost:4500
```

The Angular dev server proxies `/api` → `http://10.0.10.211:4501/api` via `proxy.conf.json`.

---

## API Endpoints

| Method | Endpoint                              | Description                         |
|--------|---------------------------------------|-------------------------------------|
| GET    | /api/dashboard/summary               | Dashboard stats + recent orders     |
| GET    | /api/dashboard/station-status        | All stations with bin counts        |
| GET    | /api/orders                          | List orders (paginated/filtered)    |
| GET    | /api/orders/:id                      | Order detail with items             |
| POST   | /api/orders                          | Create new order                    |
| DELETE | /api/orders/:id                      | Cancel order                        |
| GET    | /api/put-to-light/active             | Active PTL sessions                 |
| POST   | /api/put-to-light/start/:orderId     | Start order (assign bin + light on) |
| POST   | /api/put-to-light/confirm            | Confirm item placed in bin          |
| POST   | /api/put-to-light/complete/:orderId  | Force-complete order                |
| POST   | /api/put-to-light/cancel/:orderId    | Cancel active order                 |
| GET    | /api/put-to-light/events/:orderId    | Audit event log                     |
| GET    | /api/inventory                       | Inventory list (paginated)          |
| POST   | /api/inventory/adjust                | Manual stock adjustment             |
| POST   | /api/inventory/bulk-sync             | Bulk upsert items                   |
| GET    | /api/stations                        | All stations with bin counts        |
| GET    | /api/stations/:id                    | Station detail with bins            |
| POST   | /api/stations                        | Create station                      |
| POST   | /api/stations/:id/bins               | Add bin to station                  |
| GET    | /api/health                          | Health check                        |

---

## WebSocket Events

Connect to `ws://localhost:3000/ws` to receive live updates:

| Event             | Payload                           | When fired                      |
|-------------------|-----------------------------------|---------------------------------|
| `BIN_ACTIVATED`   | `{ BinCode, orderId, ... }`       | Order assigned to bin           |
| `BIN_DEACTIVATED` | `{ BinID }`                       | Bin freed after order done      |
| `ITEM_CONFIRMED`  | `{ orderId, itemId, putQty, ... }`| Item placed confirmed           |
| `ORDER_STARTED`   | `{ order, bin, items }`           | PTL session begins              |
| `ORDER_COMPLETED` | `{ orderId, orderNumber }`        | All items placed                |
| `ORDER_CANCELLED` | `{ orderId, orderNumber }`        | Order cancelled                 |
| `STATION_UPDATE`  | `{ stationId, bin }`              | Bin added/changed               |
| `INVENTORY_UPDATE`| `InventoryItem`                   | Stock adjusted                  |

---

## Put-to-Light Workflow

```
1. Operator selects a pending order from the right panel
2. System assigns the order to a free bin → BIN_ACTIVATED event
3. Bin light turns ON (animated indicator in UI)
4. Operator sees the current item to place (large quantity display)
5. Operator places item → clicks CONFIRM PUT
6. System records ITEM_CONFIRMED, advances to next item
7. When all items done → ORDER_COMPLETED → bin freed automatically
```

---

## Sync Inventory from BBLive (SAP B1)

Use the bulk-sync endpoint to push stock from the existing `[BBLive]` warehouse:

```js
// Example: sync ASRS warehouse stock
POST /api/inventory/bulk-sync
{
  "items": [
    { "ItemCode": "ITM-001", "ItemName": "...", "Brand": "UATHAYAM", "Qty": 100 }
  ]
}
```

---

## Database Tables

| Table             | Purpose                                    |
|-------------------|--------------------------------------------|
| `GTP_Stations`    | Physical GTP workstations                  |
| `GTP_Bins`        | Individual bin/slot at each station        |
| `GTP_Orders`      | Fulfillment orders                         |
| `GTP_OrderItems`  | Line items within an order                 |
| `GTP_Inventory`   | Available stock per item                   |
| `GTP_PTLEvents`   | Full audit trail of all PTL actions        |
| `GTP_Operators`   | Warehouse operators                        |
