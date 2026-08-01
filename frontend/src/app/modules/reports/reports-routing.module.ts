import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { PickingReportComponent } from './components/picking-report.component';

const routes: Routes = [{ path: '', component: PickingReportComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class ReportsRoutingModule {}
