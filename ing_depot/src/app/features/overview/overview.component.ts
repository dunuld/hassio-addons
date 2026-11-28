import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  Overview,
  Position,
  PriceUpdateStatus,
  SecurityUpdate,
} from '../../../../shared/api-types';
import { apiErrorMessage } from '../../core/api-error';
import { ApiService } from '../../core/api.service';
import { DepotSelectionService } from '../../core/depot-selection.service';
import { DepotSelectComponent } from '../../shared/depot-select.component';
import {
  MONTHS,
  formatDate,
  formatEuro,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedEuro,
  parseNumber,
  signClass,
} from '../../core/format';

const SOURCE_LABEL = {
  document: 'aus Dokument',
  manual: 'manuell',
  ha: 'Home Assistant',
  yahoo: 'Yahoo Finance',
} as const;

const TIME = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

/** Jahresübersicht: Kennzahlen, Monatsverlauf und Positionen. */
@Component({
  selector: 'app-overview',
  imports: [FormsModule, RouterLink, DepotSelectComponent],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.css',
})
export default class OverviewComponent {
  private readonly api = inject(ApiService);
  private readonly selection = inject(DepotSelectionService);

  readonly overview = signal<Overview | null>(null);
  readonly error = signal<string | null>(null);
  /** ISIN der Position, deren Kurs gerade bearbeitet wird */
  readonly editing = signal<string | null>(null);
  readonly editError = signal<string | null>(null);
  readonly priceStatus = signal<PriceUpdateStatus | null>(null);
  readonly refreshing = signal(false);
  priceInput = '';
  entityInput = '';
  symbolInput = '';
  onlineInput = true;

  readonly months = MONTHS;
  readonly euro = formatEuro;
  readonly signedEuro = formatSignedEuro;
  readonly percent = formatPercent;
  readonly price = formatPrice;
  readonly quantity = formatQuantity;
  readonly date = formatDate;
  readonly sign = signClass;

  /** Höchster Monatswert – Maßstab für die Balken */
  readonly monthlyMax = computed(() =>
    Math.max(
      1,
      ...(this.overview()?.monthly ?? []).flatMap((m) => [m.investedCents, m.dividendsNetCents]),
    ),
  );
  readonly hasMonthlyData = computed(() =>
    (this.overview()?.monthly ?? []).some((m) => m.investedCents > 0 || m.dividendsNetCents > 0),
  );
  /** Startpunkt im gewählten Jahr: Datum, ab dem gerechnet wird; sonst `null` (ab 01.01.) */
  private readonly fromStart = computed(() => {
    const o = this.overview();
    return o && !o.periodStart.endsWith('-01-01') ? formatDate(o.periodStart) : null;
  });
  readonly periodLabel = computed(() =>
    this.fromStart() ? `seit ${this.fromStart()}` : String(this.overview()?.year ?? ''),
  );
  readonly sinceLabel = computed(() => `seit ${this.fromStart() ?? '01.01.'}`);
  readonly sinceHeader = computed(() => `Seit ${this.fromStart() ?? '01.01.'}`);

  readonly isEmpty = computed(() => {
    const o = this.overview();
    return !!o && o.positions.length === 0 && o.years.length === 1 && o.investedGrossCents === 0;
  });

  constructor() {
    this.loadPriceStatus();
    // Laden – und neu laden, sobald ein anderes Depot gewählt wird
    effect(() => {
      this.selection.selected();
      untracked(() => this.load(this.overview()?.year));
    });
  }

  loadPriceStatus(): void {
    this.api.priceStatus().subscribe({
      next: (status) => this.priceStatus.set(status),
      // Ohne Status fehlt nur die Statuszeile – kein Grund für eine Fehlermeldung
      error: () => this.priceStatus.set(null),
    });
  }

  /** Beschreibung des Zeitplans für die Statuszeile */
  scheduleLabel(status: PriceUpdateStatus): string {
    if (status.mode === 'daily') return 'täglich nach Börsenschluss';
    if (status.mode === 'intraday') {
      return `alle ${status.intervalMinutes} Minuten während der Handelszeit`;
    }
    return 'nur auf Abruf';
  }

  lastRunLabel(status: PriceUpdateStatus): string {
    return status.lastRunAt
      ? `zuletzt ${TIME.format(new Date(status.lastRunAt))} Uhr`
      : 'noch nicht abgerufen';
  }

  refreshPrices(): void {
    this.refreshing.set(true);
    this.api.refreshPrices().subscribe({
      next: (status) => {
        this.refreshing.set(false);
        this.priceStatus.set(status);
        this.load(this.overview()?.year);
      },
      error: (err: unknown) => {
        this.refreshing.set(false);
        this.error.set(apiErrorMessage(err, 'Die Kurse konnten nicht abgerufen werden'));
      },
    });
  }

  load(year?: number): void {
    this.api.overview(year, this.selection.selected()).subscribe({
      next: (overview) => {
        this.overview.set(overview);
        this.error.set(null);
      },
      error: (err: unknown) =>
        this.error.set(apiErrorMessage(err, 'Die Übersicht konnte nicht geladen werden')),
    });
  }

  selectYear(value: string): void {
    this.load(Number(value));
  }

  barHeight(cents: number): number {
    return Math.max(0, Math.round((cents / this.monthlyMax()) * 100));
  }

  sourceLabel(position: Position): string {
    return position.priceSource ? SOURCE_LABEL[position.priceSource] : '';
  }

  edit(position: Position): void {
    this.editing.set(position.isin);
    this.editError.set(null);
    this.priceInput = '';
    this.entityInput = position.priceEntity ?? '';
    this.symbolInput = position.priceSymbol ?? '';
    this.onlineInput = position.onlinePrices;
  }

  cancelEdit(): void {
    this.editing.set(null);
  }

  save(position: Position): void {
    const price = parseNumber(this.priceInput);
    if (this.priceInput.trim() && (price === null || price <= 0)) {
      this.editError.set('Bitte einen gültigen Kurs eingeben, z. B. 123,45.');
      return;
    }
    const entity = this.entityInput.trim() || null;
    const symbol = this.symbolInput.trim() || null;
    const update: SecurityUpdate = {};
    if (entity !== position.priceEntity) update.priceEntity = entity;
    if (symbol !== position.priceSymbol) update.priceSymbol = symbol;
    if (this.onlineInput !== position.onlinePrices) update.onlinePrices = this.onlineInput;
    const fail = (err: unknown) =>
      this.editError.set(apiErrorMessage(err, 'Speichern fehlgeschlagen'));
    const done = () => {
      this.editing.set(null);
      this.load(this.overview()?.year);
    };
    const savePrice = () => {
      if (price === null) return done();
      this.api.addPrice(position.isin, { price }).subscribe({ next: done, error: fail });
    };
    if (Object.keys(update).length > 0) {
      this.api.updateSecurity(position.isin, update).subscribe({ next: savePrice, error: fail });
    } else {
      savePrice();
    }
  }
}
