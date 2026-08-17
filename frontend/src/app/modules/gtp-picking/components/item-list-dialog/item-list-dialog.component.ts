import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { ItemFilter, PartyOrder, PicklistItem, PicklistParty } from '../../../../core/models/picking.models';
import { ItemDetailsDialogComponent } from '../item-details-dialog/item-details-dialog.component';

export interface ItemListDialogData {
  party: PicklistParty;
  order: PartyOrder;
  currentItem: PicklistItem | null;
}

@Component({
  selector: 'app-item-list-dialog',
  templateUrl: './item-list-dialog.component.html',
  styleUrls: ['./item-list-dialog.component.scss'],
})
export class ItemListDialogComponent {
  activeFilter: ItemFilter = 'all';

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: ItemListDialogData,
    private dialogRef: MatDialogRef<ItemListDialogComponent>,
    private dialog: MatDialog,
  ) {}

  itemsForFilter(filter: ItemFilter): PicklistItem[] {
    const items = this.data.order.items;
    if (filter === 'pending')   return items.filter(i => i.requiredQty > i.pickedQty || i.status !== 'Completed');
    if (filter === 'completed') return items.filter(i => i.pickedQty >= i.requiredQty || i.status === 'Completed');
    return items;
  }

  selectFilter(filter: ItemFilter): void {
    this.activeFilter = filter;
  }

  isItemDone(item: PicklistItem): boolean {
    return item.status === 'Completed';
  }

  isItemActive(item: PicklistItem): boolean {
    return item.itemCode === this.data.currentItem?.itemCode;
  }

  itemDisplayLabel(item: PicklistItem): string {
    const parts = [item.itemName];
    if (item.color) parts.push(item.color);
    if (item.size) parts.push(item.size);
    if (item.itemGroupName?.toUpperCase() === 'SHIRT' && item.sleeve) parts.push(item.sleeve);
    return parts.join(' - ');
  }

  selectItem(item: PicklistItem): void {
    this.dialogRef.close(item);
  }

  showItemInfo(item: PicklistItem, event: Event): void {
    event.stopPropagation();
    this.dialog.open(ItemDetailsDialogComponent, {
      data: { party: this.data.party, order: this.data.order, item },
      autoFocus: false,
      maxWidth: '520px',
    });
  }
}
