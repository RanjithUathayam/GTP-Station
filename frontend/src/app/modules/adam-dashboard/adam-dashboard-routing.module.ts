import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdamDashboardComponent } from './components/adam-dashboard.component';

const routes: Routes = [{ path: '', component: AdamDashboardComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class AdamDashboardRoutingModule {}
