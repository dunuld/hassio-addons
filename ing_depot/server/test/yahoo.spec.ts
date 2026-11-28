import { describe, expect, it, vi } from 'vitest';
import { YahooClient, YahooError, berlinDate, type FetchFn } from '../src/prices/yahoo.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

/** Unix-Zeit (Sekunden) eines Handelstags, 09:00 Uhr UTC */
const day = (iso: string): number => Date.parse(`${iso}T09:00:00Z`) / 1000;

function chartLatest(price: number, currency: string, iso = '2026-11-27') {
  return {
    chart: {
      result: [{ meta: { currency, regularMarketPrice: price, regularMarketTime: day(iso) } }],
    },
  };
}

function chartHistory(currency: string, rows: [string, number | null][]) {
  return {
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: rows.map(([iso]) => day(iso)),
          indicators: { quote: [{ close: rows.map(([, close]) => close) }] },
        },
      ],
    },
  };
}

/** Fake-fetch: Antwort je URL-Ausschnitt; protokolliert alle Aufrufe. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = vi.fn<FetchFn>(async (input) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return key ? routes[key]!() : json({}, 404);
  });
  return { fn, calls };
}

describe('berlinDate', () => {
  it('rechnet Unix-Zeit in ein Datum deutscher Zeit um', () => {
    // 31.12. 23:30 UTC ist in Deutschland bereits der 01.01.
    expect(berlinDate(Date.parse('2025-12-31T23:30:00Z') / 1000)).toBe('2026-01-01');
    expect(berlinDate(day('2026-11-27'))).toBe('2026-11-27');
  });
});

describe('YahooClient.findSymbol', () => {
  it('bevorzugt Xetra, dann andere EUR-Plätze, sonst Yahoos Reihenfolge', async () => {
    const quotes = (list: [string, string][]) => () =>
      json({ quotes: list.map(([symbol, exchange]) => ({ symbol, exchange })) });
    const client = (list: [string, string][]) =>
      new YahooClient({ fetchFn: fakeFetch({ 'search?q=': quotes(list) }).fn });

    expect(
      await client([
        ['SIE.F', 'FRA'],
        ['SIE.DE', 'GER'],
      ]).findSymbol('DE0007236101'),
    ).toBe('SIE.DE');
    expect(
      await client([
        ['X.L', 'LSE'],
        ['X.AS', 'AMS'],
      ]).findSymbol('IE'),
    ).toBe('X.AS');
    expect(
      await client([
        ['VWRD.L', 'LSE'],
        ['VWRA.L', 'LSE'],
      ]).findSymbol('IE'),
    ).toBe('VWRD.L');
    expect(await client([]).findSymbol('IE')).toBeNull();
  });

  it('ignoriert Einträge ohne Kürzel und kodiert die ISIN in der URL', async () => {
    const { fn, calls } = fakeFetch({
      'search?q=': () =>
        json({ quotes: [{ exchange: 'GER' }, { symbol: 'MSFT', exchange: 'NMS' }] }),
    });
    expect(await new YahooClient({ fetchFn: fn, baseUrl: 'http://y' }).findSymbol('US 1')).toBe(
      'MSFT',
    );
    expect(calls[0]).toBe('http://y/v1/finance/search?q=US%201&quotesCount=10&newsCount=0');
    const headers = fn.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('ing-depot');
  });

  it('liefert null, wenn die Suche nichts kennt', async () => {
    const { fn } = fakeFetch({ 'search?q=': () => json({}) });
    expect(await new YahooClient({ fetchFn: fn }).findSymbol('XX')).toBeNull();
  });
});

describe('YahooClient.latest', () => {
  it('liefert EUR-Kurse unverändert mit dem Börsentag', async () => {
    const { fn, calls } = fakeFetch({ '/chart/SIE.DE': () => json(chartLatest(252.6, 'EUR')) });
    expect(await new YahooClient({ fetchFn: fn }).latest('SIE.DE')).toEqual({
      price: 252.6,
      date: '2026-11-27',
      currency: 'EUR',
    });
    expect(calls[0]).toContain('/v8/finance/chart/SIE.DE?interval=1d&range=5d');
  });

  it('rechnet Fremdwährungen mit dem aktuellen Devisenkurs um und speichert ihn zwischen', async () => {
    const { fn, calls } = fakeFetch({
      '/chart/USDEUR%3DX': () => json(chartLatest(0.9, 'EUR')),
      '/chart/MSFT': () => json(chartLatest(500, 'USD')),
      '/chart/VWRD.L': () => json(chartLatest(100, 'USD')),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect(await client.latest('MSFT')).toEqual({
      price: 450,
      date: '2026-11-27',
      currency: 'USD',
    });
    expect(await client.latest('VWRD.L')).toMatchObject({ price: 90 });
    expect(calls.filter((c) => c.includes('USDEUR'))).toHaveLength(1);
  });

  it('rundet umgerechnete Kurse auf Cent, EUR-Kurse nicht', async () => {
    const { fn } = fakeFetch({
      '/chart/USDEUR%3DX': () => json(chartLatest(0.9142, 'EUR')),
      '/chart/MSFT': () => json(chartLatest(492.85, 'USD')),
      '/chart/EXH1.DE': () => json(chartLatest(32.795, 'EUR')),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect((await client.latest('MSFT'))!.price).toBe(450.56); // 492,85 × 0,9142 = 450,563
    expect((await client.latest('EXH1.DE'))!.price).toBe(32.795);
  });

  it('rechnet Londoner Pence-Kurse über GBP um', async () => {
    const { fn } = fakeFetch({
      '/chart/GBPEUR%3DX': () => json(chartLatest(1.2, 'EUR')),
      '/chart/VUSA.L': () => json(chartLatest(5000, 'GBp')),
    });
    expect(await new YahooClient({ fetchFn: fn }).latest('VUSA.L')).toMatchObject({
      price: 60,
      currency: 'GBp',
    });
  });

  it('liefert null für unbekannte Kürzel oder unbrauchbare Antworten', async () => {
    const { fn } = fakeFetch({
      '/chart/LEER': () => json({ chart: { result: null } }),
      '/chart/NULL': () => json(chartLatest(0, 'EUR')),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect(await client.latest('GIBTSNICHT')).toBeNull(); // 404
    expect(await client.latest('LEER')).toBeNull();
    expect(await client.latest('NULL')).toBeNull();
  });

  it('meldet Fehler beim Devisenkurs, ohne ihn zwischenzuspeichern', async () => {
    let fx = 0;
    const { fn } = fakeFetch({
      '/chart/USDEUR%3DX': () => (fx++ === 0 ? json({}, 404) : json(chartLatest(0.5, 'EUR'))),
      '/chart/MSFT': () => json(chartLatest(100, 'USD')),
    });
    const client = new YahooClient({ fetchFn: fn });
    await expect(client.latest('MSFT')).rejects.toThrow('Kein Devisenkurs USD→EUR verfügbar');
    expect(await client.latest('MSFT')).toMatchObject({ price: 50 });
  });

  it('meldet HTTP- und Netzwerkfehler verständlich', async () => {
    const status = new YahooClient({ fetchFn: async () => json({}, 429) });
    await expect(status.latest('X')).rejects.toThrow(
      new YahooError('Yahoo Finance antwortet mit Status 429'),
    );
    const offline = new YahooClient({
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(offline.findSymbol('X')).rejects.toThrow(/nicht erreichbar.*fetch failed/);
  });
});

describe('YahooClient.closeOn', () => {
  it('liefert den letzten Schlusskurs an oder vor dem Stichtag', async () => {
    const { fn, calls } = fakeFetch({
      '/chart/SIE.DE': () =>
        json(
          chartHistory('EUR', [
            ['2025-12-29', 237.05],
            ['2025-12-30', 239.15],
            ['2025-12-31', null], // kein Handel
            ['2026-01-02', 241],
          ]),
        ),
    });
    expect(await new YahooClient({ fetchFn: fn }).closeOn('SIE.DE', '2025-12-31')).toEqual({
      price: 239.15,
      date: '2025-12-30',
      currency: 'EUR',
    });
    // Zeitraum: 10 Tage vor bis einschließlich Stichtag
    const end = Date.parse('2026-01-01T00:00:00Z') / 1000;
    expect(calls[0]).toContain(`period1=${end - 11 * 86400}&period2=${end}`);
  });

  it('rechnet mit dem Devisenkurs desselben Tages um', async () => {
    const { fn } = fakeFetch({
      '/chart/USDEUR%3DX': () => json(chartHistory('EUR', [['2025-12-31', 0.85]])),
      '/chart/MSFT': () => json(chartHistory('USD', [['2025-12-31', 480]])),
    });
    expect(await new YahooClient({ fetchFn: fn }).closeOn('MSFT', '2025-12-31')).toEqual({
      price: 408,
      date: '2025-12-31',
      currency: 'USD',
    });
  });

  it('liefert null ohne passende Kurse', async () => {
    const { fn } = fakeFetch({
      '/chart/LEER': () => json({ chart: { result: [{ meta: {} }] } }),
      '/chart/SPAET': () => json(chartHistory('EUR', [['2026-01-05', 10]])),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect(await client.closeOn('GIBTSNICHT', '2025-12-31')).toBeNull();
    expect(await client.closeOn('LEER', '2025-12-31')).toBeNull();
    expect(await client.closeOn('SPAET', '2025-12-31')).toBeNull();
  });
});

describe('YahooClient.dividends', () => {
  const dividends = (currency: string, events: [string, unknown][]) => ({
    chart: {
      result: [
        {
          meta: { currency },
          events: {
            dividends: Object.fromEntries(
              events.map(([iso, amount], i) => [String(i), { date: day(iso), amount }]),
            ),
          },
        },
      ],
    },
  });

  it('liefert Ex-Tag und Betrag je Stück, sortiert und auf den Zeitraum begrenzt', async () => {
    const { fn, calls } = fakeFetch({
      '/chart/EXH1.DE': () =>
        json(
          dividends('EUR', [
            ['2026-04-15', 0.402724],
            ['2026-01-15', 0.397814],
            ['2024-12-01', 0.5], // vor dem Zeitraum
            ['2026-02-01', 0], // ungültig
            ['2026-03-01', 'x'],
          ]),
        ),
    });
    expect(
      await new YahooClient({ fetchFn: fn }).dividends('EXH1.DE', '2025-06-01', '2026-06-01'),
    ).toEqual([
      { exDate: '2026-01-15', amount: 0.397814, currency: 'EUR' },
      { exDate: '2026-04-15', amount: 0.402724, currency: 'EUR' },
    ]);
    expect(calls[0]).toContain('&events=div');
  });

  it('rechnet Fremdwährungen genau und Pence über GBP um', async () => {
    const { fn } = fakeFetch({
      '/chart/USDEUR%3DX': () => json(chartLatest(0.9142, 'EUR')),
      '/chart/GBPEUR%3DX': () => json(chartLatest(1.2, 'EUR')),
      '/chart/MSFT': () => json(dividends('USD', [['2026-05-21', 0.91]])),
      '/chart/VUSA.L': () => json(dividends('GBp', [['2026-05-21', 25]])),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect(await client.dividends('MSFT', '2026-01-01', '2026-12-31')).toEqual([
      { exDate: '2026-05-21', amount: 0.831922, currency: 'USD' },
    ]);
    expect((await client.dividends('VUSA.L', '2026-01-01', '2026-12-31'))![0]!.amount).toBe(0.3);
  });

  it('liefert null für unbekannte Kürzel und eine leere Liste ohne Ausschüttungen', async () => {
    const { fn } = fakeFetch({
      '/chart/ACC.DE': () => json({ chart: { result: [{ meta: {} }] } }),
    });
    const client = new YahooClient({ fetchFn: fn });
    expect(await client.dividends('GIBTSNICHT', '2026-01-01', '2026-12-31')).toBeNull();
    expect(await client.dividends('ACC.DE', '2026-01-01', '2026-12-31')).toEqual([]);
  });
});
