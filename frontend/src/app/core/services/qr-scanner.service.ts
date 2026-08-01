import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

export interface QrPayload {
  orderNumber: string;
  itemCode:    string;
  qty:         number;
  raw:         string;
}

@Injectable({ providedIn: 'root' })
export class QrScannerService implements OnDestroy {

  private readonly SCAN_TIMEOUT_MS = 100; // chars faster than this → scanner (not human)
  private readonly MIN_LENGTH      = 5;

  private buffer      = '';
  private lastKeyTime = 0;
  private active      = false;

  private subject = new Subject<QrPayload>();
  scan$ = this.subject.asObservable();

  private boundListener = (e: KeyboardEvent) => this.onKey(e);

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener('keydown', this.boundListener);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('keydown', this.boundListener);
    this.buffer = '';
  }

  isActive(): boolean { return this.active; }

  private onKey(e: KeyboardEvent): void {
    // Don't capture while operator types in a text field
    const tag = (document.activeElement as HTMLElement)?.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const now = Date.now();
    if (now - this.lastKeyTime > this.SCAN_TIMEOUT_MS) {
      this.buffer = ''; // gap too long — not a scanner burst, reset
    }
    this.lastKeyTime = now;

    if (e.key === 'Enter') {
      if (this.buffer.length >= this.MIN_LENGTH) {
        const payload = this.parse(this.buffer.trim());
        if (payload) {
          this.subject.next(payload);
          e.preventDefault();
        }
      }
      this.buffer = '';
    } else if (e.key.length === 1) {
      this.buffer += e.key;
    }
  }

  private parse(raw: string): QrPayload | null {
    // Primary format: GTP|ORDER_NUMBER|ITEM_CODE|QTY
    // Example:        GTP|ORD-2024-001|ITM-001|2
    const parts = raw.split('|');
    if (parts.length >= 3 && parts[0].toUpperCase() === 'GTP') {
      const qty = parts[3] ? parseInt(parts[3], 10) : 1;
      return {
        orderNumber: parts[1],
        itemCode:    parts[2],
        qty:         isNaN(qty) || qty < 1 ? 1 : qty,
        raw,
      };
    }

    // Compact JSON format: {"o":"ORD-001","i":"ITM-001","q":2}
    try {
      const obj = JSON.parse(raw);
      if (obj.o && obj.i) {
        return { orderNumber: String(obj.o), itemCode: String(obj.i), qty: Number(obj.q) || 1, raw };
      }
    } catch (_) {}

    return null; // unrecognised format → ignore
  }

  ngOnDestroy(): void { this.stop(); }
}
