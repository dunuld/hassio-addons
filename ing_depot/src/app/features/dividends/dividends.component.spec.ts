import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { DividendCalendar, DividendEntry } from '../../../../shared/api-types';
import { depotFixture, flushDepots } from '../../testing';
import DividendsComponent from './dividends.component';

/** Vergleich ohne Leerraum – Zellen und Elemente grenzen im DOM ohne Abstand aneinander. */
const sq = (text: string): string => text.replace(/\s+/g, '');

const entry = (patch: Partial<DividendEntry>): DividendEntry => ({
  date: '2026-06-12',
  isin: 'US5949181045',
  name: 'Microsoft Corp.',
  status: 'paid',
  quantity: 20,
  perShare: null,
  grossCents: 915,
  netCents: 778,
  ...patch,
});

function calendar(patch: Partial<DividendCalendar> = {}): DividendCalendar {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    paidGrossCents: 0,
    paidNetCents: 0,
    expectedGrossCents: 0,
    entries: [] as DividendEntry[],
  }));
  months[5] = {
    month: 6,
    paidGrossCents: 915,
    paidNetCents: 778,
    expectedGrossCents: 120,
    entries: [
      entry({
        date: '2026-06-10',
        status: 'pending',
        isin: 'IE00B4L5Y983',
        name: 'World',
        quantity: 3,
        perShare: 0.4,
        grossCents: 120,
        netCents: null,
      }),
      entry({}),
    ],
  };
  months[8] = {
    month: 9,
    paidGrossCents: 0,
    paidNetCents: 0,
    expectedGrossCents: 150,
    entries: [
      entry({
        date: '2026-09-10',
        status: 'expected',
        name: 'World',
        perShare: 0.5,
        grossCents: 150,
        netCents: null,
      }),
    ],
  };
  return {
    year: 2026,
    depotId: null,
    years: [2026, 2025],
    isCurrentYear: true,
    months,
    paidGrossCents: 915,
    paidNetCents: 778,
    expectedGrossCents: 270,
    withoutHistory: [],
    ...patch,
  };
}

describe('DividendsComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DividendsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  function render(data: DividendCalendar = calendar(), depots = [depotFixture()]) {
    const fixture = TestBed.createComponent(DividendsComponent);
    fixture.detectChanges();
    flushDepots(http, depots);
    http.expectOne('api/dividends').flush(data);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = () => {
      fixture.detectChanges();
      return (el.textContent ?? '').replace(/\s+/g, '');
    };
    return { fixture, el, text, component: fixture.componentInstance };
  }

  it('zeigt Summen, Hinweis zur Hochrechnung, Balken und Monate mit Zahlungen', () => {
    const { el, text } = render();
    expect(text()).toContain(sq('Gezahlt 2026 7,78 € netto · brutto 9,15 €'));
    expect(text()).toContain(sq('Erwartet bis Dezember 2,70 € brutto, vor Steuern'));
    expect(text()).toContain(sq('Gesamt 2026 11,85 €'));
    expect(text()).toContain(sq('Hochrechnung'));
    expect(el.querySelectorAll('.bar-group')).toHaveLength(12);
    // Juni ist der höchste Monat (10,35 €): Gezahlt 915/1035 ≈ 88 %
    expect(el.querySelectorAll<HTMLElement>('.bar.paid')[5]!.style.height).toBe('88%');
    expect(el.querySelectorAll<HTMLElement>('.bar.expected')[8]!.style.height).toBe('14%');

    const headings = [...el.querySelectorAll('h3')].map((h) => sq(h.textContent ?? ''));
    expect(headings).toEqual([sq('Juni 2026 10,35 €'), sq('September 2026 1,50 €')]);
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => sq(r.textContent ?? ''));
    expect(rows[0]).toBe(sq('10.06.2026 World IE00B4L5Y983 3 0,40 € 1,20 € – Ausstehend'));
    expect(rows[1]).toBe(sq('12.06.2026 Microsoft Corp. US5949181045 20 – 9,15 € 7,78 € Gezahlt'));
    expect(rows[2]).toContain(sq('Erwartet'));
    expect(el.querySelectorAll('tr.planned')).toHaveLength(2);
  });

  it('zeigt vergangene Jahre ohne Erwartung und meldet fehlende Historie', () => {
    const { el, text } = render(
      calendar({
        isCurrentYear: false,
        expectedGrossCents: 0,
        withoutHistory: ['Siemens AG', 'World'],
        months: calendar().months.map((m) => ({
          ...m,
          entries: [],
          paidGrossCents: 0,
          expectedGrossCents: 0,
        })),
      }),
    );
    expect(text()).not.toContain(sq('Erwartet bis Dezember'));
    expect(text()).not.toContain(sq('Hochrechnung'));
    expect(text()).toContain(sq('Keine Dividenden in 2026.'));
    expect(el.querySelector('.without-history')?.textContent).toContain('Siemens AG, World');
    // Ohne Beträge haben alle Balken die Höhe 0
    expect(el.querySelectorAll<HTMLElement>('.bar.paid')[0]!.style.height).toBe('0%');
  });

  it('wechselt Jahr und Depot', () => {
    const depots = [
      depotFixture(),
      depotFixture({ id: 2, number: '9876543210', displayName: 'Zwei' }),
    ];
    const { el, fixture } = render(calendar(), depots);
    const selects = el.querySelectorAll<HTMLSelectElement>('select');
    expect(selects).toHaveLength(2);
    const yearSelect = selects[1]!;
    yearSelect.value = '2025';
    yearSelect.dispatchEvent(new Event('change'));
    http.expectOne('api/dividends?year=2025').flush(calendar({ year: 2025, isCurrentYear: false }));
    fixture.detectChanges();

    const depotSelect = selects[0]!;
    depotSelect.value = '2';
    depotSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    http.expectOne('api/dividends?year=2025&depot=2').flush(calendar({ year: 2025 }));
  });

  it('zeigt Ladefehler an', () => {
    const fixture = TestBed.createComponent(DividendsComponent);
    fixture.detectChanges();
    flushDepots(http);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    expect(el.textContent).toContain('Lade …');
    http.expectOne('api/dividends').flush({ error: 'Kaputt' }, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    expect(el.querySelector('.alert.error')?.textContent).toContain('Kaputt');
  });
});
