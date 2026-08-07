import {
  Component, OnInit, OnDestroy, ViewChild, ViewChildren, QueryList,
  ElementRef, ChangeDetectorRef, HostListener,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { ApiService } from '../../../../core/services/api.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { WebsocketService } from '../../../../core/services/websocket.service';
import { AdamConfigService, AdamDeviceRuntimeStatus } from '../../../../core/services/adam-config.service';
import {
  PicklistPreview, PicklistSession, PicklistParty, PicklistItem, ScanFeedback,
  ItemGroupBoxSummary, PartyOrder,
} from '../../../../core/models/picking.models';

export type PickView = 'scan-picklist' | 'picking-board' | 'completed';

@Component({
  selector: 'app-picking-shell',
  templateUrl: './picking-shell.component.html',
  styleUrls: ['./picking-shell.component.scss'],
})
export class PickingShellComponent implements OnInit, OnDestroy {
  @ViewChild('picklistInputEl') picklistInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('itemScanInput')   itemScanInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('topCardEl')       topCardEl?: ElementRef<HTMLElement>;
  @ViewChildren('binEl')        binEls?: QueryList<ElementRef<HTMLElement>>;

  svgPath  = '';
  svgW     = 0;
  svgH     = 0;
  scanFlash = false;

  @HostListener('window:resize')
  onResize(): void { this.updateSvgPath(); }

  view: PickView = 'scan-picklist';

  // ── Step 1 ─────────────────────────────────────────────────
  picklistInput  = '';
  picklistLoading = false;
  picklistError  = '';
  preview: PicklistPreview | null = null;

  // Which ADAM device (GTP Station) this kiosk picks against — persisted per
  // browser so it's set once, not re-chosen every picklist. Selecting the wrong
  // one here is exactly what silently activated the wrong Output Series before.
  private static readonly STATION_STORAGE_KEY = 'gtp-picking-station';
  stations: string[] = [];
  selectedStation: string | null = null;
  deviceStatus: AdamDeviceRuntimeStatus | null = null;
  validatingStation = false;

  // ── Session ────────────────────────────────────────────────
  session: PicklistSession | null = null;

  // ── Step 3 ─────────────────────────────────────────────────
  currentParty: PicklistParty | null = null;
  currentItem:  PicklistItem  | null = null;

  scanInput   = '';
  scanLoading = false;
  scanFeedback: ScanFeedback = { state: 'ready', message: '' };

  // ── Box progress (for the current item's item group) ───────
  boxCompleting = false;

  // A hardware barcode scanner is a keyboard-wedge device — the browser can't tell its
  // keystrokes apart from a human's except by speed. Rather than gate every keystroke
  // (which risks dropping characters if a scanner is briefly slower than expected), we
  // only judge the whole burst: elapsed time from the first character to Enter should be
  // far too short for a human to have typed it, given the barcode's length.
  private scanBurstStart = 0;
  private readonly SCAN_MS_PER_CHAR = 150;
  private readonly SCAN_MIN_WINDOW_MS = 800;

  private scanTimer?: ReturnType<typeof setTimeout>;
  private destroy$ = new Subject<void>();

  constructor(
    private api:        ApiService,
    private notify:     NotificationService,
    private ws:         WebsocketService,
    private cdr:        ChangeDetectorRef,
    private route:      ActivatedRoute,
    private adamConfig: AdamConfigService,
  ) {}

  ngOnInit(): void {
    this.loadStations();

    // Auto-load headerId from query param (e.g. navigated from status page)
    const qHeaderId  = this.route.snapshot.queryParamMap.get('headerId');
    const qSessionId = this.route.snapshot.queryParamMap.get('sessionId');
    if (qSessionId) {
      this.picklistLoading = true;
      this.resumeSession(Number(qSessionId));
    } else if (qHeaderId) {
      this.picklistInput = qHeaderId;
      this.loadPicklist();
    }

    this.ws.on('ITEM_PICKED').pipe(takeUntil(this.destroy$)).subscribe(() => {
      if (this.session) this.refreshSession();
    });
    this.ws.on('PICKLIST_COMPLETED').pipe(takeUntil(this.destroy$)).subscribe((msg: any) => {
      if (this.session?.sessionId === msg.data?.sessionId) {
        this.view = 'completed';
        this.cdr.markForCheck();
      }
    });
  }

  // ── Station selection ─────────────────────────────────────────
  // Loads the ADAM devices configured as Active in ADAM Device Configuration —
  // only these have a real, connected output series to activate.
  loadStations(): void {
    this.adamConfig.list().subscribe({
      next: (r) => {
        this.stations = r.data.filter(d => d.IsActive).map(d => d.DeviceCode);
        const saved = localStorage.getItem(PickingShellComponent.STATION_STORAGE_KEY);
        this.selectedStation = (saved && this.stations.includes(saved))
          ? saved
          : (this.stations[0] ?? null);
        this.cdr.markForCheck();
        if (this.selectedStation) this.checkStationStatus(this.selectedStation);
      },
      error: (err) => console.error('[PickingShell] Failed to load stations', err),
    });
  }

  onStationChange(code: string): void {
    this.selectedStation = code;
    localStorage.setItem(PickingShellComponent.STATION_STORAGE_KEY, code);
    this.checkStationStatus(code);
  }

  /** Pre-flight check — loads the device's IP/Output Series/MAC/Status and verifies
   *  it's Active with a matching MAC *before* the operator is allowed to scan anything. */
  checkStationStatus(code: string): void {
    this.validatingStation = true;
    this.deviceStatus = null;
    this.adamConfig.getStatus(code).subscribe({
      next: (r) => {
        this.deviceStatus = r.data;
        this.validatingStation = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.deviceStatus = {
          deviceCode: code, exists: false, usable: false,
          reason: err.error?.message || 'Failed to check device status',
        };
        this.validatingStation = false;
        this.cdr.markForCheck();
      },
    });
  }

  get stationReady(): boolean {
    return !!this.deviceStatus?.usable;
  }

  // ════════════════════════════════════════════════════════════
  // STEP 1 — Picklist scan → auto-start → picking board
  // ════════════════════════════════════════════════════════════
  loadPicklist(): void {
    const raw = this.picklistInput.trim();
    if (!raw || this.picklistLoading) return;

    if (!this.selectedStation) {
      this.picklistError = 'Select a station before loading a picklist — configure one in ADAM Device Configuration if none appear.';
      return;
    }
    if (!this.stationReady) {
      this.picklistError = this.deviceStatus?.reason || 'Selected station is not ready — check ADAM Device Configuration';
      return;
    }

    this.picklistError   = '';
    this.picklistLoading = true;

    this.api.loadPicklist(raw).subscribe({
      next: (r) => {
        this.preview = r.data;
        if (r.data.existingSessionId) {
          this.resumeSession(r.data.existingSessionId);
        } else {
          this.startNewSession();
        }
      },
      error: (err) => {
        this.picklistLoading = false;
        this.picklistError   = err.error?.message || 'Picklist not found';
      },
    });
  }

  startNewSession(): void {
    if (!this.preview) return;
    this.api.startPicklistSession(this.preview.headerId, undefined, this.selectedStation ?? undefined).subscribe({
      next: (r) => {
        this.picklistLoading = false;
        this.session         = r.data;
        this.printAllFirstBoxLabels(this.session);
        this.goToBoard();
      },
      error: (err) => {
        this.picklistLoading = false;
        this.picklistError   = err.error?.message || 'Failed to start session';
      },
    });
  }

  resumeSession(sessionId: number): void {
    this.api.getPicklistSession(sessionId).subscribe({
      next: (r) => {
        this.picklistLoading = false;
        this.session         = r.data;
        if (r.data.status === 'Completed') {
          this.view = 'completed';
        } else {
          this.goToBoard();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.picklistLoading = false;
        this.picklistError   = err.error?.message || 'Failed to resume session';
      },
    });
  }

  private goToBoard(): void {
    const first = this.session?.parties.find(p => p.status !== 'completed') ?? null;
    this.currentParty = first;
    this.syncCurrentItem();
    this.view = 'picking-board';
    this.cdr.markForCheck();
    setTimeout(() => {
      this.itemScanInputRef?.nativeElement.focus();
      this.updateSvgPath();
    }, 200);
  }

  refreshSession(preferItemCode?: string): void {
    if (!this.session) return;
    this.api.getPicklistSession(this.session.sessionId).subscribe((r) => {
      this.session = r.data;
      if (this.currentParty) {
        this.currentParty = this.session?.parties.find(
          p => p.cardCode === this.currentParty!.cardCode,
        ) || null;
        this.syncCurrentItem(preferItemCode);
      }
      this.cdr.markForCheck();
      setTimeout(() => this.updateSvgPath(), 50);
    });
  }

  startPickingParty(party: PicklistParty): void {
    this.currentParty = party;
    this.syncCurrentItem();
    this.view = 'picking-board';
    setTimeout(() => {
      this.itemScanInputRef?.nativeElement.focus();
      this.updateSvgPath();
    }, 200);
  }

  updateSvgPath(): void {
    if (!this.topCardEl || !this.binEls || !this.currentParty || !this.session) return;
    const container = this.topCardEl.nativeElement.closest('.ptl-board-main') as HTMLElement;
    if (!container) return;

    const cR = container.getBoundingClientRect();
    const tR = this.topCardEl.nativeElement.getBoundingClientRect();

    const parties = this.session.parties;
    const idx     = parties.findIndex(p => p.cardCode === this.currentParty!.cardCode);
    const binArr  = this.binEls.toArray();
    if (idx < 0 || !binArr[idx]) return;

    const bR = binArr[idx].nativeElement.getBoundingClientRect();
    const x1 = tR.left + tR.width  / 2 - cR.left;
    const y1 = tR.bottom - cR.top;
    const x2 = bR.left  + bR.width  / 2 - cR.left;
    const y2 = bR.top   - cR.top;
    const cy = y1 + (y2 - y1) * 0.55;

    this.svgW    = cR.width;
    this.svgH    = cR.height;
    this.svgPath = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
    this.cdr.markForCheck();
  }

  nextParty(): void {
    if (!this.session) return;
    const pending = this.session.parties.find(p => p.status !== 'completed');
    if (pending) {
      this.currentParty = pending;
      this.syncCurrentItem();
      this.cdr.markForCheck();
      setTimeout(() => {
        this.itemScanInputRef?.nativeElement.focus();
        this.updateSvgPath();
      }, 150);
    } else {
      this.view = 'completed';
      this.cdr.markForCheck();
    }
  }

  syncCurrentItem(preferItemCode?: string): void {
    if (!this.currentParty) return;
    // Prefer the specified item (e.g. the one just scanned), else first pending
    if (preferItemCode) {
      const preferred = this.currentParty.items.find(
        i => i.itemCode === preferItemCode && i.status !== 'Completed',
      );
      if (preferred) { this.currentItem = preferred; return; }
    }
    this.currentItem = this.currentParty.items.find(
      i => i.status !== 'Completed',
    ) || null;
  }

  // ════════════════════════════════════════════════════════════
  // STEP 3 — Picking board: scan processing
  // ════════════════════════════════════════════════════════════

  // Marks when the current burst started; never blocks/clears a keystroke, so no
  // character is ever dropped mid-scan. The actual scanner-vs-human check happens
  // once, at submit time, in processItemScan().
  onScanKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') return; // (keydown.enter) handles submission separately
    if (this.scanInput.length === 0) this.scanBurstStart = Date.now();
  }

  // Only a scanner should ever populate this field — block manual paste too.
  onScanPaste(event: ClipboardEvent): void {
    event.preventDefault();
  }

  // Keep the scan input permanently focused so the scanner can fire at any time.
  onScanInputBlur(): void {
    if (this.view === 'picking-board') {
      setTimeout(() => this.itemScanInputRef?.nativeElement.focus(), 0);
    }
  }

  // ── Box progress for the current item's order + item group ──
  // Box plans are per (party, Sales Order, item group), so the lookup must
  // match both the current order (docEntry) and the item group — the same
  // item group can have an independent box plan on a different order.
  get currentBoxGroup(): ItemGroupBoxSummary | null {
    if (!this.currentParty || !this.currentItem) return null;
    const order = this.currentParty.orders?.find(o => o.docEntry === this.currentItem!.docEntry);
    return order?.boxGroups?.find(
      g => g.itemGroupName === this.currentItem!.itemGroupName,
    ) || null;
  }

  boxProgress(group: ItemGroupBoxSummary): number {
    if (!group.currentBox || !group.currentBox.targetQty) return 0;
    return Math.min(100, Math.round((group.currentBox.pickedQty / group.currentBox.targetQty) * 100));
  }

  completeCurrentBox(): void {
    const box = this.currentBoxGroup?.currentBox;
    if (!box || this.boxCompleting) return;
    this.boxCompleting = true;
    this.api.completeBox(box.boxId).subscribe({
      next: (r) => {
        this.boxCompleting = false;
        // Print the NEXT box's ID label (before it's filled) — not the one
        // that just completed; nothing prints if that was the group's last box.
        if (r.data.nextActivatedBox) this.openBoxIdLabel(r.data.nextActivatedBox.boxId);
        this.refreshSession();
      },
      error: (err) => {
        this.boxCompleting = false;
        this.notify.error(err.error?.message || 'Failed to complete box');
      },
    });
  }

  openBoxIdLabel(boxId: number): void {
    window.open(`/picking/box-id-label/${boxId}`, '_blank');
  }

  // Batch-prints every box group's first ID label at once, right after a NEW
  // session is created (not on resume — those labels already printed once).
  private printAllFirstBoxLabels(session: PicklistSession | null): void {
    if (!session) return;
    for (const party of session.parties) {
      for (const order of party.orders || []) {
        for (const group of order.boxGroups || []) {
          if (group.currentBox && group.currentBox.boxNumber === 1) {
            this.openBoxIdLabel(group.currentBox.boxId);
          }
        }
      }
    }
  }

  processItemScan(): void {
    const raw = this.scanInput.trim();
    if (!raw || this.scanLoading || !this.session) return;

    // Reject the burst if it took far longer than a scanner ever would for this many
    // characters — i.e. it was typed by hand. Generous budget so a slightly slow
    // scanner is never mistaken for typing.
    const elapsed     = Date.now() - this.scanBurstStart;
    const allowedTime = Math.max(this.SCAN_MIN_WINDOW_MS, raw.length * this.SCAN_MS_PER_CHAR);
    if (elapsed > allowedTime) {
      this.scanInput = '';
      this.setScanFeedback('invalid', 'Manual entry not allowed — use the scanner');
      setTimeout(() => this.itemScanInputRef?.nativeElement.focus(), 50);
      return;
    }

    // Extract itemCode from barcode (format: ITEMCODE|ST|ID|GROUP|NUM|QTY)
    const itemCode = raw.split('|')[0];

    // Find the party that owns this item with pending quantity
    const targetParty = this.findPartyForItem(itemCode);
    if (!targetParty) {
      this.scanInput = '';
      this.setScanFeedback('invalid', `Item "${itemCode}" not found in any pending party`);
      setTimeout(() => this.itemScanInputRef?.nativeElement.focus(), 50);
      return;
    }

    // Switch highlight to the correct party before API call
    if (targetParty.cardCode !== this.currentParty?.cardCode) {
      this.currentParty = targetParty;
    }
    this.syncCurrentItem(itemCode);
    this.cdr.markForCheck();
    setTimeout(() => this.updateSvgPath(), 50);

    this.scanLoading = true;
    this.setScanFeedback('processing', `Scanning…`);

    this.api.processPickScan(this.session.sessionId, raw, targetParty.cardCode).subscribe({
      next: (r) => {
        this.scanLoading = false;
        this.scanInput   = '';
        const data = r.data;

        // A box just filled up — print the NEXT box's ID label before the
        // picker starts filling it (nothing prints if that was the last box).
        if (data.nextActivatedBox) this.openBoxIdLabel(data.nextActivatedBox.boxId);

        if (data.picklistCompleted) {
          this.setScanFeedback('done', `Picklist ${this.session!.headerId} completed!`);
          this.refreshSession();
          setTimeout(() => { this.view = 'completed'; this.cdr.markForCheck(); }, 1800);
          return;
        }

        if (data.partyCompleted) {
          this.setScanFeedback('done', `${targetParty.cardName} — Party completed!`);
          this.refreshSession();
          setTimeout(() => this.nextParty(), 1800);
          return;
        }

        if (data.itemCompleted) {
          this.setScanFeedback('success', `${data.itemCode} — Item complete!`);
        } else {
          this.setScanFeedback('success',
            `${data.itemCode}  ✓ ${data.newPickedQty}/${data.requiredQty} picked`);
        }

        // Flash the active bin
        this.scanFlash = true;
        this.cdr.markForCheck();
        setTimeout(() => { this.scanFlash = false; this.cdr.markForCheck(); }, 700);

        // If item is complete, next item in party; otherwise stay on same item
        this.refreshSession(data.itemCompleted ? undefined : itemCode);
        setTimeout(() => this.itemScanInputRef?.nativeElement.focus(), 50);
      },
      error: (err) => {
        this.scanLoading = false;
        this.scanInput   = '';
        const code = err.error?.code;
        if (code === 'DUPLICATE_SCAN') {
          this.setScanFeedback('duplicate', `Already scanned — ${err.error?.message}`);
        } else if (code === 'ITEM_ALREADY_DONE') {
          this.setScanFeedback('invalid', `Item "${itemCode}" already fully picked`);
        } else {
          this.setScanFeedback('error', err.error?.message || 'Scan failed');
        }
        setTimeout(() => this.itemScanInputRef?.nativeElement.focus(), 50);
      },
    });
  }

  // Find the first party that has this itemCode with remaining quantity
  private findPartyForItem(itemCode: string): PicklistParty | null {
    if (!this.session) return null;
    for (const party of this.session.parties) {
      const match = party.items.find(
        i => i.itemCode === itemCode && i.status !== 'Completed'
           && i.pickedQty < i.requiredQty,
      );
      if (match) return party;
    }
    return null;
  }

  setScanFeedback(state: ScanFeedback['state'], message: string): void {
    clearTimeout(this.scanTimer);
    this.scanFeedback = { state, message };
    this.cdr.markForCheck();
    if (state !== 'processing' && state !== 'ready' && state !== 'done') {
      this.scanTimer = setTimeout(() => {
        this.scanFeedback = { state: 'ready', message: '' };
        this.cdr.markForCheck();
      }, state === 'success' ? 2500 : 3500);
    }
  }

  orderPending(order: PartyOrder): number {
    return Math.max(0, order.totalRequiredQty - order.totalPickedQty);
  }

  orderStatusLabel(order: PartyOrder): string {
    if (order.status === 'completed') return 'Completed';
    if (order.status === 'active') return 'In Progress';
    return 'Pending';
  }

  // ── Helpers ────────────────────────────────────────────────
  scanFeedbackIcon(): string {
    switch (this.scanFeedback.state) {
      case 'processing': return 'hourglass_empty';
      case 'success':    return 'check_circle';
      case 'done':       return 'done_all';
      case 'invalid':    return 'search_off';
      case 'duplicate':  return 'content_copy';
      case 'error':      return 'error_outline';
      default:           return 'qr_code_scanner';
    }
  }

  itemDisplayLabel(item: PicklistItem): string {
    const parts = [item.itemName];
    if (item.color) parts.push(item.color);
    if (item.size) parts.push(item.size);
    if (item.itemGroupName?.toUpperCase() === 'SHIRT' && item.sleeve) parts.push(item.sleeve);
    return parts.join(' - ');
  }

  itemProgress(item: PicklistItem): number {
    if (!item.requiredQty) return 0;
    return Math.min(100, Math.round((item.pickedQty / item.requiredQty) * 100));
  }

  partyProgress(party: PicklistParty): number {
    if (!party.totalRequiredQty) return 0;
    return Math.min(100, Math.round((party.totalPickedQty / party.totalRequiredQty) * 100));
  }

  overallProgress(): number {
    if (!this.session) return 0;
    const total = this.session.parties.reduce((s, p) => s + p.totalRequiredQty, 0);
    const picked = this.session.parties.reduce((s, p) => s + p.totalPickedQty, 0);
    return total ? Math.round((picked / total) * 100) : 0;
  }

  isItemDone(item: PicklistItem): boolean {
    return item.status === 'Completed';
  }

  isItemActive(item: PicklistItem): boolean {
    return item.itemCode === this.currentItem?.itemCode;
  }

  currentItemIndex(): number {
    if (!this.currentParty || !this.currentItem) return 0;
    return (this.currentParty.items.findIndex(i => i.itemCode === this.currentItem!.itemCode) + 1);
  }

  doneItemCount(party: PicklistParty): number {
    return party.items.filter(i => this.isItemDone(i)).length;
  }

  // Sub-splits a party's items by DocEntry (order) for the full-picklist strip —
  // items already carry their DocEntry (one row per order line from the WMS join).
  groupItemsByDocEntry(party: PicklistParty): { docEntry: number; items: PicklistItem[] }[] {
    const map = new Map<number, PicklistItem[]>();
    for (const item of party.items) {
      if (!map.has(item.docEntry)) map.set(item.docEntry, []);
      map.get(item.docEntry)!.push(item);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([docEntry, items]) => ({ docEntry, items }));
  }

  totalItemsCount(): number {
    return this.session?.parties.reduce((s, p) => s + p.items.length, 0) ?? 0;
  }

  totalQtyPicked(): number {
    return Math.round(
      this.session?.parties.reduce((s, p) => s + p.totalPickedQty, 0) ?? 0,
    );
  }

  backToPicklist(): void {
    this.preview       = null;
    this.session       = null;
    this.currentParty  = null;
    this.currentItem   = null;
    this.picklistInput = '';
    this.picklistError = '';
    this.view          = 'scan-picklist';
    setTimeout(() => this.picklistInputRef?.nativeElement.focus(), 150);
  }

  backToParties(): void {
    this.backToPicklist();
  }

  startOver(): void {
    this.backToPicklist();
  }

  ngOnDestroy(): void {
    clearTimeout(this.scanTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }
}
