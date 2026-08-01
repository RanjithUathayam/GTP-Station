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
}

export interface ScanFeedback {
  state:    'ready' | 'processing' | 'success' | 'invalid' | 'duplicate' | 'done' | 'error';
  message:  string;
  itemCode?: string;
}
