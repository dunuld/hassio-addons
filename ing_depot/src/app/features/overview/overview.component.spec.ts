import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Overview, Position, PriceUpdateStatus } from '../../../../shared/api-types';
import { depotFixture, flushDepots } from '../../testing';
import OverviewComponent from './overview.component';

const position: Position = {
  isin: 'IE00B4L5Y983',
  name: 'MSCI World',
  quantity: 5,
  costCents: 30250,
  price: 80,
  priceDate: '2026-06-30',
  priceSource: 'manual',
  priceEntity: null,
  onlinePrices: true,
  priceSymbol: null,
  resolvedSymbol: 'IWDA.L',
  valueCents: 40000,
  gainCents: 9750,
  gainPct: 32.23,
  ytdGainCents: -2850,
  ytdGainPct: -2.5,
  ytdBaseCents: 114000,
  realizedCents: 23250,
  dividendsNetCents: 750,
};

function overview(patch: Partial<Overview> = {}): Overview {
  return {
    year: 2026,
    depotId: null,
    startDate: null,
    periodStart: '2026-01-01',
    years: [2026, 2025],
    asOf: '2026-07-01',
    investedGrossCents: 60500,
    investedNetCents: -43500,
    feesCents: 1500,
    realizedCents: 23250,
    dividendsGrossCents: 1000,
    dividendsNetCents: 750,
    taxesCents: 3250,
    valueCents: 40000,
    costCents: 30250,
    gainCents: 9750,
    gainPct: 32.23,
    ytdGainCents: -2850,
    ytdGainPct: -2.5,
    exemptionCents: 100000,
    exemptionUsedCents: 24250,
    advanceLumpSumCents: 0,
    positions: [position],
    monthly: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      investedCents: i === 1 ? 60500 : 0,
      dividendsNetCents: i === 5 ? 750 : 0,
      realizedCents: 0,
    })),
    warnings: ['Es fehlt ein Startbestand.'],
    ...patch,
  };
}

/** Vergleich ohne Leerraum – Zellen und Elemente grenzen im DOM ohne Abstand aneinander. */
const sq = (text: string): string => text.replace(/\s+/g, '');

