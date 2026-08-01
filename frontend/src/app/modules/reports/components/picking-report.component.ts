import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, ViewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatTableDataSource } from '@angular/material/table';
import { MatSort } from '@angular/material/sort';
import { MatPaginator } from '@angular/material/paginator';
import { ReportService } from '../../../core/services/report.service';
import { NotificationService } from '../../../core/services/notification.service';
import {
  PickingReportRow, PickingReportSummary, PickingReportFilters,
  ReportOperatorOption, ReportExportFormat,
} from '../../../core/models/report.models';

interface FilterFormModel {
  fromDate:   Date | null;
  toDate:     Date | null;
  stationId:  string | null;   // null = All Stations
  headerId:   string;
  operatorId: number | null;   // null = All Operators
}

function emptySummary(): PickingReportSummary {
  return {
    totalStations: 0, totalPicklists: 0, totalOrders: 0, totalItemsPicked: 0,
    totalPickedQty: 0, completedPicklists: 0, pendingPicklists: 0, abandonedPicklists: 0,
  };
}

interface KpiTile {
  key:    keyof PickingReportSummary;
  label:  string;
  icon:   string;
  accent?: 'good' | 'warning';
}

const KPI_TILES: KpiTile[] = [
  { key: 'totalStations',      label: 'Total stations',      icon: 'store' },
  { key: 'totalPicklists',     label: 'Total picklists',     icon: 'assignment' },
  { key: 'totalOrders',        label: 'Total orders',        icon: 'receipt_long' },
  { key: 'totalItemsPicked',   label: 'Total items picked',  icon: 'inventory_2' },
  { key: 'totalPickedQty',     label: 'Total picked quantity', icon: 'inventory' },
  { key: 'completedPicklists', label: 'Completed picklists', icon: 'check_circle', accent: 'good' },
  { key: 'pendingPicklists',   label: 'Pending picklists',   icon: 'hourglass_empty', accent: 'warning' },
];

