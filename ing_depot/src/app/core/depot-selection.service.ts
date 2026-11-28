import { Injectable, computed, inject, signal } from '@angular/core';
import type { Depot } from '../../../shared/api-types';
import { apiErrorMessage } from './api-error';
import { ApiService } from './api.service';

const STORAGE_KEY = 'ing-depot-selected';

function readStored(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Liste der Depots und das gewählte Depot (`null` = alle) – seitenübergreifend gemerkt. */
@Injectable({ providedIn: 'root' })
export class DepotSelectionService {
  private readonly api = inject(ApiService);

  readonly depots = signal<Depot[]>([]);
  readonly error = signal<string | null>(null);
  private readonly stored = signal<number | null>(readStored());

  /** Gewähltes Depot; ein nicht (mehr) vorhandenes gilt als „alle“. */
  readonly selected = computed(() => {
    const id = this.stored();
    return this.depots().some((d) => d.id === id) ? id : null;
  });
  readonly multiple = computed(() => this.depots().length > 1);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.api.depots().subscribe({
      next: (depots) => {
        this.depots.set(depots);
        this.error.set(null);
      },
      error: (err: unknown) =>
        this.error.set(apiErrorMessage(err, 'Die Depots konnten nicht geladen werden')),
    });
  }

  select(id: number | null): void {
    this.stored.set(id);
    try {
      if (id === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      // Speicher nicht verfügbar (z. B. privater Modus) – Auswahl gilt nur für diese Sitzung
    }
  }

  nameOf(id: number): string {
    return this.depots().find((d) => d.id === id)?.displayName ?? '';
  }
}
