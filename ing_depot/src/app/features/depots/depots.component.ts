import { Component, inject, signal } from '@angular/core';
import type { Depot, DepotUpdate } from '../../../../shared/api-types';
import { apiErrorMessage } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DepotSelectionService } from '../../core/depot-selection.service';
import { formatDate } from '../../core/format';

/** Depots verwalten: Bezeichnung und Startpunkt (Depotauszug) je Depot. */
@Component({
  selector: 'app-depots',
  templateUrl: './depots.component.html',
})
export default class DepotsComponent {
  private readonly api = inject(ApiService);
  readonly selection = inject(DepotSelectionService);

  readonly error = signal<string | null>(null);
  /** ID des Depots, dessen Änderung gerade gespeichert wurde */
  readonly saved = signal<number | null>(null);
  readonly date = formatDate;

  constructor() {
    this.selection.reload();
  }

  private update(depot: Depot, update: DepotUpdate): void {
    this.error.set(null);
    this.saved.set(null);
    this.api.updateDepot(depot.id, update).subscribe({
      next: () => {
        this.saved.set(depot.id);
        this.selection.reload();
      },
      error: (err: unknown) => this.error.set(apiErrorMessage(err, 'Speichern fehlgeschlagen')),
    });
  }

  saveLabel(depot: Depot, value: string): void {
    const label = value.trim() || null;
    if (label !== depot.label) this.update(depot, { label });
  }

  saveStart(depot: Depot, value: string): void {
    this.update(depot, { startDocumentId: value ? Number(value) : null });
  }
}
