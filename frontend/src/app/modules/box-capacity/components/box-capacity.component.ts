import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ApiService } from '../../../core/services/api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { BoxType, BoxTypeMatrixRow } from '../../../core/models/picking.models';

interface BoxTypeFormModel {
  label: string;
  sizeLWH: string;
}

function emptyBoxTypeForm(): BoxTypeFormModel {
  return { label: '', sizeLWH: '' };
}

interface CellFormModel {
  itemGroupName: string;
  capacity: number;
}

function emptyCellForm(): CellFormModel {
  return { itemGroupName: '', capacity: 1 };
}

@Component({
  selector: 'app-box-capacity',
  templateUrl: './box-capacity.component.html',
  styleUrls: ['./box-capacity.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoxCapacityComponent implements OnInit {
  readonly boxTypeColumns = ['label', 'size', 'active', 'actions'];

  matrix: BoxTypeMatrixRow[] = [];
  matrixLoading = false;
  matrixError: string | null = null;

  boxTypeFormOpen = false;
  editingBoxType: BoxType | null = null;
  boxTypeForm: BoxTypeFormModel = emptyBoxTypeForm();
  boxTypeFormError = '';
  savingBoxType = false;

  selectedBoxType: BoxTypeMatrixRow | null = null;
  cellFormOpen = false;
  editingCell: { itemGroupName: string } | null = null;
  cellForm: CellFormModel = emptyCellForm();
  cellFormError = '';
  savingCell = false;

  constructor(
    private api:    ApiService,
    private notify: NotificationService,
    private cdr:    ChangeDetectorRef,
  ) {}

  ngOnInit(): void { this.refreshMatrix(); }

  // ── Box Types + matrix ──────────────────────────────────────
  refreshMatrix(): void {
    this.matrixLoading = true;
    this.matrixError = null;
    this.api.getBoxTypeMatrix().subscribe({
      next: (r) => {
        this.matrix = r.data;
        if (this.selectedBoxType) {
          this.selectedBoxType = this.matrix.find(t => t.BoxTypeID === this.selectedBoxType!.BoxTypeID) || null;
        }
        this.matrixLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.matrixLoading = false;
        this.matrixError = err.error?.message || 'Failed to load box types';
        this.cdr.markForCheck();
      },
    });
  }

  openAddBoxTypeForm(): void {
    this.editingBoxType = null;
    this.boxTypeForm = emptyBoxTypeForm();
    this.boxTypeFormError = '';
    this.boxTypeFormOpen = true;
  }

  openEditBoxTypeForm(bt: BoxType): void {
    this.editingBoxType = bt;
    this.boxTypeForm = { label: bt.Label, sizeLWH: bt.SizeLWH || '' };
    this.boxTypeFormError = '';
    this.boxTypeFormOpen = true;
  }

  closeBoxTypeForm(): void {
    this.boxTypeFormOpen = false;
    this.editingBoxType = null;
  }

  saveBoxType(): void {
    const label = this.boxTypeForm.label?.trim();
    if (!label) { this.boxTypeFormError = 'Label is required'; return; }

    this.savingBoxType = true;
    this.boxTypeFormError = '';
    this.api.upsertBoxType(label, this.boxTypeForm.sizeLWH?.trim() || undefined).subscribe({
      next: () => {
        this.savingBoxType = false;
        this.notify.success(this.editingBoxType ? 'Box type updated' : 'Box type created');
        this.closeBoxTypeForm();
        this.refreshMatrix();
      },
      error: (err) => {
        this.savingBoxType = false;
        this.boxTypeFormError = err.error?.message || 'Failed to save box type';
        this.cdr.markForCheck();
      },
    });
  }

  deleteBoxType(bt: BoxType): void {
    if (!confirm(`Delete box type "${bt.Label}"? This also removes its capacity matrix rows.`)) return;
    this.api.deleteBoxType(bt.BoxTypeID).subscribe({
      next: () => {
        this.notify.success(`Deleted box type "${bt.Label}"`);
        if (this.selectedBoxType?.BoxTypeID === bt.BoxTypeID) this.selectedBoxType = null;
        this.refreshMatrix();
      },
      error: (err) => this.notify.error(err.error?.message || 'Failed to delete box type'),
    });
  }

  selectBoxType(bt: BoxTypeMatrixRow): void {
    this.selectedBoxType = this.selectedBoxType?.BoxTypeID === bt.BoxTypeID ? null : bt;
    this.cdr.markForCheck();
  }

  openAddCellForm(): void {
    this.editingCell = null;
    this.cellForm = emptyCellForm();
    this.cellFormError = '';
    this.cellFormOpen = true;
  }

  openEditCellForm(cell: { itemGroupName: string; capacity: number }): void {
    this.editingCell = { itemGroupName: cell.itemGroupName };
    this.cellForm = { itemGroupName: cell.itemGroupName, capacity: cell.capacity };
    this.cellFormError = '';
    this.cellFormOpen = true;
  }

  closeCellForm(): void {
    this.cellFormOpen = false;
    this.editingCell = null;
  }

  saveCell(): void {
    if (!this.selectedBoxType) return;
    const name = this.cellForm.itemGroupName?.trim();
    const cap  = Number(this.cellForm.capacity);
    if (!name) { this.cellFormError = 'Item Group name is required'; return; }
    if (!Number.isFinite(cap) || cap <= 0) { this.cellFormError = 'Capacity must be a positive number'; return; }

    this.savingCell = true;
    this.cellFormError = '';
    this.api.upsertBoxTypeCapacity(this.selectedBoxType.BoxTypeID, name, cap).subscribe({
      next: () => {
        this.savingCell = false;
        this.notify.success('Capacity saved');
        this.closeCellForm();
        this.refreshMatrix();
      },
      error: (err) => {
        this.savingCell = false;
        this.cellFormError = err.error?.message || 'Failed to save capacity';
        this.cdr.markForCheck();
      },
    });
  }

  deleteCell(itemGroupName: string): void {
    if (!this.selectedBoxType) return;
    if (!confirm(`Remove "${itemGroupName}" from "${this.selectedBoxType.Label}"?`)) return;
    this.api.deleteBoxTypeCapacity(this.selectedBoxType.BoxTypeID, itemGroupName).subscribe({
      next: () => {
        this.notify.success('Removed');
        this.refreshMatrix();
      },
      error: (err) => this.notify.error(err.error?.message || 'Failed to remove'),
    });
  }
}
