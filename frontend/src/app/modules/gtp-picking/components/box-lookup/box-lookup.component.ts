import { Component, ElementRef, ViewChild } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-box-lookup',
  templateUrl: './box-lookup.component.html',
  styleUrls: ['./box-lookup.component.scss'],
})
export class BoxLookupComponent {
  @ViewChild('boxInputEl') boxInputRef?: ElementRef<HTMLInputElement>;

  boxNumber = '';

  constructor(private router: Router) {}

  lookup(): void {
    const value = this.boxNumber.trim();
    if (!value) return;
    this.router.navigate(['/picking/box-contents-label', value]);
    this.boxNumber = '';
  }
}
