import { Component, Inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ApiService } from '../../../../core/services/api.service';
import {
  PartyOrder, PicklistItem, PicklistParty, RecheckHistoryEntry, RecheckResetResult,
} from '../../../../core/models/picking.models';

export interface RecheckDialogData {
  sessionId: number;
  party:     PicklistParty;
  order:     PartyOrder;
}

// What the operator is about to reset — the whole group (item = null) or one item.
interface PendingReset {
  item:  PicklistItem | null;
  label: string;
  qty:   number;
}

// Picklist Recheck — reset a Customer + Sales Order group (or one item in it) so it can be
// picked again from scratch. Closes with the RecheckResetResult on success.
@Component({
  selector: 'app-recheck-dialog',
  templateUrl: './recheck-dialog.component.html',
  styleUrls: ['./recheck-dialog.component.scss'],
})
export class RecheckDialogComponent implements OnInit {
  reason  = '';
  pending: PendingReset | null = null;
  busy    = false;
  error   = '';
  history: RecheckHistoryEntry[] = [];
  showHistory = false;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: RecheckDialogData,
    private dialogRef: MatDialogRef<RecheckDialogComponent, RecheckResetResult>,
    private api: ApiService,
  ) {}

  ngOnInit(): void {
    this.api.getRecheckHistory(this.data.sessionId).subscribe({
      next: (r) => {
        this.history = r.data.filter(
          h => h.cardCode === this.data.order.cardCode && h.docEntry === this.data.order.docEntry,
        );
      },
      error: () => { this.history = []; },
    });
  }

  // A posted SAP Delivery Note can't be undone from here — re-picking would post a second one.
  get locked(): boolean {
    return this.data.order.deliveryStatus === 'Success';
  }

  get inFlight(): boolean {
    return this.data.order.deliveryStatus === 'Pending' || this.data.order.deliveryStatus === 'Released';
  }

  get groupPickedQty(): number {
    return this.data.order.items.reduce((s, i) => s + i.pickedQty, 0);
  }

  get canReset(): boolean {
    return !this.locked && !this.inFlight && !this.busy;
  }

  deliveryLabel(): string {
    switch (this.data.order.deliveryStatus) {
      case 'OnHold':    return 'On Hold — not yet sent to SAP';
      case 'Success':   return `Posted to SAP${this.data.order.sapDocNum ? ' — Delivery #' + this.data.order.sapDocNum : ''}`;
      case 'Failed':    return 'SAP posting failed';
      case 'Pending':
      case 'Released':  return 'Posting to SAP…';
      case 'Cancelled': return 'Reset for re-pick';
      default:          return 'Not sent to SAP';
    }
  }

  itemDisplayLabel(item: PicklistItem): string {
    const parts = [item.itemName];
    if (item.color) parts.push(item.color);
    if (item.size) parts.push(item.size);
    if (item.itemGroupName?.toUpperCase() === 'SHIRT' && item.sleeve) parts.push(item.sleeve);
    return parts.join(' - ');
  }

  askResetItem(item: PicklistItem): void {
    if (!this.canReset || item.pickedQty <= 0) return;
    this.error   = '';
    this.pending = { item, label: this.itemDisplayLabel(item), qty: item.pickedQty };
  }

  askResetGroup(): void {
    if (!this.canReset || this.groupPickedQty <= 0) return;
    this.error   = '';
    this.pending = {
      item:  null,
      label: `whole order SO ${this.data.order.salesOrderNo || this.data.order.docEntry}`,
      qty:   this.groupPickedQty,
    };
  }

  cancelPending(): void {
    this.pending = null;
  }

  confirmReset(): void {
    if (!this.pending || this.busy) return;
    this.busy  = true;
    this.error = '';
    this.api.resetForRepick(this.data.sessionId, {
      cardCode: this.data.order.cardCode,
      docEntry: this.data.order.docEntry,
      itemCode: this.pending.item?.itemCode ?? null,
      reason:   this.reason.trim() || null,
    }).subscribe({
      next: (r) => {
        this.busy = false;
        this.dialogRef.close(r.data);
      },
      error: (err) => {
        this.busy    = false;
        this.pending = null;
        this.error   = err.error?.message || 'Reset failed';
      },
    });
  }

  historyLabel(h: RecheckHistoryEntry): string {
    if (!h.itemCode) return 'Whole order';
    const item = this.data.order.items.find(i => i.itemCode === h.itemCode);
    return item ? this.itemDisplayLabel(item) : h.itemCode;
  }
}
