import {
  Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../../../core/services/api.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { DeliveryLogStatus, ItemGroupBoxSummary } from '../../../../core/models/picking.models';

interface DeliveryDocStatus {
  docEntry: number;
  shipToCode: string | null;
  salesOrderNo: string | null;
  deliveryStatus: DeliveryLogStatus | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  deliveryError: string | null;
  deliveryUpdatedAt: string | null;
}

interface PartyStatus {
  cardCode: string;
  cardName: string;
  totalQty: number;
  pickedQty: number;
  remainingQty: number;
  pickStatus: 'InProgress' | 'Completed';
  documents: DeliveryDocStatus[];
}

interface DeliverySession {
  sessionId: number;
  headerId: string;
  sessionStatus: 'InProgress' | 'Completed';
  startedAt: string;
  completedAt: string | null;
  totalQty: number;
  pickedQty: number;
  remainingQty: number;
  totalParties: number;
  completedParties: number;
  parties: PartyStatus[];
  expanded: boolean;
  boxGroupsByParty?: Record<string, ItemGroupBoxSummary[]>;
  boxesLoading?: boolean;
}

@Component({
  selector:        'app-delivery-status',
  templateUrl:     './delivery-status.component.html',
  styleUrls:       ['./delivery-status.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryStatusComponent implements OnInit {
  sessions: DeliverySession[] = [];
  filteredSessions: DeliverySession[] = [];
  loading = false;
  error: string | null = null;
  filterStatus: 'All' | 'InProgress' | 'Completed' = 'All';

  private retryingMap = new Map<string, boolean>();
  private releasingSessions = new Set<number>();

  constructor(
    private api:    ApiService,
    private router: Router,
    private cdr:    ChangeDetectorRef,
    private notify: NotificationService,
  ) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    this.error = null;
    this.api.getPicklistSessions().subscribe({
      next: res => {
        this.sessions = (res.data || []).map((s: any) => ({ ...s, expanded: false }));
        this.applyFilter();
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: err => {
        this.error = err?.error?.message || err.message || 'Failed to load sessions';
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  setFilter(status: 'All' | 'InProgress' | 'Completed'): void {
    this.filterStatus = status;
    this.applyFilter();
    this.cdr.markForCheck();
  }

  private applyFilter(): void {
    this.filteredSessions = this.filterStatus === 'All'
      ? [...this.sessions]
      : this.sessions.filter(s => s.sessionStatus === this.filterStatus);
  }

  toggle(session: DeliverySession): void {
    session.expanded = !session.expanded;
    if (session.expanded && !session.boxGroupsByParty && !session.boxesLoading) {
      this.loadBoxes(session);
    }
    this.cdr.markForCheck();
  }

  private loadBoxes(session: DeliverySession): void {
    session.boxesLoading = true;
    this.api.getSessionBoxes(session.sessionId).subscribe({
      next: (r) => {
        const map: Record<string, ItemGroupBoxSummary[]> = {};
        for (const g of r.data) {
          if (!map[g.cardCode]) map[g.cardCode] = [];
          map[g.cardCode].push(g);
        }
        session.boxGroupsByParty = map;
        session.boxesLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        session.boxesLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  boxGroupsFor(session: DeliverySession, cardCode: string): ItemGroupBoxSummary[] {
    return session.boxGroupsByParty?.[cardCode] || [];
  }

  continuePicking(session: DeliverySession, event?: Event): void {
    event?.stopPropagation();
    this.router.navigate(['/picking'], {
      queryParams: { sessionId: session.sessionId },
    });
  }

  postDelivery(session: DeliverySession, party: PartyStatus, doc: DeliveryDocStatus, event: Event): void {
    event.stopPropagation();
    const key = `${session.sessionId}_${party.cardCode}_${doc.docEntry}`;
    if (this.retryingMap.get(key)) return;
    this.retryingMap.set(key, true);
    this.cdr.markForCheck();
    this.api.retryDocumentDelivery(session.sessionId, party.cardCode, doc.docEntry).subscribe({
      next: () => { this.retryingMap.delete(key); this.load(); },
      error: (err) => {
        this.retryingMap.delete(key);
        this.notify.error(err.error?.message || err.error?.data?.error || 'Failed to post delivery');
        this.load();
      },
    });
  }

  isRetrying(sessionId: number, cardCode: string, docEntry: number): boolean {
    return !!this.retryingMap.get(`${sessionId}_${cardCode}_${docEntry}`);
  }

  // Picklist Recheck — opens the session on the picking board with the Recheck dialog.
  recheck(session: DeliverySession, event?: Event): void {
    event?.stopPropagation();
    this.router.navigate(['/picking'], {
      queryParams: { sessionId: session.sessionId, recheck: 1 },
    });
  }

  onHoldCount(session: DeliverySession): number {
    return this.allDocs(session).filter(d => d.deliveryStatus === 'OnHold').length;
  }

  isReleasing(session: DeliverySession): boolean {
    return this.releasingSessions.has(session.sessionId);
  }

  releaseAll(session: DeliverySession, event: Event): void {
    event.stopPropagation();
    if (this.isReleasing(session)) return;
    this.releasingSessions.add(session.sessionId);
    this.cdr.markForCheck();
    this.api.releaseSessionDeliveries(session.sessionId).subscribe({
      next: (r) => {
        this.releasingSessions.delete(session.sessionId);
        const { released, failed } = r.data;
        if (failed) this.notify.error(`${released} posted, ${failed} failed`);
        else        this.notify.success(`${released} ${released === 1 ? 'delivery' : 'deliveries'} posted to SAP`);
        this.load();
      },
      error: (err) => {
        this.releasingSessions.delete(session.sessionId);
        this.notify.error(err.error?.message || 'Failed to release deliveries');
        this.load();
      },
    });
  }

  postButtonLabel(doc: DeliveryDocStatus): string {
    return doc.deliveryStatus === 'OnHold' ? 'Release to SAP' : 'Post Delivery';
  }

  deliveryIcon(status: string | null): string {
    if (status === 'Success')   return 'check_circle';
    if (status === 'Failed')    return 'cancel';
    if (status === 'Pending' || status === 'Released') return 'hourglass_empty';
    if (status === 'OnHold')    return 'pause_circle';
    if (status === 'Cancelled') return 'restart_alt';
    return 'radio_button_unchecked';
  }

  deliveryLabel(status: string | null): string {
    if (status === 'Success')   return 'Posted';
    if (status === 'Failed')    return 'Failed';
    if (status === 'Pending' || status === 'Released') return 'Pending';
    if (status === 'OnHold')    return 'On Hold';
    if (status === 'Cancelled') return 'Re-picking';
    return 'Not Posted';
  }

  countByStatus(status: 'InProgress' | 'Completed'): number {
    return this.sessions.filter(s => s.sessionStatus === status).length;
  }

  private allDocs(session: DeliverySession): DeliveryDocStatus[] {
    return session.parties.flatMap(p => p.documents);
  }

  sessionDeliveryState(session: DeliverySession): 'all-posted' | 'some-failed' | 'on-hold' | 'none' | 'partial' {
    const docs   = this.allDocs(session);
    const posted = docs.filter(d => d.deliveryStatus === 'Success').length;
    const failed = docs.filter(d => d.deliveryStatus === 'Failed').length;
    if (docs.length > 0 && posted === docs.length) return 'all-posted';
    if (failed > 0)                                return 'some-failed';
    if (this.onHoldCount(session) > 0)             return 'on-hold';
    if (posted > 0)                                return 'partial';
    return 'none';
  }
}
