import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import * as QRCode from 'qrcode';
import { ApiService } from '../../../../core/services/api.service';
import { BoxIdLabelData } from '../../../../core/models/picking.models';

@Component({
  selector: 'app-box-id-label',
  templateUrl: './box-id-label.component.html',
  styleUrls: ['./box-id-label.component.scss'],
})
export class BoxIdLabelComponent implements OnInit {
  @ViewChild('qrCanvas') qrCanvasRef?: ElementRef<HTMLCanvasElement>;

  label: BoxIdLabelData | null = null;
  loading = true;
  error = '';

  constructor(
    private route: ActivatedRoute,
    private api:   ApiService,
  ) {}

  ngOnInit(): void {
    const boxId = Number(this.route.snapshot.paramMap.get('boxId'));
    this.api.getBoxIdLabel(boxId).subscribe({
      next: (r) => {
        this.label   = r.data;
        this.loading = false;
        setTimeout(() => this.renderQr(), 0);
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || 'Failed to load box label';
      },
    });
  }

  private renderQr(): void {
    if (!this.label || !this.qrCanvasRef) return;
    QRCode.toCanvas(this.qrCanvasRef.nativeElement, this.label.boxNumber, { width: 70, margin: 0 })
      .then(() => setTimeout(() => window.print(), 150))
      .catch((err) => console.error('[BoxIdLabel] QR render failed', err));
  }

  printNow(): void {
    window.print();
  }

  formatDateTime(iso: string | null): string {
    if (!iso) return '-';
    const d = new Date(iso);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const h = d.getHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()} ${h12}:${mm} ${ampm}`;
  }
}
