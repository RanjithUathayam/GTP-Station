import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { PickingShellComponent } from './components/picking-shell/picking-shell.component';
import { DeliveryStatusComponent } from './components/delivery-status/delivery-status.component';
import { BoxLabelComponent } from './components/box-label/box-label.component';

const routes: Routes = [
  { path: '',                     component: PickingShellComponent   },
  { path: 'delivery-status',      component: DeliveryStatusComponent },
  { path: 'box-label/:boxId',     component: BoxLabelComponent       },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class GtpPickingRoutingModule {}
