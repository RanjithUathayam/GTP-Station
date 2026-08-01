import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable, Subject, timer } from 'rxjs';
import { share, switchMap, takeUntil } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { WsMessage } from '../models';

@Injectable({ providedIn: 'root' })
export class WebsocketService implements OnDestroy {
  private ws!: WebSocket;
  private messages$ = new Subject<WsMessage>();
  private destroy$  = new Subject<void>();
  private reconnectDelay = 3000;

  readonly messages: Observable<WsMessage> = this.messages$.asObservable().pipe(share());

  constructor(private zone: NgZone) {
    this.connect();
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(environment.wsUrl);

      this.ws.onmessage = (event) => {
        this.zone.run(() => {
          try {
            const msg = JSON.parse(event.data) as WsMessage;
            this.messages$.next(msg);
          } catch {}
        });
      };

      this.ws.onclose = () => {
        console.log('WS closed — reconnecting in', this.reconnectDelay, 'ms');
        timer(this.reconnectDelay)
          .pipe(takeUntil(this.destroy$))
          .subscribe(() => this.connect());
      };

      this.ws.onerror = () => this.ws.close();

    } catch (err) {
      console.warn('WS connect error, retrying...', err);
      timer(this.reconnectDelay)
        .pipe(takeUntil(this.destroy$))
        .subscribe(() => this.connect());
    }
  }

  on(type: string): Observable<WsMessage> {
    return new Observable((obs) => {
      const sub = this.messages.subscribe((msg) => {
        if (msg.type === type) obs.next(msg);
      });
      return () => sub.unsubscribe();
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.ws?.close();
  }
}
