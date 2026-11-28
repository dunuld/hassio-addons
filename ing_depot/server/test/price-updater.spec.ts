import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { openDatabase, type Database } from '../src/db/database.js';
import { DepotService } from '../src/depot.service.js';
import { PriceUpdater, berlinClock, isDue } from '../src/prices/price-updater.js';
import type { Quote, YahooClient } from '../src/prices/yahoo.js';
import { BUY_LINES, fakePdf, textReader, tradeLines } from './fixtures.js';

const WORLD = 'IE00B4L5Y983';
const MSFT = 'US5949181045';

/** Berliner Ortszeit im Winter (UTC+1) als Date */
const berlin = (iso: string, time: string): Date => new Date(`${iso}T${time}:00+01:00`);

describe('berlinClock', () => {
  it('liefert Wochentag, Datum und Uhrzeit in deutscher Zeit', () => {
    expect(berlinClock(new Date('2026-11-27T21:45:00Z'))).toEqual({
      weekday: 'Fri',
      date: '2026-11-27',
      time: '22:45',
    });
    // Sommerzeit (UTC+2) und Datumswechsel
    expect(berlinClock(new Date('2026-07-01T22:30:00Z'))).toMatchObject({
      date: '2026-07-02',
      time: '00:30',
    });
  });
});

describe('isDue', () => {
  const friday = '2026-11-27';

  it('ruft im Modus „daily“ einmal nach Börsenschluss ab', () => {
    expect(isDue('daily', 15, berlin(friday, '22:45'), null)).toBe(true);
    expect(isDue('daily', 15, berlin(friday, '22:45'), berlin(friday, '21:00'))).toBe(true);
    expect(isDue('daily', 15, berlin(friday, '22:45'), berlin(friday, '22:31'))).toBe(false);
    expect(isDue('daily', 15, berlin(friday, '22:00'), null)).toBe(false);
    // Lauf vom Vortag zählt nicht
    expect(isDue('daily', 15, berlin(friday, '23:10'), berlin('2026-11-26', '22:40'))).toBe(true);
  });

  it('ruft am Wochenende und im Modus „off“ nie ab', () => {
    expect(isDue('daily', 15, berlin('2026-11-28', '23:00'), null)).toBe(false);
    expect(isDue('intraday', 15, berlin('2026-11-29', '12:00'), null)).toBe(false);
    expect(isDue('off', 15, berlin(friday, '23:00'), null)).toBe(false);
  });

  it('ruft im Modus „intraday“ während der Handelszeit im Abstand ab', () => {
    expect(isDue('intraday', 15, berlin(friday, '10:00'), null)).toBe(true);
    expect(isDue('intraday', 15, berlin(friday, '10:00'), berlin(friday, '09:50'))).toBe(false);
    expect(isDue('intraday', 15, berlin(friday, '10:00'), berlin(friday, '09:45'))).toBe(true);
    expect(isDue('intraday', 30, berlin(friday, '10:00'), berlin(friday, '09:45'))).toBe(false);
    expect(isDue('intraday', 15, berlin(friday, '07:30'), null)).toBe(false);
    // Nach Börsenschluss zusätzlich der Schlusskurs
    expect(isDue('intraday', 15, berlin(friday, '22:35'), berlin(friday, '22:20'))).toBe(true);
    expect(isDue('intraday', 15, berlin(friday, '22:50'), berlin(friday, '22:35'))).toBe(false);
  });
});

