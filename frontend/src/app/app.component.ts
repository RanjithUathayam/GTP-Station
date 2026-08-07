import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { Subject } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { WebsocketService } from './core/services/websocket.service';
import { NotificationService } from './core/services/notification.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit, OnDestroy {
  sidenavOpen = true;
  currentPath = '';
  private destroy$ = new Subject<void>();

  navItems: NavItem[] = [
    { path: '/picking',                label: 'GTP Picking',     icon: 'inventory'                },
    { path: '/picking/delivery-status', label: 'Delivery Status', icon: 'list_alt'                 },
    { path: '/picking/box-lookup',      label: 'Box Lookup',      icon: 'qr_code_scanner'          },
    { path: '/adam',                   label: 'ADAM-6052',       icon: 'settings_input_component' },
    { path: '/adam-config',            label: 'ADAM Config',     icon: 'tune'                      },
    { path: '/box-capacity',           label: 'Box Capacity',    icon: 'inbox'                     },
    { path: '/reports',                label: 'Picking Report',  icon: 'assessment'                },
  ];

  constructor(
    private router: Router,
    private ws: WebsocketService,
    private notify: NotificationService,
  ) {}

  ngOnInit(): void {
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      takeUntil(this.destroy$),
    ).subscribe((e: any) => {
      this.currentPath = e.urlAfterRedirects;
    });

    // Show toast on key WS events
    this.ws.on('ORDER_COMPLETED').pipe(takeUntil(this.destroy$)).subscribe((msg: any) => {
      this.notify.success(`✅ Order ${msg.data?.orderNumber} completed`);
    });

    this.ws.on('BIN_ACTIVATED').pipe(takeUntil(this.destroy$)).subscribe((msg: any) => {
      this.notify.info(`💡 Bin ${msg.data?.BinCode} activated — ${msg.data?.orderNumber}`);
    });
  }

  isActive(path: string): boolean {
    const current = this.currentPath.split('?')[0];
    return current === path;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
