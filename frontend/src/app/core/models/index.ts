export interface Station {
  StationID: number;
  StationCode: string;
  StationName: string;
  Description?: string;
  IsActive: boolean;
  CreatedAt: string;
  TotalBins?: number;
  ActiveBins?: number;
  FreeBins?: number;
  bins?: Bin[];
}

export interface Bin {
  BinID: number;
  StationID: number;
  BinCode: string;
  BinRow: number;
  BinColumn: number;
  Capacity: number;
  LightColor: string;
  IsActive: boolean;
  CurrentOrderID?: number;
  // joined from order
  OrderNumber?: string;
  CustomerName?: string;
  Priority?: number;
  OrderStatus?: string;
  TotalItems?: number;
  PutItems?: number;
}

export type OrderStatus = 'Pending' | 'Assigned' | 'InProgress' | 'Completed' | 'Cancelled';

export interface Order {
  OrderID: number;
  OrderNumber: string;
  CustomerCode?: string;
  CustomerName?: string;
  Priority: 1 | 2 | 3;
  Status: OrderStatus;
  AssignedBinID?: number;
  OperatorID?: number;
  TotalItems: number;
  PutItems: number;
  Notes?: string;
  CreatedAt: string;
  AssignedAt?: string;
  StartedAt?: string;
  CompletedAt?: string;
  // joined
  BinCode?: string;
  LightColor?: string;
  BinRow?: number;
  BinColumn?: number;
  StationCode?: string;
  StationName?: string;
  OperatorName?: string;
  items?: OrderItem[];
}

export type ItemStatus = 'Pending' | 'InProgress' | 'Completed' | 'Skipped';

export interface OrderItem {
  ItemID: number;
  OrderID: number;
  SortSeq: number;
  ItemCode: string;
  ItemName: string;
  SKU?: string;
  RequiredQty: number;
  PutQty: number;
  UOM: string;
  Status: ItemStatus;
  CompletedAt?: string;
}

export interface InventoryItem {
  InventoryID: number;
  ItemCode: string;
  ItemName: string;
  Brand?: string;
  Category?: string;
  StyleCode?: string;
  SizeCode?: string;
  ColorCode?: string;
  UOM: string;
  AvailableQty: number;
  ReservedQty: number;
  FreeQty: number;
  MinQty: number;
  WarehouseCode?: string;
  LastUpdated: string;
  IsActive: boolean;
}

export interface PTLSession {
  OrderID: number;
  OrderNumber: string;
  CustomerName?: string;
  Priority: number;
  Status: string;
  TotalItems: number;
  PutItems: number;
  StartedAt: string;
  BinID: number;
  BinCode: string;
  BinRow: number;
  BinColumn: number;
  LightColor: string;
  StationID: number;
  StationCode: string;
  StationName: string;
  OperatorName?: string;
}

export interface ScanResult {
  orderId:     number;
  orderNumber: string;
  itemId:      number;
  itemCode:    string;
  itemName:    string;
  scannedQty:  number;
  allDone:     boolean;
}

export interface PagedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdamDeviceConfig {
  DeviceConfigID: number;
  DeviceCode: string;
  IpAddress: string;
  Port: number;
  UnitId: number;
  OutputStartChannel: number;
  OutputEndChannel: number;
  MacAddress: string | null;
  IsActive: boolean;
  CreatedAt: string;
  UpdatedAt?: string | null;
}

export interface PrinterConfig {
  PrinterConfigID: number;
  DeviceCode: string;
  PrinterName: string;
  IpAddress: string;
  Port: number;
  PrinterType: string;
  Protocol: 'ZPL' | 'EPL' | 'TSPL' | 'CPCL' | 'ESCPOS' | 'RAW' | 'WindowsDriver';
  DPI: number;
  PaperWidthMm: number;
  LabelHeightMm: number;
  TimeoutMs: number;
  RetryCount: number;
  IsActive: boolean;
  CreatedAt: string;
  UpdatedAt?: string | null;
}

export interface WsMessage {
  type: string;
  data: unknown;
  timestamp: string;
}