@Component({
  selector: 'app-picking-report',
  templateUrl: './picking-report.component.html',
  styleUrls: ['./picking-report.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [DatePipe],
})
export class PickingReportComponent implements OnInit, AfterViewInit {
  @ViewChild(MatSort) sort!: MatSort;
  @ViewChild(MatPaginator) paginator!: MatPaginator;

  readonly kpiTiles = KPI_TILES;
  readonly displayedColumns: string[] = [
    'reportDate', 'gtpStation', 'totalPicklists', 'totalOrders', 'totalItemsPicked', 'totalPickedQty',
    'completedPicklists', 'pendingPicklists', 'abandonedPicklists',
    'processingStartTime', 'processingEndTime', 'totalProcessingDurationSeconds',
    'avgPickingTimeSeconds', 'operatorNames',
  ];

  dataSource = new MatTableDataSource<PickingReportRow>([]);
  summary: PickingReportSummary = emptySummary();

  filterForm: FilterFormModel = this.defaultFilterForm();
  filterError = '';
  quickFilterValue = '';

  stationOptions: string[] = [];
  operatorOptions: ReportOperatorOption[] = [];

  loading = false;
  loadError: string | null = null;
  currentFilters: PickingReportFilters | null = null;
  private lastAttemptedFilters: PickingReportFilters | null = null;

  exporting: Record<ReportExportFormat, boolean> = { csv: false, xlsx: false, pdf: false };

  constructor(
    private reportService: ReportService,
    private notify: NotificationService,
    private datePipe: DatePipe,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.dataSource.sortingDataAccessor = (row, id) => {
      if (id === 'processingStartTime' || id === 'processingEndTime') {
        return (row as any)[id] ?? '';
      }
      return (row as any)[id];
    };
    this.dataSource.filterPredicate = (row, filter) => this.searchableText(row).includes(filter);

    this.reportService.getFilterStations().subscribe({
      next: (r) => { this.stationOptions = r.data; this.cdr.markForCheck(); },
      error: () => {},
    });
    this.reportService.getFilterOperators().subscribe({
      next: (r) => { this.operatorOptions = r.data; this.cdr.markForCheck(); },
      error: () => {},
    });

    this.search();
  }

  ngAfterViewInit(): void {
    this.dataSource.sort = this.sort;
    this.dataSource.paginator = this.paginator;
  }

  private defaultFilterForm(): FilterFormModel {
    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 6);
    return { fromDate: weekAgo, toDate: today, stationId: null, headerId: '', operatorId: null };
  }

  private toDateOnlyString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private validateRange(): string | null {
    if (!this.filterForm.fromDate || !this.filterForm.toDate) return 'Both From Date and To Date are required.';
    if (this.filterForm.fromDate > this.filterForm.toDate) return 'From Date must be on or before To Date.';
    return null;
  }

  private buildFilters(): PickingReportFilters {
    return {
      fromDate:   this.toDateOnlyString(this.filterForm.fromDate!),
      toDate:     this.toDateOnlyString(this.filterForm.toDate!),
      stationId:  this.filterForm.stationId,
      headerId:   this.filterForm.headerId?.trim() || undefined,
      operatorId: this.filterForm.operatorId,
    };
  }

  search(): void {
    this.filterError = this.validateRange() || '';
    if (this.filterError) return;
    this.runQuery(this.buildFilters());
  }

  retry(): void {
    if (this.lastAttemptedFilters) this.runQuery(this.lastAttemptedFilters);
  }

  private runQuery(filters: PickingReportFilters): void {
    this.loading = true;
    this.loadError = null;
    this.lastAttemptedFilters = filters;

    this.reportService.getPickingReport(filters).subscribe({
      next: (r) => {
        this.currentFilters = filters;
        this.dataSource.data = r.data.rows;
        this.summary = r.data.summary;
        this.loading = false;
        this.quickFilterValue = '';
        this.dataSource.filter = '';
        this.paginator?.firstPage();
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loading = false;
        this.loadError = this._extractErrorMessage(err, 'Failed to load picking report');
        this.cdr.markForCheck();
      },
    });
  }

  onQuickFilterChange(value: string): void {
    this.quickFilterValue = value;
    this.dataSource.filter = value.trim().toLowerCase();
    this.paginator?.firstPage();
  }

  private searchableText(row: PickingReportRow): string {
    const parts = [
      this.datePipe.transform(row.reportDate + 'T00:00:00', 'dd MMM yyyy'),
      row.gtpStation,
      row.totalPicklists, row.totalOrders, row.totalItemsPicked, row.totalPickedQty,
      row.completedPicklists, row.pendingPicklists, row.abandonedPicklists,
      row.processingStartTime ? this.datePipe.transform(row.processingStartTime, 'dd MMM yyyy HH:mm:ss') : '',
      row.processingEndTime   ? this.datePipe.transform(row.processingEndTime,   'dd MMM yyyy HH:mm:ss') : '',
      this.formatDuration(row.totalProcessingDurationSeconds),
      this.formatDuration(row.avgPickingTimeSeconds),
      row.operatorNames,
    ];
    return parts.join(' ').toLowerCase();
  }

  formatDuration(totalSeconds: number | null): string {
    if (totalSeconds == null) return '-';
    const secs = Math.max(0, Math.round(totalSeconds));
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return days > 0 ? `${days}:${pad(hours)}:${pad(mins)}:${pad(s)}` : `${pad(hours)}:${pad(mins)}:${pad(s)}`;
  }

  exportReport(format: ReportExportFormat): void {
    if (!this.currentFilters || this.exporting[format]) return;
    this.exporting[format] = true;
    this.reportService.exportPickingReport(format, this.currentFilters).subscribe({
      next: ({ blob, filename }) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        window.URL.revokeObjectURL(url);
        this.exporting[format] = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.exporting[format] = false;
        this.notify.error(this._extractErrorMessage(err, `Failed to export ${format.toUpperCase()}`));
        this.cdr.markForCheck();
      },
    });
  }

  private _extractErrorMessage(err: any, fallback: string): string {
    if (err?.error?.message) return err.error.message;
    if (err?.status === 0) return 'Cannot reach the API server — check that the backend is running and reachable.';
    if (err?.status) return `${fallback} (HTTP ${err.status})`;
    return fallback;
  }
}
