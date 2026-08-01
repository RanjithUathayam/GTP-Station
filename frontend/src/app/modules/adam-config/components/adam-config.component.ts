import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { AdamConfigService, AdamDeviceConfigInput } from '../../../core/services/adam-config.service';
import { NotificationService } from '../../../core/services/notification.service';
import { AdamDeviceConfig } from '../../../core/models';

const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

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

  constructor(
    private api: AdamConfigService,
    private notify: NotificationService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.refresh();
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
}
