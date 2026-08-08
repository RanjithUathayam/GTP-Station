import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { AdamConfigService, AdamDeviceConfigInput } from '../../../core/services/adam-config.service';
import { PrinterService, PrinterConfigInput } from '../../../core/services/printer.service';
import { NotificationService } from '../../../core/services/notification.service';
import { AdamDeviceConfig, PrinterConfig } from '../../../core/models';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

const PRINTER_PROTOCOLS: PrinterConfig['Protocol'][] = ['ZPL', 'EPL', 'TSPL', 'CPCL', 'ESCPOS', 'RAW', 'WindowsDriver'];
const PRINTER_TYPES = ['Zebra', 'TSC', 'Honeywell', 'SATO', 'Godex', 'Citizen', 'Brother', 'Epson', 'Generic'];

interface PrinterFormModel {
  deviceCode: string;
  printerName: string;
  ipAddress: string;
  port: number;
  printerType: string;
  protocol: PrinterConfig['Protocol'];
  dpi: number;
  paperWidthMm: number;
  labelHeightMm: number;
  timeoutMs: number;
  retryCount: number;
  isActive: boolean;
}

function emptyPrinterForm(): PrinterFormModel {
  return {
    deviceCode: '',
    printerName: '',
    ipAddress: '',
    port: 9100,
    printerType: 'Generic',
    protocol: 'RAW',
    dpi: 203,
    paperWidthMm: 90,
    labelHeightMm: 45,
    timeoutMs: 3000,
    retryCount: 2,
    isActive: true,
  };
}

interface FormModel {
  deviceCode: string;
  ipAddress: string;
  port: number;
  unitId: number;
  outputStartChannel: number;
  outputEndChannel: number;
  macAddress: string;
  isActive: boolean;
}

function emptyForm(): FormModel {
  return {
    deviceCode: '',
    ipAddress: '',
    port: 502,
    unitId: 1,
    outputStartChannel: 0,
    outputEndChannel: 3,
    macAddress: '',
    isActive: true,
  };
}

