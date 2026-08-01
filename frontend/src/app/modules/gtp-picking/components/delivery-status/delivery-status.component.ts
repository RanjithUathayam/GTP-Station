import {
  Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../../../core/services/api.service';

interface PartyStatus {
  cardCode: string;
  cardName: string;
  totalQty: number;
  pickedQty: number;
  remainingQty: number;
  pickStatus: 'InProgress' | 'Completed';
  deliveryStatus: 'Pending' | 'Success' | 'Failed' | null;
  sapDocEntry: number | null;
  sapDocNum: number | null;
  deliveryError: string | null;
  deliveryUpdatedAt: string | null;
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

  constructor(
    private api:    ApiService,
    private router: Router,
    private cdr:    ChangeDetectorRef,
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
    this.cdr.markForCheck();
  }

  continuePicking(session: DeliverySession, event?: Event): void {
    event?.stopPropagation();
    this.router.navigate(['/picking'], {
      queryParams: { sessionId: session.sessionId },
    });
  }

  postDelivery(session: DeliverySession, party: PartyStatus, event: Event): void {
    event.stopPropagation();
    const key = `${session.sessionId}_${party.cardCode}`;
    if (this.retryingMap.get(key)) return;
    this.retryingMap.set(key, true);
    this.cdr.markForCheck();
    this.api.retryPartyDelivery(session.sessionId, party.cardCode).subscribe({
      next: () => { this.retryingMap.delete(key); this.load(); },
      error: () => { this.retryingMap.delete(key); this.cdr.markForCheck(); },
    });
  }

  isRetrying(sessionId: number, cardCode: string): boolean {
    return !!this.retryingMap.get(`${sessionId}_${cardCode}`);
  }

  deliveryIcon(status: string | null): string {
    if (status === 'Success')  return 'check_circle';
    if (status === 'Failed')   return 'cancel';
    if (status === 'Pending')  return 'hourglass_empty';
    return 'radio_button_unchecked';
  }

  deliveryLabel(status: string | null): string {
    if (status === 'Success')  return 'Posted';
    if (status === 'Failed')   return 'Failed';
    if (status === 'Pending')  return 'Pending';
    return 'Not Posted';
  }

  countByStatus(status: 'InProgress' | 'Completed'): number {
    return this.sessions.filter(s => s.sessionStatus === status).length;
  }

  sessionDeliveryState(session: DeliverySession): 'all-posted' | 'some-failed' | 'none' | 'partial' {
    const parties = session.parties;
    const posted  = parties.filter(p => p.deliveryStatus === 'Success').length;
    const failed  = parties.filter(p => p.deliveryStatus === 'Failed').length;
    if (posted === parties.length)  return 'all-posted';
    if (failed > 0)                 return 'some-failed';
    if (posted > 0)                 return 'partial';
    return 'none';
  }
}
