import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AdamConfigComponent } from './components/adam-config.component';

const routes: Routes = [{ path: '', component: AdamConfigComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class AdamConfigRoutingModule {}