@Component({
  selector: 'app-adam-config',
  templateUrl: './adam-config.component.html',
  styleUrls: ['./adam-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdamConfigComponent implements OnInit {
  readonly displayedColumns = ['code', 'ip', 'channels', 'mac', 'active', 'actions'];

  configs: AdamDeviceConfig[] = [];
  loading = false;
  loadError: string | null = null;

  formOpen = false;
  editing: AdamDeviceConfig | null = null;
  form: FormModel = emptyForm();
  formError = '';
  saving = false;
  detecting = false;

  // ── Station Label Printers ──────────────────────────────────
  readonly printerColumns = ['code', 'printer', 'endpoint', 'protocol', 'active', 'status', 'actions'];
  readonly printerProtocols = PRINTER_PROTOCOLS;
  readonly printerTypes = PRINTER_TYPES;

  printers: PrinterConfig[] = [];
  printersLoading = false;
  printersLoadError: string | null = null;

  printerFormOpen = false;
  editingPrinter: PrinterConfig | null = null;
  printerForm: PrinterFormModel = emptyPrinterForm();
  printerFormError = '';
  printerSaving = false;

  printerStatus: Record<string, 'online' | 'offline' | 'unknown'> = {};
  printerCheckingStatus = new Set<string>();
  printerTesting = new Set<string>();

  constructor(
    private api: AdamConfigService,
    private printerApi: PrinterService,
    private notify: NotificationService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.refresh();
    this.refreshPrinters();
  }

  refresh(): void {
    this.loading = true;
    this.loadError = null;

    this.api.list().subscribe({
      next: (r) => {
        this.configs = r.data;
        this.loading = false;
        this.loadError = null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('[AdamConfig] Failed to load device configs', err);
        this.configs = [];
        this.loading = false;
        this.loadError = this._extractErrorMessage(err, 'Failed to load ADAM device configs');
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

  openAddForm(): void {
    this.editing = null;
    this.form = emptyForm();
    this.formError = '';
    this.formOpen = true;
  }

  openEditForm(config: AdamDeviceConfig): void {
    this.editing = config;
    this.form = {
      deviceCode: config.DeviceCode,
      ipAddress: config.IpAddress,
      port: config.Port,
      unitId: config.UnitId,
      outputStartChannel: config.OutputStartChannel,
      outputEndChannel: config.OutputEndChannel,
      macAddress: config.MacAddress || '',
      isActive: config.IsActive,
    };
    this.formError = '';
    this.formOpen = true;
  }

  closeForm(): void {
    this.formOpen = false;
    this.editing = null;
  }

  detectMac(): void {
    const ip = this.form.ipAddress?.trim();
    if (!ip) {
      this.formError = 'Enter the IP address first';
      return;
    }
    this.detecting = true;
    this.formError = '';
    this.api.detectMac(ip).subscribe({
      next: (r) => {
        this.detecting = false;
        if (r.data.mac) {
          this.form.macAddress = r.data.mac;
          this.notify.success(`Detected MAC ${r.data.mac} for ${ip}`);
        } else {
          this.notify.error(`Could not resolve a MAC address for ${ip} — is the device powered on and reachable?`);
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.detecting = false;
        this.notify.error(err.error?.message || 'MAC detection failed');
        this.cdr.markForCheck();
      },
    });
  }

  private _validate(): string | null {
    if (!this.form.deviceCode?.trim()) return 'Device code is required';
    if (!this.form.ipAddress?.trim()) return 'IP address is required';
    const s = Number(this.form.outputStartChannel);
    const e = Number(this.form.outputEndChannel);
    if (Number.isNaN(s) || Number.isNaN(e) || s < 0 || e > 7 || s > e) {
      return 'Output channels must be within 0-7 with start <= end';
    }
    if (this.form.macAddress && !MAC_RE.test(this.form.macAddress.trim())) {
      return 'MAC address must look like AA:BB:CC:DD:EE:FF';
    }
    return null;
  }

  save(): void {
    const err = this._validate();
    if (err) { this.formError = err; return; }

    this.saving = true;
    this.formError = '';

    const body: AdamDeviceConfigInput = {
      deviceCode: this.form.deviceCode.trim(),
      ipAddress: this.form.ipAddress.trim(),
      port: this.form.port,
      unitId: this.form.unitId,
      outputStartChannel: Number(this.form.outputStartChannel),
      outputEndChannel: Number(this.form.outputEndChannel),
      macAddress: this.form.macAddress?.trim() || null,
      isActive: this.form.isActive,
    };

    const obs = this.editing
      ? this.api.update(this.editing.DeviceConfigID, body)
      : this.api.create(body);

    obs.subscribe({
      next: () => {
        this.saving = false;
        this.notify.success(this.editing ? 'Device config updated' : 'Device config created');
        this.closeForm();
        this.refresh();
      },
      error: (e) => {
        this.saving = false;
        this.formError = e.error?.message || 'Failed to save device config';
        this.cdr.markForCheck();
      },
    });
  }

  deleteConfig(config: AdamDeviceConfig): void {
    if (!confirm(`Deactivate the ADAM device config "${config.DeviceCode}"?`)) return;
    this.api.remove(config.DeviceConfigID).subscribe({
      next: () => {
        this.notify.success(`Deactivated device config "${config.DeviceCode}"`);
        this.refresh();
      },
      error: (err) => this.notify.error(err.error?.message || 'Failed to deactivate device config'),
    });
  }

  // ════════════════════════════════════════════════════════════
  // Station Label Printers
  // ════════════════════════════════════════════════════════════

  refreshPrinters(): void {
    this.printersLoading = true;
    this.printersLoadError = null;

    this.printerApi.list().subscribe({
      next: (r) => {
        this.printers = r.data;
        this.printersLoading = false;
        this.printersLoadError = null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.printers = [];
        this.printersLoading = false;
        this.printersLoadError = this._extractErrorMessage(err, 'Failed to load printer configs');
        this.cdr.markForCheck();
      },
    });
  }

  openAddPrinterForm(): void {
    this.editingPrinter = null;
    this.printerForm = emptyPrinterForm();
    this.printerFormError = '';
    this.printerFormOpen = true;
  }

  openEditPrinterForm(p: PrinterConfig): void {
    this.editingPrinter = p;
    this.printerForm = {
      deviceCode: p.DeviceCode,
      printerName: p.PrinterName,
      ipAddress: p.IpAddress,
      port: p.Port,
      printerType: p.PrinterType,
      protocol: p.Protocol,
      dpi: p.DPI,
      paperWidthMm: p.PaperWidthMm,
      labelHeightMm: p.LabelHeightMm,
      timeoutMs: p.TimeoutMs,
      retryCount: p.RetryCount,
      isActive: p.IsActive,
    };
    this.printerFormError = '';
    this.printerFormOpen = true;
  }

  closePrinterForm(): void {
    this.printerFormOpen = false;
    this.editingPrinter = null;
  }

  private _validatePrinter(): string | null {
    if (!this.printerForm.deviceCode?.trim()) return 'Device code is required';
    if (!this.printerForm.printerName?.trim()) return 'Printer name is required';
    if (!this.printerForm.ipAddress?.trim()) return 'IP address is required';
    return null;
  }

  savePrinter(): void {
    const err = this._validatePrinter();
    if (err) { this.printerFormError = err; return; }

    this.printerSaving = true;
    this.printerFormError = '';

    const body: PrinterConfigInput = {
      deviceCode: this.printerForm.deviceCode.trim(),
      printerName: this.printerForm.printerName.trim(),
      ipAddress: this.printerForm.ipAddress.trim(),
      port: Number(this.printerForm.port),
      printerType: this.printerForm.printerType,
      protocol: this.printerForm.protocol,
      dpi: Number(this.printerForm.dpi),
      paperWidthMm: Number(this.printerForm.paperWidthMm),
      labelHeightMm: Number(this.printerForm.labelHeightMm),
      timeoutMs: Number(this.printerForm.timeoutMs),
      retryCount: Number(this.printerForm.retryCount),
      isActive: this.printerForm.isActive,
    };

    const obs = this.editingPrinter
      ? this.printerApi.update(this.editingPrinter.PrinterConfigID, body)
      : this.printerApi.create(body);

    obs.subscribe({
      next: () => {
        this.printerSaving = false;
        this.notify.success(this.editingPrinter ? 'Printer config updated' : 'Printer config created');
        this.closePrinterForm();
        this.refreshPrinters();
      },
      error: (e) => {
        this.printerSaving = false;
        this.printerFormError = e.error?.message || 'Failed to save printer config';
        this.cdr.markForCheck();
      },
    });
  }

  deletePrinter(p: PrinterConfig): void {
    if (!confirm(`Deactivate the station printer "${p.PrinterName}" (${p.DeviceCode})?`)) return;
    this.printerApi.remove(p.PrinterConfigID).subscribe({
      next: () => {
        this.notify.success(`Deactivated printer "${p.PrinterName}"`);
        this.refreshPrinters();
      },
      error: (err) => this.notify.error(err.error?.message || 'Failed to deactivate printer config'),
    });
  }

  checkPrinterStatus(p: PrinterConfig): void {
    this.printerCheckingStatus.add(p.DeviceCode);
    this.printerApi.getStatus(p.DeviceCode).subscribe({
      next: (r) => {
        this.printerCheckingStatus.delete(p.DeviceCode);
        this.printerStatus[p.DeviceCode] = r.data.online ? 'online' : 'offline';
        this.cdr.markForCheck();
      },
      error: () => {
        this.printerCheckingStatus.delete(p.DeviceCode);
        this.printerStatus[p.DeviceCode] = 'unknown';
        this.cdr.markForCheck();
      },
    });
  }

  testPrintPrinter(p: PrinterConfig): void {
    this.printerTesting.add(p.DeviceCode);
    this.printerApi.testPrint(p.DeviceCode).subscribe({
      next: (r) => {
        this.printerTesting.delete(p.DeviceCode);
        if (r.data.printed) {
          this.notify.success(`Test label sent to "${p.PrinterName}"`);
        } else {
          this.notify.error(r.data.error || `Test print to "${p.PrinterName}" failed`);
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.printerTesting.delete(p.DeviceCode);
        this.notify.error(err.error?.message || 'Test print failed');
        this.cdr.markForCheck();
      },
    });
  }
}
