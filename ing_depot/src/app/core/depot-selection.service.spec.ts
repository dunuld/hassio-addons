import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { depotFixture, flushDepots } from '../testing';
import { DepotSelectionService } from './depot-selection.service';

describe('DepotSelectionService', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('merkt sich das gewählte Depot und verwirft unbekannte', () => {
    localStorage.setItem('ing-depot-selected', '2');
    const service = TestBed.inject(DepotSelectionService);
    expect(service.selected()).toBeNull(); // Depots noch nicht geladen
    flushDepots(http, [depotFixture(), depotFixture({ id: 2, displayName: 'Zwei' })]);
    expect(service.selected()).toBe(2);
    expect(service.multiple()).toBe(true);
    expect(service.nameOf(2)).toBe('Zwei');
    expect(service.nameOf(9)).toBe('');

    service.reload();
    flushDepots(http, [depotFixture()]);
    expect(service.selected()).toBeNull();
    expect(service.multiple()).toBe(false);
  });

  it('ignoriert ungültige gespeicherte Werte und fehlenden Speicher', () => {
    localStorage.setItem('ing-depot-selected', 'abc');
    const service = TestBed.inject(DepotSelectionService);
    flushDepots(http, [depotFixture()]);
    expect(service.selected()).toBeNull();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('voll');
    });
    service.select(1);
    expect(service.selected()).toBe(1);
  });

  it('liest auch ohne verfügbaren Speicher', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('gesperrt');
    });
    const service = TestBed.inject(DepotSelectionService);
    flushDepots(http);
    expect(service.selected()).toBeNull();
  });

  it('meldet Ladefehler', () => {
    const service = TestBed.inject(DepotSelectionService);
    http.expectOne('api/depots').flush(null, { status: 500, statusText: 'Server Error' });
    expect(service.error()).toBe('Die Depots konnten nicht geladen werden');
    service.reload();
    flushDepots(http);
    expect(service.error()).toBeNull();
  });
});
