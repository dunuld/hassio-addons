import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { depotFixture, flushDepots } from '../../testing';
import DepotsComponent from './depots.component';

const statements = [
  { id: 11, date: '2026-06-30' },
  { id: 10, date: '2026-03-31' },
];

describe('DepotsComponent', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DepotsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function render(depots = [depotFixture({ statements, startDocumentId: 10 })]) {
    const fixture = TestBed.createComponent(DepotsComponent);
    fixture.detectChanges();
    flushDepots(http, depots);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, component: fixture.componentInstance };
  }

  it('zeigt Depots mit Startpunkt-Auswahl', () => {
    const { el } = render([
      depotFixture({ statements, startDocumentId: 10 }),
      depotFixture({ id: 2, number: '', displayName: 'Depot ohne Nummer', documentCount: 2 }),
    ]);
    const sections = el.querySelectorAll('section');
    expect(sections).toHaveLength(2);
    expect(sections[0]!.textContent).toContain('Depotnummer 1234567890 · 1 Dokument');
    const select = sections[0]!.querySelector('select')!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Gesamte Historie (alle Abrechnungen)',
      'Depotauszug per 30.06.2026',
      'Depotauszug per 31.03.2026',
    ]);
    expect(select.value).toBe('10');
    expect(sections[1]!.textContent).toContain('ohne erkennbare Depotnummer · 2 Dokumente');
    expect(sections[1]!.textContent).toContain('bitte einen Depotauszug');
  });

  it('zeigt einen Hinweis ohne Depots', () => {
    const { el } = render([]);
    expect(el.textContent).toContain('Noch keine Depots');
  });

  it('speichert Bezeichnung und Startpunkt', () => {
    const { el, fixture } = render();
    const input = el.querySelector('input')!;
    input.value = ' Gemeinschaftsdepot ';
    input.dispatchEvent(new Event('change'));
    const label = http.expectOne('api/depots/1');
    expect(label.request.method).toBe('PUT');
    expect(label.request.body).toEqual({ label: 'Gemeinschaftsdepot' });
    label.flush(depotFixture());
    flushDepots(http, [depotFixture({ statements })]);
    fixture.detectChanges();
    expect(el.querySelector('.saved')?.textContent).toContain('Gespeichert');

    // Unveränderte Bezeichnung wird nicht gespeichert
    el.querySelector('input')!.value = '';
    el.querySelector('input')!.dispatchEvent(new Event('change'));

    const select = el.querySelector('select')!;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(http.expectOne('api/depots/1').request.body).toEqual({ startDocumentId: null });
  });

  it('speichert einen Startpunkt und zeigt Fehler an', () => {
    const { el, fixture } = render();
    const select = el.querySelector('select')!;
    select.value = '11';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne('api/depots/1');
    expect(req.request.body).toEqual({ startDocumentId: 11 });
    req.flush({ error: 'Ungültig' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(el.querySelector('.alert.error')?.textContent).toContain('Ungültig');
  });

  it('zeigt Ladefehler der Depotliste', () => {
    const fixture = TestBed.createComponent(DepotsComponent);
    fixture.detectChanges();
    http
      .match('api/depots')
      .forEach((r) => r.flush({ error: 'Kaputt' }, { status: 500, statusText: 'Server Error' }));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Kaputt');
  });
});
