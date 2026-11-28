import { Component, inject } from '@angular/core';
import { DepotSelectionService } from '../core/depot-selection.service';

/** Auswahl des Depots; nur sichtbar, wenn es mehr als ein Depot gibt. */
@Component({
  selector: 'app-depot-select',
  template: `
    @if (selection.multiple()) {
      <label class="year-select">
        Depot
        <select #depot (change)="change(depot.value)">
          <option value="" [selected]="selection.selected() === null">Alle Depots</option>
          @for (d of selection.depots(); track d.id) {
            <option [value]="d.id" [selected]="d.id === selection.selected()">
              {{ d.displayName }}
            </option>
          }
        </select>
      </label>
    }
  `,
})
export class DepotSelectComponent {
  readonly selection = inject(DepotSelectionService);

  change(value: string): void {
    this.selection.select(value ? Number(value) : null);
  }
}
