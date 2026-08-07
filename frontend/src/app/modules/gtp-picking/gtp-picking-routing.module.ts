import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { PickingShellComponent } from './components/picking-shell/picking-shell.component';
import { DeliveryStatusComponent } from './components/delivery-status/delivery-status.component';
import { BoxIdLabelComponent } from './components/box-id-label/box-id-label.component';
import { BoxContentsLabelComponent } from './components/box-contents-label/box-contents-label.component';
import { BoxLookupComponent } from './components/box-lookup/box-lookup.component';

const routes: Routes = [
  { path: '',                                component: PickingShellComponent        },
  { path: 'delivery-status',                 component: DeliveryStatusComponent      },
  { path: 'box-id-label/:boxId',             component: BoxIdLabelComponent          },
  { path: 'box-contents-label/:boxNumber',   component: BoxContentsLabelComponent    },
  { path: 'box-lookup',                      component: BoxLookupComponent           },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class GtpPickingRoutingModule {}
