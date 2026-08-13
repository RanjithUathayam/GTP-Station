import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  Order, OrderItem, InventoryItem,
  Station, PTLSession, PagedResponse, ScanResult
} from '../models';
import {
  BoxIdLabelData, BoxContentsLabelData, ItemGroupBoxSummary, PickBox, BoxType, BoxTypeMatrixRow,
  NextActivatedBoxRef,
} from '../models/picking.models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private base = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // ─── Orders ───────────────────────────────────────────────
  getOrders(params: Record<string, unknown> = {}): Observable<PagedResponse<Order>> {
    let p = new HttpParams();
    Object.entries(params).forEach(([k, v]) => { if (v != null) p = p.set(k, String(v)); });
    return this.http.get<PagedResponse<Order>>(`${this.base}/orders`, { params: p });
  }

  getOrder(id: number): Observable<{ success: boolean; data: Order }> {
    return this.http.get<any>(`${this.base}/orders/${id}`);
  }

  createOrder(body: Partial<Order> & { items: Partial<OrderItem>[] }): Observable<{ success: boolean; data: Order }> {
    return this.http.post<any>(`${this.base}/orders`, body);
  }

  cancelOrder(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.base}/orders/${id}`);
  }

  // ─── Put-to-Light ─────────────────────────────────────────
  getActiveSessions(): Observable<{ success: boolean; data: PTLSession[] }> {
    return this.http.get<any>(`${this.base}/put-to-light/active`);
  }

  startOrder(orderId: number, operatorId?: number, stationId?: number): Observable<any> {
    return this.http.post<any>(`${this.base}/put-to-light/start/${orderId}`, { operatorId, stationId });
  }

  confirmItem(orderId: number, itemId: number, qty?: number, operatorId?: number): Observable<any> {
    return this.http.post<any>(`${this.base}/put-to-light/confirm`, { orderId, itemId, qty, operatorId });
  }

  scanQr(orderNumber: string, itemCode: string, qty: number, operatorId?: number): Observable<{ success: boolean; data: ScanResult }> {
    return this.http.post<any>(`${this.base}/put-to-light/scan`, { orderNumber, itemCode, qty, operatorId });
  }

  completeOrder(orderId: number, operatorId?: number): Observable<any> {
    return this.http.post<any>(`${this.base}/put-to-light/complete/${orderId}`, { operatorId });
  }

  cancelPTL(orderId: number, operatorId?: number): Observable<any> {
    return this.http.post<any>(`${this.base}/put-to-light/cancel/${orderId}`, { operatorId });
  }

  getEventLog(orderId: number): Observable<{ success: boolean; data: any[] }> {
    return this.http.get<any>(`${this.base}/put-to-light/events/${orderId}`);
  }

  // ─── Inventory ────────────────────────────────────────────
  getInventory(params: Record<string, unknown> = {}): Observable<PagedResponse<InventoryItem>> {
    let p = new HttpParams();
    Object.entries(params).forEach(([k, v]) => { if (v != null) p = p.set(k, String(v)); });
    return this.http.get<PagedResponse<InventoryItem>>(`${this.base}/inventory`, { params: p });
  }

  getInventoryItem(code: string): Observable<{ success: boolean; data: InventoryItem }> {
    return this.http.get<any>(`${this.base}/inventory/${code}`);
  }

  adjustStock(itemCode: string, delta: number, reason?: string): Observable<any> {
    return this.http.post<any>(`${this.base}/inventory/adjust`, { itemCode, delta, reason });
  }

  // ─── GTP Picking ──────────────────────────────────────────
  loadPicklist(headerId: string): Observable<{ success: boolean; data: any }> {
    return this.http.get<any>(`${this.base}/picking/picklist/${encodeURIComponent(headerId)}`);
  }

  resumePicklistSession(headerId: string): Observable<{ success: boolean; data: any }> {
    return this.http.get<any>(`${this.base}/picking/picklist/${encodeURIComponent(headerId)}/resume`);
  }

  startPicklistSession(headerId: string, operatorId?: number, stationId?: string): Observable<{ success: boolean; data: any }> {
    return this.http.post<any>(`${this.base}/picking/session/start`, { headerId, operatorId, stationId });
  }

  getPicklistSession(sessionId: number): Observable<{ success: boolean; data: any }> {
    return this.http.get<any>(`${this.base}/picking/session/${sessionId}`);
  }

  processPickScan(sessionId: number, barcode: string, cardCode: string, docEntry: number): Observable<{ success: boolean; data: any }> {
    return this.http.post<any>(`${this.base}/picking/session/${sessionId}/scan`, { barcode, cardCode, docEntry });
  }

  // ─── Box Types + capacity matrix (single source of truth for box capacity) ───
  getBoxTypes(): Observable<{ success: boolean; data: BoxType[] }> {
    return this.http.get<any>(`${this.base}/picking/box-types`);
  }

  upsertBoxType(label: string, sizeLWH?: string): Observable<{ success: boolean; data: BoxType[] }> {
    return this.http.post<any>(`${this.base}/picking/box-types`, { label, sizeLWH });
  }

  deleteBoxType(boxTypeId: number): Observable<{ success: boolean; data: BoxType[] }> {
    return this.http.delete<any>(`${this.base}/picking/box-types/${boxTypeId}`);
  }

  getBoxTypeMatrix(): Observable<{ success: boolean; data: BoxTypeMatrixRow[] }> {
    return this.http.get<any>(`${this.base}/picking/box-types/matrix`);
  }

  upsertBoxTypeCapacity(boxTypeId: number, itemGroupName: string, capacity: number): Observable<{ success: boolean; data: BoxTypeMatrixRow[] }> {
    return this.http.post<any>(`${this.base}/picking/box-types/${boxTypeId}/capacity`, { itemGroupName, capacity });
  }

  deleteBoxTypeCapacity(boxTypeId: number, itemGroupName: string): Observable<{ success: boolean; data: BoxTypeMatrixRow[] }> {
    return this.http.delete<any>(`${this.base}/picking/box-types/${boxTypeId}/capacity/${encodeURIComponent(itemGroupName)}`);
  }

  completeBox(boxId: number, operatorId?: number): Observable<{ success: boolean; data: PickBox & { nextActivatedBox: NextActivatedBoxRef | null } }> {
    return this.http.post<any>(`${this.base}/picking/box/${boxId}/complete`, { operatorId });
  }

  getBoxIdLabel(boxId: number): Observable<{ success: boolean; data: BoxIdLabelData }> {
    return this.http.get<any>(`${this.base}/picking/box/${boxId}/id-label`);
  }

  getBoxContentsByNumber(boxNumber: string): Observable<{ success: boolean; data: BoxContentsLabelData }> {
    return this.http.get<any>(`${this.base}/picking/box-lookup/${encodeURIComponent(boxNumber)}/contents`);
  }

  getSessionBoxes(sessionId: number): Observable<{ success: boolean; data: ItemGroupBoxSummary[] }> {
    return this.http.get<any>(`${this.base}/picking/session/${sessionId}/boxes`);
  }

  // ─── Delivery Status ────────────────────────────────────────
  getPicklistSessions(): Observable<{ success: boolean; data: any[] }> {
    return this.http.get<any>(`${this.base}/picking/sessions`);
  }

  retryDocumentDelivery(sessionId: number, cardCode: string, docEntry: number): Observable<{ success: boolean; data: any }> {
    return this.http.post<any>(
      `${this.base}/picking/session/${sessionId}/deliveries/${encodeURIComponent(cardCode)}/${docEntry}/retry`, {}
    );
  }

  // ─── Stations ─────────────────────────────────────────────
  getStations(): Observable<{ success: boolean; data: Station[] }> {
    return this.http.get<any>(`${this.base}/stations`);
  }

  getStation(id: number): Observable<{ success: boolean; data: Station }> {
    return this.http.get<any>(`${this.base}/stations/${id}`);
  }

  createStation(body: Partial<Station>): Observable<{ success: boolean; data: Station }> {
    return this.http.post<any>(`${this.base}/stations`, body);
  }

  addBin(stationId: number, body: any): Observable<any> {
    return this.http.post<any>(`${this.base}/stations/${stationId}/bins`, body);
  }
}
