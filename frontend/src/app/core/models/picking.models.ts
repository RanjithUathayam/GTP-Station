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

export interface BoxLabelLine {
  itemCode: string;
  styleNo:  string;
  color:    string;
  size:     string;
  barcode:  string;
  qty:      number;
}

export interface BoxLabelData {
  companyName:    string;
  customerName:   string;
  picklistNumber: string;
  docEntry:       number;
  itemGroupName:  string;
  boxNumber:      number;
  boxTypeLabel:   string | null;
  totalBoxes:     number;
  lines:          BoxLabelLine[];
  totalQty:       number;
  packedBy:       string;
  packedAt:       string | null;
  boxCode:        string;
  status:         string;
}

export interface CompletedBoxRef {
  boxId:         number;
  boxNumber:     number;
  itemGroupName: string;
  cardCode:      string;
  docEntry:      number;
  targetQty:     number;
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
}

export interface ScanFeedback {
  state:    'ready' | 'processing' | 'success' | 'invalid' | 'duplicate' | 'done' | 'error';
  message:  string;
  itemCode?: string;
}
