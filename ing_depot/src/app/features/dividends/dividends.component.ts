import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import type { DividendCalendar, DividendMonth, DividendStatus } from '../../../../shared/api-types';
import { apiErrorMessage } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DepotSelectionService } from '../../core/depot-selection.service';
import { formatDate, formatEuro, formatQuantity } from '../../core/format';
import { DepotSelectComponent } from '../../shared/depot-select.component';

const MONTH_NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
];
const STATUS_LABEL: Record<DividendStatus, string> = {
  paid: 'Gezahlt',
  pending: 'Ausstehend',
  expected: 'Erwartet',
};
const PER_SHARE = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Dividendenkalender: gezahlte und erwartete Dividenden je Monat eines Jahres. */
@Component({
  selector: 'app-dividends',
  imports: [DepotSelectComponent],
  templateUrl: './dividends.component.html',
  styleUrl: './dividends.component.css',
})
export default class DividendsComponent {
  private readonly api = inject(ApiService);
  private readonly selection = inject(DepotSelectionService);

  readonly calendar = signal<DividendCalendar | null>(null);
  readonly error = signal<string | null>(null);

  readonly monthNames = MONTH_NAMES;
  readonly monthShort = MONTH_SHORT;
  readonly euro = formatEuro;
  readonly quantity = formatQuantity;
  readonly date = formatDate;
  readonly perShare = (value: number | null): string =>
    value === null ? '–' : PER_SHARE.format(value);
  readonly statusLabel = (status: DividendStatus): string => STATUS_LABEL[status];

  /** Monate mit mindestens einer Dividende */
  readonly activeMonths = computed(() =>
    (this.calendar()?.months ?? []).filter((m) => m.entries.length > 0),
  );
  /** Höchste Monatssumme – Maßstab für die Balken */
  private readonly maxMonth = computed(() =>
    Math.max(1, ...(this.calendar()?.months ?? []).map((m) => this.monthTotal(m))),
  );

  constructor() {
    // Laden – und neu laden, sobald ein anderes Depot gewählt wird
    effect(() => {
      this.selection.selected();
      untracked(() => this.load(this.calendar()?.year));
    });
  }

  load(year?: number): void {
    this.api.dividends(year, this.selection.selected()).subscribe({
      next: (calendar) => {
        this.calendar.set(calendar);
        this.error.set(null);
      },
      error: (err: unknown) =>
        this.error.set(apiErrorMessage(err, 'Der Dividendenkalender konnte nicht geladen werden')),
    });
  }

  selectYear(value: string): void {
    this.load(Number(value));
  }

  monthTotal(month: DividendMonth): number {
    return month.paidGrossCents + month.expectedGrossCents;
  }

  barHeight(cents: number): number {
    return Math.round((cents / this.maxMonth()) * 100);
  }
}
