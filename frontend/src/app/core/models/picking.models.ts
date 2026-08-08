export interface PicklistParty {
  cardCode:         string;
  cardName:         string;
  uArcode:          string;
  uBrand:           string;
  uSalPriceCode:    string;
  orderCount:       number;
  totalRequiredQty: number;
  totalPickedQty:   number;
  status:           'pending' | 'active' | 'completed';
  items:            PicklistItem[];
  orders:           PartyOrder[];
}

export interface PartyOrder {
  docEntry:         number;
  totalRequiredQty: number;
  totalPickedQty:   number;
  status:           'pending' | 'active' | 'completed';
  items:            PicklistItem[];
  boxGroups:        ItemGroupBoxSummary[];
}

export interface PickBox {
  boxId:            number;
  boxNumber:        number;
  targetQty:        number;
  pickedQty:        number;
  status:           'Pending' | 'Active' | 'Completed';
  completionMethod: 'Auto' | 'Manual' | null;
  boxCode?:         string;
  completedAt?:     string | null;
  boxTypeLabel?:    string | null;
}

export interface ItemGroupBoxSummary {
  cardCode:         string;
  docEntry:         number;
  itemGroupName:    string;
  totalQty:         number;
  capacity:         number;
  boxesRequired:    number;
  completedBoxes:   number;
  pendingBoxes:     number;
  currentBoxNumber: number | null;
  currentBox:       PickBox | null;
  boxes:            PickBox[];
}

export interface BoxType {
  BoxTypeID: number;
  Label:     string;
  SizeLWH:   string | null;
  IsActive:  boolean;
  CreatedAt?: string;
}

export interface BoxTypeCapacityCell {
  itemGroupName: string;
  capacity:      number;
}

export interface BoxTypeMatrixRow extends BoxType {
  capacities: BoxTypeCapacityCell[];
}

// Printed for an empty box, before anything is packed into it.
export interface BoxIdLabelData {
  companyName:      string;
  customerName:     string;
  picklistNumber:   string;
  salesOrderNumber: number;
  itemGroupName:    string;
  boxNumber:        string;   // human Box Number, e.g. "BX000025"
  boxTypeLabel:     string | null;
  boxSequence:      number;   // this box's position (Box X of totalBoxes)
  totalBoxes:       number;
  createdAt:        string;
}

// Printed on-demand after a completed box's QR code is scanned — a
// Product Name x Size pivot of everything actually packed into it.
export interface BoxContentsLabelData {
  companyName:      string;
  customerName:     string;
  picklistNumber:   string;
  salesOrderNumber: number;
  boxNumber:        string;
  itemGroupName:    string;
  products:         string[];
  sizes:            string[];
  matrix:           Record<string, Record<string, number>>;
  rowTotals:        Record<string, number>;
  colTotals:        Record<string, number>;
  grandTotal:       number;
}

export interface CompletedBoxRef {
  boxId:         number;
  boxNumber:     number;
  itemGroupName: string;
  cardCode:      string;
  docEntry:      number;
  targetQty:     number;
}

export interface NextActivatedBoxRef {
  boxId:       number;
  boxNumber:   number;
  autoPrinted?: boolean;
}

export interface ScannedPart {
  uniqueNumber: string;
  qty:          number;
}

export interface PicklistItem {
  itemCode:     string;
  itemName:     string;
  itemGroupName:string;
  size:         string;
  sleeve:       string;
  color:        string;
  docEntry:     number;
  orderQty:     number;
  requiredQty:  number;
  pickedQty:    number;
  uSalPriceCode:string;
  status:       'Pending' | 'InProgress' | 'Completed';
  scannedParts: ScannedPart[];
}

export interface PicklistPreview {
  headerId:          string;
  countofOrder:      number;
  joinOrder:         string | null;
  parties:           PicklistPartyPreview[];
  totalParties:      number;
  totalItems:        number;
  existingSessionId: number | null;
}

export interface PicklistPartyPreview {
  cardCode:         string;
  cardName:         string;
  orderCount:       number;
  itemCount:        number;
  totalRequiredQty: number;
}

export interface PicklistSession {
  sessionId:         number;
  headerId:          string;
  stationId:         string | null;
  countofOrder:      number;
  joinOrder:         string | null;
  status:            'InProgress' | 'Completed' | 'Abandoned';
  startedAt:         string;
  parties:           PicklistParty[];
  totalParties:      number;
  completedParties:  number;
  autoPrintedBoxIds?: number[];
}

export interface PickScanResult {
  itemCode:          string;
  scannedQty:        number;
  newPickedQty:      number;
  requiredQty:       number;
  itemCompleted:     boolean;
  partyCompleted:    boolean;
  picklistCompleted: boolean;
  nextItemCode:      string | null;
  completedBoxes:    CompletedBoxRef[];
  nextActivatedBox:  NextActivatedBoxRef | null;
}

export interface ScanFeedback {
  state:    'ready' | 'processing' | 'success' | 'invalid' | 'duplicate' | 'done' | 'error';
  message:  string;
  itemCode?: string;
}
