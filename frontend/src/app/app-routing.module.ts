import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  { path: '', redirectTo: 'picking', pathMatch: 'full' },
  {
    path: 'picking',
    loadChildren: () => import('./modules/gtp-picking/gtp-picking.module').then(m => m.GtpPickingModule),
  },
  {
    path: 'adam',
    loadChildren: () => import('./modules/adam-dashboard/adam-dashboard.module').then(m => m.AdamDashboardModule),
  },
  {
    path: 'adam-config',
    loadChildren: () => import('./modules/adam-config/adam-config.module').then(m => m.AdamConfigModule),
  },
  {
    path: 'reports',
    loadChildren: () => import('./modules/reports/reports.module').then(m => m.ReportsModule),
  },
  { path: '**', redirectTo: 'picking' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
