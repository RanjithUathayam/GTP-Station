import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { PrinterConfig } from '../models';

export interface PrinterConfigInput {
  deviceCode: string;
  printerName: string;
  ipAddress: string;
  port?: number;
  printerType?: string;
  protocol: PrinterConfig['Protocol'];
  dpi?: number;
  paperWidthMm?: number;
  labelHeightMm?: number;
  timeoutMs?: number;
  retryCount?: number;
  isActive?: boolean;
}

export interface PrinterStatus {
  deviceCode: string;
  exists: boolean;
  online: boolean;
  checkedAt?: string;
}

export interface PrintLogEntry {
  LogID: number;
  DeviceCode: string;
  BoxID: number | null;
  LabelType: string;
  Status: 'Success' | 'Failed';
  ErrorMessage: string | null;
  CreatedAt: string;
  CompletedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class PrinterService {
  private base = `${environment.apiUrl}/printers`;

  constructor(private http: HttpClient) {}

  list(): Observable<{ success: boolean; data: PrinterConfig[] }> {
    return this.http.get<any>(this.base);
  }

  create(body: PrinterConfigInput): Observable<{ success: boolean; data: PrinterConfig }> {
    return this.http.post<any>(this.base, body);
  }

  update(id: number, body: Partial<PrinterConfigInput>): Observable<{ success: boolean; data: PrinterConfig }> {
    return this.http.put<any>(`${this.base}/${id}`, body);
  }

  remove(id: number): Observable<{ success: boolean }> {
    return this.http.delete<any>(`${this.base}/${id}`);
  }

  getStatus(deviceCode: string): Observable<{ success: boolean; data: PrinterStatus }> {
    return this.http.get<any>(`${this.base}/${encodeURIComponent(deviceCode)}/status`);
  }

  testPrint(deviceCode: string): Observable<{ success: boolean; data: { printed: boolean; error?: string } }> {
    return this.http.post<any>(`${this.base}/${encodeURIComponent(deviceCode)}/test-print`, {});
  }

  getLogs(deviceCode: string, limit = 20): Observable<{ success: boolean; data: PrintLogEntry[] }> {
    return this.http.get<any>(`${this.base}/${encodeURIComponent(deviceCode)}/logs`, { params: { limit } as any });
  }
}
