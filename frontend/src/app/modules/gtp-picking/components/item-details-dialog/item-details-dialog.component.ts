import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { PartyOrder, PicklistItem, PicklistParty } from '../../../../core/models/picking.models';

export interface ItemDetailsDialogData {
  party: PicklistParty;
  order: PartyOrder;
  item:  PicklistItem;
}

@Component({
  selector: 'app-item-details-dialog',
  templateUrl: './item-details-dialog.component.html',
  styleUrls: ['./item-details-dialog.component.scss'],
})
export class ItemDetailsDialogComponent {
  constructor(@Inject(MAT_DIALOG_DATA) public data: ItemDetailsDialogData) {}

  get remainingQty(): number {
    return Math.max(0, this.data.item.requiredQty - this.data.item.pickedQty);
  }
}
