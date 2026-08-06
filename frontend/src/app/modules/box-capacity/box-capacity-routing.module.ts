import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { BoxCapacityComponent } from './components/box-capacity.component';

const routes: Routes = [{ path: '', component: BoxCapacityComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class BoxCapacityRoutingModule {}