describe('OverviewComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OverviewComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  const priceStatus = (patch: Partial<PriceUpdateStatus> = {}): PriceUpdateStatus => ({
    mode: 'daily',
    intervalMinutes: 15,
    running: false,
    lastRunAt: '2026-11-27T21:30:00.000Z',
    lastUpdated: 3,
    lastErrors: [],
    ...patch,
  });

  function render(
    data: Overview | null = overview(),
    status: PriceUpdateStatus | null = priceStatus(),
  ) {
    const fixture = TestBed.createComponent(OverviewComponent);
    fixture.detectChanges();
    flushDepots(http);
    const statusReq = http.expectOne('api/prices/status');
    if (status) statusReq.flush(status);
    else statusReq.flush(null, { status: 500, statusText: 'Server Error' });
    if (data) {
      http.expectOne('api/overview').flush(data);
      fixture.detectChanges();
    }
    const el = fixture.nativeElement as HTMLElement;
    const text = () => {
      fixture.detectChanges();
      return (el.textContent ?? '').replace(/\s+/g, '');
    };
    return { fixture, el, text, component: fixture.componentInstance };
  }

  it('zeigt Kennzahlen, Hinweise, Monatsverlauf und Positionen', () => {
    const { el, text } = render();
    expect(text()).toContain(sq('Investiert 2026 605,00 €'));
    expect(text()).toContain(sq('netto -435,00 € nach Verkäufen'));
    expect(text()).toContain(sq('Realisierte Gewinne +232,50 €'));
    expect(text()).toContain(sq('Dividenden ausgezahlt 7,50 €'));
    expect(text()).toContain(sq('Kursgewinn seit 01.01. -28,50 € -2,50 %'));
    expect(text()).toContain(sq('Kursgewinn seit Kauf +97,50 € +32,23 %'));
    expect(text()).toContain(sq('Freistellungsauftrag: 242,50 € von 1.000,00 €'));
    expect(el.querySelector('.alert.warning')?.textContent).toContain('Startbestand');
    expect(el.querySelectorAll('.bar-group')).toHaveLength(12);
    expect(el.querySelectorAll<HTMLElement>('.bar.invested')[1]!.style.height).toBe('100%');
    expect(el.querySelectorAll<HTMLElement>('.bar.dividends')[5]!.style.height).toBe('1%');
    expect(text()).toContain(sq('MSCI World IE00B4L5Y983'));
    expect(text()).toContain(sq('30.06.2026 · manuell'));
    expect(el.querySelector('.tile-value.neg')).toBeTruthy();
  });

  it('nennt Vorabpauschalen nur, wenn es welche gibt', () => {
    const { text } = render();
    expect(text()).not.toContain('Vorabpauschalen');
  });

  it('zeigt die Vorabpauschalen des Jahres in der Fußzeile', () => {
    const { text } = render(overview({ advanceLumpSumCents: 1234 }));
    expect(text()).toContain(sq('Vorabpauschalen: 12,34 €'));
  });

  it('zeigt einen Hinweis für ein leeres Depot', () => {
    const { el, text } = render(
      overview({ positions: [], years: [2026], investedGrossCents: 0, exemptionCents: 0 }),
    );
    expect(text()).toContain(sq('Noch keine Daten vorhanden'));
    expect(el.querySelector('.tiles')).toBeNull();
  });

  it('blendet Monatsverlauf und Freistellungsauftrag aus, wenn nichts vorliegt', () => {
    const { el, text, component } = render(
      overview({
        positions: [],
        exemptionCents: 0,
        monthly: overview().monthly.map((m) => ({ ...m, investedCents: 0, dividendsNetCents: 0 })),
      }),
    );
    expect(el.querySelector('.bars')).toBeNull();
    expect(text()).not.toContain(sq('Freistellungsauftrag'));
    expect(text()).toContain(sq('Keine Positionen in diesem Jahr'));
    expect(component.sourceLabel({ ...position, priceSource: null })).toBe('');
  });

  it('wechselt das Jahr', () => {
    const { el, text } = render();
    const select = el.querySelector('select')!;
    select.value = '2025';
    select.dispatchEvent(new Event('change'));
    http.expectOne('api/overview?year=2025').flush(overview({ year: 2025, asOf: '2025-12-31' }));
    expect(text()).toContain(sq('Investiert 2025'));
    expect(text()).toContain(sq('Stand 31.12.2025'));
  });

  it('zeigt Ladefehler an', () => {
    const { text } = render(null);
    expect(text()).toContain(sq('Lade …'));
    http
      .expectOne('api/overview')
      .flush({ error: 'Kaputt' }, { status: 500, statusText: 'Server Error' });
    expect(text()).toContain(sq('Kaputt'));
  });

  it('speichert einen manuellen Kurs und die Kurs-Entität', () => {
    const { el, component, fixture } = render();
    el.querySelector<HTMLButtonElement>('td.actions button')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.edit-row')).toBeTruthy();

    component.priceInput = 'abc';
    component.save(position);
    fixture.detectChanges();
    expect(el.querySelector('.form-error')?.textContent).toContain('gültigen Kurs');

    component.priceInput = '82,50';
    component.entityInput = ' sensor.msci_world ';
    component.save(position);
    const put = http.expectOne('api/securities/IE00B4L5Y983');
    expect(put.request.body).toEqual({ priceEntity: 'sensor.msci_world' });
    put.flush(null);
    const post = http.expectOne('api/securities/IE00B4L5Y983/prices');
    expect(post.request.body).toEqual({ price: 82.5 });
    post.flush(null);
    http.expectOne('api/overview?year=2026').flush(overview());
    fixture.detectChanges();
    expect(el.querySelector('.edit-row')).toBeNull();
  });

  it('speichert nur den Kurs bzw. nur die Entität und zeigt Serverfehler', () => {
    const { component } = render();

    component.edit(position);
    component.priceInput = '90';
    component.save(position);
    http.expectOne('api/securities/IE00B4L5Y983/prices').flush(null);
    http.expectOne('api/overview?year=2026').flush(overview());

    const withEntity = { ...position, priceEntity: 'sensor.alt' };
    component.edit(withEntity);
    expect(component.entityInput).toBe('sensor.alt');
    component.entityInput = '';
    component.save(withEntity);
    const put = http.expectOne('api/securities/IE00B4L5Y983');
    expect(put.request.body).toEqual({ priceEntity: null });
    put.flush(null);
    http.expectOne('api/overview?year=2026').flush(overview());

    component.edit(position);
    component.priceInput = '90';
    component.save(position);
    http
      .expectOne('api/securities/IE00B4L5Y983/prices')
      .flush({ error: 'Ungültig' }, { status: 400, statusText: 'Bad Request' });
    expect(component.editError()).toBe('Ungültig');
    component.cancelEdit();
    expect(component.editing()).toBeNull();
  });

  it('benennt den Zeitraum nach dem Startpunkt, wenn er im Jahr liegt', () => {
    const { text } = render(overview({ periodStart: '2026-03-31', startDate: '2026-03-31' }));
    expect(text()).toContain(sq('Einstand ab Startpunkt 31.03.2026'));
    expect(text()).toContain(sq('Investiert seit 31.03.2026 605,00 €'));
    expect(text()).toContain(sq('Kursgewinn seit 31.03.2026'));
    expect(text()).toContain(sq('Seit 31.03.2026'));
  });

  it('zeigt die Depot-Auswahl bei mehreren Depots und lädt je Depot', () => {
    const fixture = TestBed.createComponent(OverviewComponent);
    fixture.detectChanges();
    flushDepots(http, [
      depotFixture(),
      depotFixture({
        id: 2,
        number: '9876543210',
        label: 'Gemeinschaft',
        displayName: 'Gemeinschaft',
      }),
    ]);
    http.expectOne('api/prices/status').flush(priceStatus());
    http.expectOne('api/overview').flush(overview());
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector<HTMLSelectElement>('app-depot-select select')!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Alle Depots',
      'Depot 1234567890',
      'Gemeinschaft',
    ]);

    select.value = '2';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    http.expectOne('api/overview?year=2026&depot=2').flush(overview({ depotId: 2 }));
    expect(localStorage.getItem('ing-depot-selected')).toBe('2');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    http.expectOne('api/overview?year=2026').flush(overview());
    expect(localStorage.getItem('ing-depot-selected')).toBeNull();
  });

  it('zeigt den Stand der Online-Kurse samt Hinweisen', () => {
    const { el, text } = render(
      overview(),
      priceStatus({ lastErrors: ['Microsoft: Kein Kürzel', 'World: Status 429'] }),
    );
    expect(text()).toContain(sq('Online-Kurse (Yahoo Finance): täglich nach Börsenschluss'));
    expect(text()).toContain(sq('(3 Kurse)'));
    expect(text()).toMatch(/zuletzt27\.11\.2026,\d{2}:\d{2}Uhr/); // Ortszeit des Browsers;
    expect(el.querySelector('.price-errors summary')?.textContent).toContain(
      '2 Hinweise zum letzten Abruf',
    );
    expect(el.querySelectorAll('.price-errors li')).toHaveLength(2);
  });

  it('beschreibt die Zeitpläne und blendet die Statuszeile bei Fehlern aus', () => {
    const { component } = render(overview(), null);
    expect(component.priceStatus()).toBeNull();
    expect(component.scheduleLabel(priceStatus({ mode: 'intraday', intervalMinutes: 30 }))).toBe(
      'alle 30 Minuten während der Handelszeit',
    );
    expect(component.scheduleLabel(priceStatus({ mode: 'off' }))).toBe('nur auf Abruf');
    expect(component.lastRunLabel(priceStatus({ lastRunAt: null }))).toBe('noch nicht abgerufen');
  });

  it('zeigt einen Hinweis und eine einzelne Meldung korrekt an', () => {
    const { el, text } = render(
      overview(),
      priceStatus({ lastRunAt: null, lastUpdated: 1, lastErrors: ['Nur einer'] }),
    );
    expect(text()).toContain(sq('noch nicht abgerufen'));
    expect(text()).not.toContain(sq('(1 Kurs)'));
    expect(el.querySelector('.price-errors summary')?.textContent).toContain('1 Hinweis zum');
  });

  it('aktualisiert die Kurse auf Knopfdruck und lädt die Übersicht neu', () => {
    const { el, fixture, text } = render(overview(), priceStatus({ lastUpdated: 1 }));
    expect(text()).toContain(sq('(1 Kurs)'));
    const button = el.querySelector<HTMLButtonElement>('.price-status button')!;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Rufe ab');
    http.expectOne('api/prices/refresh').flush(priceStatus({ lastUpdated: 5 }));
    http.expectOne('api/overview?year=2026').flush(overview());
    expect(text()).toContain(sq('(5 Kurse)'));
    expect(button.disabled).toBe(false);

    button.click();
    http
      .expectOne('api/prices/refresh')
      .flush({ error: 'Kaputt' }, { status: 500, statusText: 'Server Error' });
    expect(text()).toContain('Kaputt');
  });

  it('speichert Online-Abruf und Yahoo-Kürzel einer Position', () => {
    const { el, component, fixture } = render();
    component.edit(position);
    fixture.detectChanges();
    const symbol = el.querySelector<HTMLInputElement>('input[name=symbol]')!;
    expect(symbol.placeholder).toBe('IWDA.L');

    component.symbolInput = ' EUNL.DE ';
    component.onlineInput = false;
    component.save(position);
    const put = http.expectOne('api/securities/IE00B4L5Y983');
    expect(put.request.body).toEqual({ priceSymbol: 'EUNL.DE', onlinePrices: false });
    put.flush(null);
    http.expectOne('api/overview?year=2026').flush(overview());

    // Unverändert: keine Anfrage an die Wertpapier-Einstellungen
    component.edit({ ...position, priceSymbol: 'EUNL.DE', resolvedSymbol: null });
    expect(component.symbolInput).toBe('EUNL.DE');
    component.save({ ...position, priceSymbol: 'EUNL.DE' });
    http.expectNone('api/securities/IE00B4L5Y983');
    http.expectOne('api/overview?year=2026').flush(overview());
    fixture.detectChanges();
    expect(el.querySelector('.edit-row')).toBeNull();
  });
});
