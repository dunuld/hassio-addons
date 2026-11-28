import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Transaction, TransactionType } from '../../../../shared/api-types';
import { apiErrorMessage } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DepotSelectionService } from '../../core/depot-selection.service';
import { DepotSelectComponent } from '../../shared/depot-select.component';
import {
  formatDate,
  formatEuro,
  formatPrice,
  formatQuantity,
  parseNumber,
} from '../../core/format';

const TYPE_LABEL: Record<TransactionType, string> = {
  buy: 'Kauf',
  sell: 'Verkauf',
  dividend: 'Ertrag',
  opening: 'Startbestand',
  exchange_out: 'Umtausch (Abgang)',
  exchange_in: 'Umtausch (Zugang)',
  advance_lump_sum: 'Vorabpauschale',
};

/** Alle Buchungen sowie das Erfassen eines Startbestands. */
@Component({
  selector: 'app-transactions',
  imports: [FormsModule, DepotSelectComponent],
  templateUrl: './transactions.component.html',
})
export default class TransactionsComponent {
  private readonly api = inject(ApiService);
  readonly selection = inject(DepotSelectionService);

  readonly transactions = signal<Transaction[]>([]);
  readonly error = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly year = signal<number | null>(null);

  readonly years = computed(() =>
    [...new Set(this.transactions().map((t) => Number(t.date.slice(0, 4))))].sort((a, b) => b - a),
  );
  readonly visible = computed(() => {
    const year = this.year();
    return year === null
      ? this.transactions()
      : this.transactions().filter((t) => t.date.startsWith(`${year}-`));
  });

  form = { depotNumber: '', isin: '', name: '', date: '', quantity: '', cost: '' };

  readonly euro = formatEuro;
  readonly price = formatPrice;
  readonly quantity = formatQuantity;
  readonly date = formatDate;
  readonly typeLabel = (type: TransactionType): string => TYPE_LABEL[type];
  readonly documentUrl = (id: number): string => this.api.documentUrl(id);

  constructor() {
    // Laden – und neu laden, sobald ein anderes Depot gewählt wird
    effect(() => this.load());
  }

  load(): void {
    this.api.transactions(this.selection.selected()).subscribe({
      next: (transactions) => {
        this.transactions.set(transactions);
        this.error.set(null);
      },
      error: (err: unknown) =>
        this.error.set(apiErrorMessage(err, 'Die Buchungen konnten nicht geladen werden')),
    });
  }

  selectYear(value: string): void {
    this.year.set(value ? Number(value) : null);
  }

  addOpening(): void {
    const quantity = parseNumber(this.form.quantity);
    const cost = parseNumber(this.form.cost);
    const depotNumber = this.form.depotNumber.replace(/\s/g, '') || this.defaultDepotNumber();
    if (!depotNumber || !this.form.isin.trim() || !this.form.date) {
      this.formError.set('Bitte Depotnummer, ISIN und Kaufdatum angeben.');
      return;
    }
    if (quantity === null || quantity <= 0 || cost === null || cost < 0) {
      this.formError.set('Bitte Stückzahl und Einstandswert als Zahl angeben.');
      return;
    }
    this.api
      .addOpening({
        depotNumber,
        isin: this.form.isin.trim().toUpperCase(),
        name: this.form.name.trim(),
        date: this.form.date,
        quantity,
        costCents: Math.round(cost * 100),
      })
      .subscribe({
        next: () => {
          this.form = { depotNumber: '', isin: '', name: '', date: '', quantity: '', cost: '' };
          this.formError.set(null);
          this.selection.reload();
          this.load();
        },
        error: (err: unknown) =>
          this.formError.set(apiErrorMessage(err, 'Speichern fehlgeschlagen')),
      });
  }

  /** Vorbelegung: Nummer des gewählten Depots bzw. des einzigen Depots */
  defaultDepotNumber(): string {
    const depots = this.selection.depots();
    const selected = depots.find((d) => d.id === this.selection.selected());
    return (selected ?? (depots.length === 1 ? depots[0] : undefined))?.number ?? '';
  }

  remove(transaction: Transaction): void {
    this.api.deleteTransaction(transaction.id).subscribe({
      next: () => {
        this.selection.reload();
        this.load();
      },
      error: (err: unknown) => this.error.set(apiErrorMessage(err, 'Löschen fehlgeschlagen')),
    });
  }
}
