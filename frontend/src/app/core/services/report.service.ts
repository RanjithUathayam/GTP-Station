import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  PickingReportData, PickingReportFilters, ReportOperatorOption, ReportExportFormat,
} from '../models/report.models';

@Injectable({ providedIn: 'root' })
export class ReportService {
  private base = `${environment.apiUrl}/reports`;

  constructor(private http: HttpClient) {}

  private buildParams(filters: PickingReportFilters): HttpParams {
    let p = new HttpParams()
      .set('fromDate', filters.fromDate)
      .set('toDate', filters.toDate);
    if (filters.stationId)             p = p.set('stationId', filters.stationId);
    if (filters.headerId)              p = p.set('headerId', filters.headerId);
    if (filters.operatorId != null)    p = p.set('operatorId', String(filters.operatorId));
    return p;
  }

  getPickingReport(filters: PickingReportFilters): Observable<{ success: boolean; data: PickingReportData }> {
    return this.http.get<any>(`${this.base}/picking`, { params: this.buildParams(filters) });
  }

  getFilterStations(): Observable<{ success: boolean; data: string[] }> {
    return this.http.get<any>(`${this.base}/filters/stations`);
  }

  getFilterOperators(): Observable<{ success: boolean; data: ReportOperatorOption[] }> {
    return this.http.get<any>(`${this.base}/filters/operators`);
  }

  exportPickingReport(format: ReportExportFormat, filters: PickingReportFilters): Observable<{ blob: Blob; filename: string }> {
    const params = this.buildParams(filters).set('format', format);
    return this.http
      .get(`${this.base}/picking/export`, { params, responseType: 'blob', observe: 'response' })
      .pipe(map(resp => ({
        blob: resp.body as Blob,
        filename: this.extractFilename(resp.headers.get('Content-Disposition'))
                  ?? `picking-report_${filters.fromDate}_to_${filters.toDate}.${format}`,
      })));
  }

  private extractFilename(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    return plain ? plain[1] : null;
  }
}
