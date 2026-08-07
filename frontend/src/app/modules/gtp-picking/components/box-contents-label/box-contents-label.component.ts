import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import * as QRCode from 'qrcode';
import { ApiService } from '../../../../core/services/api.service';
import { BoxContentsLabelData } from '../../../../core/models/picking.models';

@Component({
  selector: 'app-box-contents-label',
  templateUrl: './box-contents-label.component.html',
  styleUrls: ['./box-contents-label.component.scss'],
})
export class BoxContentsLabelComponent implements OnInit {
  @ViewChild('qrCanvas') qrCanvasRef?: ElementRef<HTMLCanvasElement>;

  label: BoxContentsLabelData | null = null;
  loading = true;
  error = '';

  constructor(
    private route: ActivatedRoute,
    private api:   ApiService,
  ) {}

  ngOnInit(): void {
    const boxNumber = this.route.snapshot.paramMap.get('boxNumber') || '';
    this.api.getBoxContentsByNumber(boxNumber).subscribe({
      next: (r) => {
        this.label   = r.data;
        this.loading = false;
        setTimeout(() => this.renderQr(), 0);
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || `Box "${boxNumber}" not found`;
      },
    });
  }

  private renderQr(): void {
    if (!this.label || !this.qrCanvasRef) return;
    QRCode.toCanvas(this.qrCanvasRef.nativeElement, this.label.boxNumber, { width: 60, margin: 0 })
      .then(() => setTimeout(() => window.print(), 150))
      .catch((err) => console.error('[BoxContentsLabel] QR render failed', err));
  }

  cellQty(product: string, size: string): number {
    return this.label?.matrix[product]?.[size] || 0;
  }

  printNow(): void {
    window.print();
  }
}
