import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatRippleModule } from '@angular/material/core';

import { GtpPickingRoutingModule } from './gtp-picking-routing.module';
import { PickingShellComponent } from './components/picking-shell/picking-shell.component';
import { DeliveryStatusComponent } from './components/delivery-status/delivery-status.component';

@NgModule({
  declarations: [PickingShellComponent, DeliveryStatusComponent],
  imports: [
    CommonModule,
    FormsModule,
    GtpPickingRoutingModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatRippleModule,
  ],
})
export class GtpPickingModule {}