describe('PriceUpdater', () => {
  let db: Database;
  let depot: DepotService;
  let notify: Mock<() => void>;
  const now = new Date('2026-07-01T10:00:00Z');

  /** Yahoo-Ersatz: Kürzel und Kurse je Wertpapier */
  function fakeYahoo(
    overrides: Partial<Record<'findSymbol' | 'latest' | 'closeOn', unknown>> = {},
  ) {
    const yahoo = {
      findSymbol: vi.fn(
        async (isin: string) => ({ [WORLD]: 'EUNL.DE', [MSFT]: 'MSFT' })[isin] ?? null,
      ),
      latest: vi.fn(async (symbol: string): Promise<Quote | null> =>
        symbol === 'EUNL.DE'
          ? { price: 60, date: '2026-07-01', currency: 'EUR' }
          : { price: 450, date: '2026-06-30', currency: 'USD' },
      ),
      closeOn: vi.fn(async (): Promise<Quote | null> => ({
        price: 400,
        date: '2025-12-30',
        currency: 'USD',
      })),
      ...overrides,
    };
    return yahoo;
  }

  function updater(
    yahoo: ReturnType<typeof fakeYahoo>,
    mode: 'off' | 'daily' | 'intraday' = 'daily',
  ) {
    return new PriceUpdater(depot, yahoo as unknown as YahooClient, {
      mode,
      intervalMinutes: 15,
      now: () => now,
      pauseMs: 0,
      log: () => undefined,
    });
  }

  beforeEach(async () => {
    db = openDatabase(':memory:');
    depot = new DepotService(db, { today: () => '2026-07-01', readPdf: textReader });
    await depot.importPdf(fakePdf(BUY_LINES), 'kauf.pdf');
    const msft = tradeLines({
      order: '2.001',
      isin: MSFT,
      wkn: '870747',
      name: 'Microsoft Corp.',
      date: '10.06.2025',
      quantity: '2,00',
      price: '300,00',
      gross: '600,00',
      fee: '0,00',
      total: '600,00',
    });
    await depot.importPdf(fakePdf(msft), 'msft.pdf');
    notify = vi.fn<() => void>();
    depot.onChange(notify);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('holt aktuelle Kurse und fehlende Schlusskurse zum 31.12. und merkt sich die Kürzel', async () => {
    const yahoo = fakeYahoo();
    const prices = updater(yahoo);
    const status = await prices.run();

    expect(status).toMatchObject({
      mode: 'daily',
      intervalMinutes: 15,
      running: false,
      lastRunAt: now.toISOString(),
      lastUpdated: 3,
      lastErrors: [],
    });
    expect(yahoo.closeOn).toHaveBeenCalledWith('MSFT', '2025-12-31');
    expect(notify).toHaveBeenCalledOnce();

    const overview = depot.overview(2026);
    const msft = overview.positions.find((p) => p.isin === MSFT)!;
    expect(msft).toMatchObject({
      price: 450,
      priceSource: 'yahoo',
      resolvedSymbol: 'MSFT',
      valueCents: 90000,
      // Kursgewinn seit 01.01. aus dem nachgeholten Jahresschlusskurs: 900 € − 2 × 400 €
      ytdGainCents: 10000,
    });
    expect(overview.warnings.join(' ')).not.toContain('fehlt ein Kurs zum');

    // Zweiter Lauf: Kürzel und Jahresschlusskurs sind bekannt
    await prices.run();
    expect(yahoo.findSymbol).toHaveBeenCalledTimes(2);
    expect(yahoo.closeOn).toHaveBeenCalledOnce();
  });

  it('nutzt ein selbst eingetragenes Kürzel und überspringt abgeschaltete Wertpapiere', async () => {
    depot.updateSecurity(WORLD, { priceSymbol: 'IWDA.AS' });
    depot.updateSecurity(MSFT, { onlinePrices: false });
    const yahoo = fakeYahoo();
    await updater(yahoo).run();
    expect(yahoo.findSymbol).not.toHaveBeenCalled();
    expect(yahoo.latest).toHaveBeenCalledExactlyOnceWith('IWDA.AS');
    expect(yahoo.closeOn).not.toHaveBeenCalled();
  });

  it('sammelt Probleme je Wertpapier und versucht fehlende Jahresschlusskurse nicht erneut', async () => {
    const yahoo = fakeYahoo({
      findSymbol: vi.fn(async (isin: string) => (isin === WORLD ? null : 'MSFT')),
      latest: vi.fn(async () => null),
      closeOn: vi.fn(async () => null),
    });
    const prices = updater(yahoo);
    const status = await prices.run();
    expect(status.lastUpdated).toBe(0);
    // Reihenfolge wie in der Positionsliste (nach Wert)
    expect(status.lastErrors).toEqual([
      'Microsoft Corp.: Yahoo kennt das Kürzel MSFT nicht.',
      expect.stringContaining(
        'iShs Core MSCI World U.ETF: Kein Yahoo-Kürzel zur ISIN IE00B4L5Y983',
      ),
      'Microsoft Corp.: Kein Schlusskurs zum 31.12.2025 bei Yahoo.',
    ]);
    expect(notify).not.toHaveBeenCalled();

    await prices.run();
    expect(yahoo.closeOn).toHaveBeenCalledOnce();
  });

  it('meldet Ausnahmen beim Abruf je Wertpapier', async () => {
    const boom = vi.fn(async () => {
      throw new Error('Yahoo Finance antwortet mit Status 429');
    });
    const status = await updater(fakeYahoo({ latest: boom, closeOn: boom })).run();
    expect(status.lastErrors).toEqual([
      'Microsoft Corp.: Yahoo Finance antwortet mit Status 429',
      'iShs Core MSCI World U.ETF: Yahoo Finance antwortet mit Status 429',
      'Microsoft Corp.: Yahoo Finance antwortet mit Status 429',
    ]);
    const odd = vi.fn(async () => {
      throw 'kaputt';
    });
    expect((await updater(fakeYahoo({ latest: odd, closeOn: odd })).run()).lastErrors[0]).toBe(
      'Microsoft Corp.: kaputt',
    );
  });

  it('meldet einen Fehlschlag des gesamten Abrufs', async () => {
    vi.spyOn(depot, 'overview').mockImplementation(() => {
      throw new Error('Datenbank weg');
    });
    const status = await updater(fakeYahoo()).run();
    expect(status.lastErrors).toEqual(['Abruf fehlgeschlagen: Error: Datenbank weg']);
  });

  it('tut ohne Wertpapiere mit Online-Abruf nichts', async () => {
    depot.updateSecurity(WORLD, { onlinePrices: false });
    depot.updateSecurity(MSFT, { onlinePrices: false });
    const yahoo = fakeYahoo();
    expect((await updater(yahoo).run()).lastUpdated).toBe(0);
    expect(yahoo.findSymbol).not.toHaveBeenCalled();
  });

  it('führt gleichzeitige Abrufe zusammen', async () => {
    const yahoo = fakeYahoo();
    const prices = updater(yahoo);
    const first = prices.run();
    expect(prices.status().running).toBe(true);
    const [a, b] = await Promise.all([first, prices.run()]);
    expect(a).toEqual(b);
    expect(yahoo.latest).toHaveBeenCalledTimes(2);
  });

  it('startet sofort und prüft danach minütlich, ob ein Abruf fällig ist', async () => {
    vi.useFakeTimers();
    let clock = berlin('2026-11-27', '10:00');
    const yahoo = fakeYahoo();
    const prices = new PriceUpdater(depot, yahoo as unknown as YahooClient, {
      mode: 'daily',
      intervalMinutes: 15,
      now: () => clock,
      pauseMs: 0,
      log: () => undefined,
    });
    prices.start();
    prices.start(); // zweiter Start ohne Wirkung
    await vi.advanceTimersByTimeAsync(0);
    expect(yahoo.latest).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000); // 10:01 – nicht fällig
    expect(yahoo.latest).toHaveBeenCalledTimes(2);

    clock = berlin('2026-11-27', '22:31');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(yahoo.latest).toHaveBeenCalledTimes(4);

    prices.stop();
    prices.stop();
    clock = berlin('2026-11-30', '22:31');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(yahoo.latest).toHaveBeenCalledTimes(4);
  });

  it('startet im Modus „off“ keinen Abruf, erlaubt aber den manuellen', async () => {
    const yahoo = fakeYahoo();
    const prices = updater(yahoo, 'off');
    prices.start();
    expect(yahoo.findSymbol).not.toHaveBeenCalled();
    expect((await prices.run()).mode).toBe('off');
    expect(yahoo.latest).toHaveBeenCalled();
  });

  it('protokolliert Probleme standardmäßig per console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prices = new PriceUpdater(
      depot,
      fakeYahoo({ latest: vi.fn(async () => null) }) as unknown as YahooClient,
      {
        mode: 'daily',
        intervalMinutes: 15,
        now: () => now,
      },
    );
    vi.useFakeTimers();
    const run = prices.run();
    await vi.runAllTimersAsync();
    await run;
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Online-Kurse: /));
    warn.mockRestore();
  });
});
