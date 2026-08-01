export interface PickingReportRow {
  reportDate:                     string;   // 'YYYY-MM-DD'
  gtpStation:                     string;
  totalPicklists:                 number;
  totalOrders:                    number;
  totalItemsPicked:               number;
  totalPickedQty:                 number;
  completedPicklists:             number;
  pendingPicklists:               number;
  abandonedPicklists:             number;
  processingStartTime:            string | null;  // ISO datetime
  processingEndTime:              string | null;  // ISO datetime
  totalProcessingDurationSeconds: number;
  avgPickingTimeSeconds:          number | null;
  operatorNames:                  string;
}

export interface PickingReportSummary {
  totalStations:      number;
  totalPicklists:     number;
  totalOrders:        number;
  totalItemsPicked:   number;
  totalPickedQty:     number;
  completedPicklists: number;
  pendingPicklists:   number;
  abandonedPicklists: number;
}

export interface PickingReportData {
  rows:    PickingReportRow[];
  summary: PickingReportSummary;
}

export interface PickingReportFilters {
  fromDate:    string;          // 'YYYY-MM-DD'
  toDate:      string;          // 'YYYY-MM-DD'
  stationId?:  string | null;   // null/omitted = all stations
  headerId?:   string;          // optional partial picklist-number match
  operatorId?: number | null;   // null/omitted = all operators
}

export interface ReportOperatorOption {
  OperatorID:   number;
  OperatorName: string;
}

export type ReportExportFormat = 'csv' | 'xlsx' | 'pdf';
