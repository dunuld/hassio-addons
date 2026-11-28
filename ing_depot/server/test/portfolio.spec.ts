import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionType } from '../../shared/api-types.js';
import { computeOverview, mergeOverviews, type PortfolioInput } from '../src/portfolio.js';

const WORLD = 'IE00B4L5Y983';
const MSFT = 'US5949181045';

let nextId = 1;
function tx(
  type: TransactionType,
  date: string,
  isin: string,
  quantity: number,
  values: Partial<Transaction> = {},
): Transaction {
  const grossCents = values.grossCents ?? 0;
  const feeCents = values.feeCents ?? 0;
  const taxCents = values.taxCents ?? 0;
  const totalCents =
    values.totalCents ??
    (type === 'sell' || type === 'dividend'
      ? grossCents - feeCents - taxCents
      : grossCents + feeCents);
  return {
    id: nextId++,
    documentId: null,
    depotId: 1,
    type,
    date,
    isin,
    name: isin,
    quantity,
    price: 0,
    grossCents,
    feeCents,
    taxCents,
    totalCents,
    gainCents: values.gainCents ?? null,
  };
}

function input(overrides: Partial<PortfolioInput>): PortfolioInput {
  return {
    year: 2026,
    today: '2026-07-01',
    transactions: [],
    prices: [],
    securities: [
      { isin: WORLD, name: 'MSCI World', priceEntity: null },
      { isin: MSFT, name: 'Microsoft', priceEntity: 'sensor.msft' },
    ],
    statement: [],
    exemptionCents: 100000,
    ...overrides,
  };
}

describe('computeOverview', () => {
  it('liefert für ein leeres Depot Nullwerte und das aktuelle Jahr', () => {
    const overview = computeOverview(input({}));
    expect(overview).toMatchObject({
      year: 2026,
      depotId: null,
      periodStart: '2026-01-01',
      years: [2026],
      asOf: '2026-07-01',
      investedGrossCents: 0,
      valueCents: 0,
      gainPct: null,
      ytdGainPct: null,
      positions: [],
      warnings: [],
    });
    expect(overview.monthly).toHaveLength(12);
  });

  it('berechnet Investition, FIFO-Gewinn, Dividenden und Kursgewinne', () => {
    const overview = computeOverview(
      input({
        transactions: [
          // Vorjahr: 10 Stück zu 50 € + 5 € Gebühr
          tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000, feeCents: 500 }),
          // dieses Jahr: 10 Stück zu 60 € + 5 € Gebühr
          tx('buy', '2026-02-10', WORLD, 10, { grossCents: 60000, feeCents: 500 }),
          // Verkauf 15 Stück zu 70 € − 10 € Gebühr, 30 € Steuer
          tx('sell', '2026-05-05', WORLD, 15, {
            grossCents: 105000,
            feeCents: 1000,
            taxCents: 3000,
          }),
          tx('dividend', '2026-06-12', MSFT, 20, { grossCents: 1000, taxCents: 250 }),
          tx('opening', '2020-01-01', MSFT, 20, { totalCents: 400000 }),
        ],
        prices: [
          { isin: WORLD, date: '2025-12-30', price: 55, source: 'document' },
          { isin: WORLD, date: '2026-06-30', price: 72, source: 'document' },
          { isin: WORLD, date: '2026-06-30', price: 80, source: 'manual' },
          { isin: WORLD, date: '2026-12-01', price: 999, source: 'manual' },
          { isin: MSFT, date: '2025-12-31', price: 300, source: 'document' },
          { isin: MSFT, date: '2026-06-01', price: 330, source: 'ha' },
        ],
      }),
    );

    // Käufe im Jahr: 605 €; Verkaufserlös nach Gebühren: 1.040 €
    expect(overview.investedGrossCents).toBe(60500);
    expect(overview.investedNetCents).toBe(60500 - 104000);
    expect(overview.feesCents).toBe(1500);
    // FIFO: 10 × 50,50 + 5 × 60,50 = 807,50 € Einstand → 1.040 − 807,50 = 232,50 €
    expect(overview.realizedCents).toBe(23250);
    expect(overview.dividendsGrossCents).toBe(1000);
    expect(overview.dividendsNetCents).toBe(750);
    expect(overview.taxesCents).toBe(3250);
    expect(overview.exemptionUsedCents).toBe(24250);
    expect(overview.years).toEqual([2026, 2025, 2020]);

    const [msft, world] = overview.positions;
    expect(world).toMatchObject({
      quantity: 5,
      costCents: 30250,
      price: 80, // manueller Kurs schlägt den Dokumentkurs desselben Tages
      priceSource: 'manual',
      valueCents: 40000,
      gainCents: 9750,
      gainPct: 32.23,
      // 400 + 1.040 − (10 × 55 + 605) = 285 €
      ytdGainCents: 28500,
      realizedCents: 23250,
    });
    expect(msft).toMatchObject({
      quantity: 20,
      priceEntity: 'sensor.msft',
      priceSource: 'ha',
      valueCents: 660000,
      gainCents: 260000,
      gainPct: 65,
      ytdGainCents: 60000,
      ytdGainPct: 10,
      dividendsNetCents: 750,
    });
    expect(overview.valueCents).toBe(700000);
    expect(overview.gainCents).toBe(269750);
    expect(overview.ytdGainCents).toBe(88500);
    expect(overview.monthly[1]).toMatchObject({ month: 2, investedCents: 60500 });
    expect(overview.monthly[4]!.realizedCents).toBe(23250);
    expect(overview.monthly[5]!.dividendsNetCents).toBe(750);
    expect(overview.warnings).toEqual([]);
  });

  it('bewertet vergangene Jahre zum 31.12. und ignoriert spätere Buchungen', () => {
    const overview = computeOverview(
      input({
        year: 2025,
        transactions: [
          tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000 }),
          tx('buy', '2026-02-10', WORLD, 10, { grossCents: 60000 }),
        ],
        prices: [
          { isin: WORLD, date: '2025-12-30', price: 55, source: 'document' },
          { isin: WORLD, date: '2026-06-30', price: 72, source: 'document' },
        ],
      }),
    );
    expect(overview.asOf).toBe('2025-12-31');
    expect(overview.investedGrossCents).toBe(50000);
    expect(overview.positions[0]).toMatchObject({
      quantity: 10,
      valueCents: 55000,
      ytdGainCents: 5000,
    });
  });

  it('warnt bei fehlenden Kursen und rechnet ersatzweise mit dem Einstandswert', () => {
    const overview = computeOverview(
      input({ transactions: [tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000 })] }),
    );
    expect(overview.positions[0]).toMatchObject({
      price: null,
      valueCents: 50000,
      gainCents: 0,
      ytdGainCents: 0,
    });
    expect(overview.warnings).toEqual([
      expect.stringContaining('kein Kurs bekannt'),
      expect.stringContaining('fehlt ein Kurs zum 31.12.2025'),
    ]);
  });

  it('warnt bei Verkäufen ohne bekannten Kauf und zählt nur den gedeckten Teil', () => {
    const overview = computeOverview(
      input({
        transactions: [
          tx('buy', '2026-01-10', WORLD, 4, { grossCents: 40000 }),
          tx('sell', '2026-03-01', WORLD, 10, { grossCents: 150000 }),
        ],
      }),
    );
    // 4 von 10 Stück gedeckt: 600 € Erlös − 400 € Einstand
    expect(overview.realizedCents).toBe(20000);
    expect(overview.positions[0]).toMatchObject({ quantity: 0, valueCents: 0, costCents: 0 });
    expect(overview.warnings[0]).toMatch(/am 01\.03\.2026: Für 6 Stück fehlt der Kauf/);
  });

  it('blendet vollständig verkaufte Positionen aus Vorjahren aus', () => {
    const overview = computeOverview(
      input({
        transactions: [
          tx('buy', '2024-01-10', WORLD, 4, { grossCents: 40000 }),
          tx('sell', '2025-03-01', WORLD, 4, { grossCents: 50000 }),
        ],
      }),
    );
    expect(overview.positions).toEqual([]);
    expect(overview.realizedCents).toBe(0);
  });

  it('vergleicht den Bestand mit dem jüngsten Depotauszug', () => {
    const transactions = [
      tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000 }),
      tx('sell', '2025-06-01', WORLD, 2, { grossCents: 12000 }),
      tx('dividend', '2025-07-01', WORLD, 8, { grossCents: 100 }),
    ];
    const prices = [{ isin: WORLD, date: '2025-12-31', price: 55, source: 'document' as const }];
    const check = (statement: PortfolioInput['statement']) =>
      computeOverview(input({ transactions, prices, statement })).warnings;

    expect(check([{ date: '2025-12-31', isin: WORLD, quantity: 8 }])).toEqual([]);
    expect(check([{ date: '2027-12-31', isin: WORLD, quantity: 99 }])).toEqual([]);
    expect(check([{ date: '2025-12-31', isin: MSFT, quantity: 20 }])).toEqual([
      'Depotauszug vom 31.12.2025: Der Bestand passt bei einem Wertpapier nicht zu den ' +
        'Abrechnungen – 20 Stück Microsoft (aus den Abrechnungen: 0). Es fehlen Abrechnungen ' +
        'oder ein Startbestand. Alternativ unter „Depots“ einen Depotauszug als Startpunkt wählen.',
    ]);
    // Viele Abweichungen werden zu einem Hinweis zusammengefasst
    const many = [1, 2, 3, 4, 5].map((i) => ({
      date: '2025-12-31',
      isin: `TEST${i}`,
      quantity: 1,
    }));
    const [summary, ...rest] = check(many);
    expect(rest).toEqual([]);
    expect(summary).toContain('bei 5 Wertpapieren');
    expect(summary).toContain('und 2 weitere');
  });

  it('rechnet ungedeckte Verkäufe nicht in den Kursgewinn seit Jahresbeginn', () => {
    const overview = computeOverview(
      input({
        transactions: [
          tx('sell', '2026-06-16', WORLD, 10, { grossCents: 150000, gainCents: 25000 }),
        ],
      }),
    );
    expect(overview.positions[0]).toMatchObject({ ytdGainCents: 0, realizedCents: 25000 });
    expect(overview.ytdGainCents).toBe(0);
    expect(overview.investedNetCents).toBe(-150000);
  });

  it('übernimmt den Veräußerungsgewinn der Bank statt FIFO und warnt dann nicht', () => {
    const overview = computeOverview(
      input({
        transactions: [
          // Kauf fehlt – die Bank kennt ihn aber
          tx('sell', '2026-06-16', WORLD, 10, {
            grossCents: 150000,
            feeCents: 990,
            gainCents: 25000,
          }),
        ],
      }),
    );
    expect(overview.realizedCents).toBe(25000);
    expect(overview.warnings).toEqual([]);
  });

  it('prüft nur den jüngsten Depotauszug bis zum Stichtag', () => {
    const transactions = [tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000 })];
    const prices = [{ isin: WORLD, date: '2025-12-31', price: 55, source: 'document' as const }];
    const warnings = computeOverview(
      input({
        transactions,
        prices,
        statement: [
          { date: '2025-06-30', isin: WORLD, quantity: 99 }, // älter – wird nicht geprüft
          { date: '2025-12-31', isin: WORLD, quantity: 10 },
        ],
      }),
    ).warnings;
    expect(warnings).toEqual([]);
  });
});

describe('Startpunkt (Depotauszug)', () => {
  const start = {
    date: '2025-12-31',
    positions: [
      { isin: WORLD, quantity: 10, costCents: 55000 },
      { isin: MSFT, quantity: 0, costCents: 0 },
    ],
  };

  it('beginnt mit den Beständen des Auszugs und ignoriert ältere Buchungen', () => {
    const overview = computeOverview(
      input({
        start,
        transactions: [
          // bereits im Auszug enthalten bzw. vor dem Stichtag
          tx('buy', '2024-03-01', WORLD, 10, { grossCents: 30000 }),
          tx('opening', '2020-01-01', MSFT, 5, { totalCents: 1000 }),
          tx('buy', '2026-02-10', WORLD, 10, { grossCents: 60000 }),
          tx('sell', '2026-05-05', WORLD, 15, { grossCents: 105000 }),
        ],
        prices: [
          { isin: WORLD, date: '2025-12-31', price: 55, source: 'document' },
          { isin: WORLD, date: '2026-06-30', price: 80, source: 'document' },
        ],
        statement: [
          { date: '2025-12-31', isin: WORLD, quantity: 10 },
          { date: '2026-06-30', isin: WORLD, quantity: 5 },
        ],
      }),
    );
    expect(overview.years).toEqual([2026, 2025]);
    expect(overview.periodStart).toBe('2026-01-01');
    expect(overview.startDate).toBe('2025-12-31');
    // FIFO ab Startpunkt: 10 × 55 + 5 × 60 = 850 € Einstand für 15 Stück
    expect(overview.realizedCents).toBe(105000 - 85000);
    expect(overview.positions).toHaveLength(1);
    expect(overview.positions[0]).toMatchObject({
      quantity: 5,
      costCents: 30000,
      valueCents: 40000,
    });
    expect(overview.warnings).toEqual([]);
  });

  it('wertet ein Jahr mit Startpunkt ab dessen Stichtag aus', () => {
    const midYear = {
      date: '2026-03-31',
      positions: [{ isin: WORLD, quantity: 10, costCents: 50000 }],
    };
    const overview = computeOverview(
      input({
        start: midYear,
        transactions: [
          tx('buy', '2026-02-01', WORLD, 3, { grossCents: 15000 }), // vor dem Startpunkt
          tx('buy', '2026-05-15', WORLD, 2, { grossCents: 12000 }),
        ],
        prices: [{ isin: WORLD, date: '2026-06-30', price: 70, source: 'document' }],
      }),
    );
    expect(overview.periodStart).toBe('2026-03-31');
    expect(overview.investedGrossCents).toBe(12000);
    // 12 × 70 = 840 € − (500 € Startwert + 120 € Kauf)
    expect(overview.ytdGainCents).toBe(22000);
    expect(overview.positions[0]).toMatchObject({ ytdBaseCents: 62000, costCents: 62000 });
    // Kein Hinweis auf fehlenden Kurs zum 31.12. des Vorjahres
    expect(overview.warnings).toEqual([]);
  });

  it('springt bei Jahren vor dem Startpunkt auf dessen Jahr und warnt bei fehlendem Kurswert', () => {
    const overview = computeOverview(
      input({
        year: 2020,
        start: { date: '2026-03-31', positions: [{ isin: WORLD, quantity: 10, costCents: 0 }] },
      }),
    );
    expect(overview.year).toBe(2026);
    expect(overview.years).toEqual([2026]);
    expect(overview.warnings[0]).toContain('Startpunkt 31.03.2026: Für MSCI World enthält');
  });
});

describe('mergeOverviews', () => {
  const base = { year: 2026, today: '2026-07-01', exemptionCents: 100000 };

  it('liefert ohne Depots eine leere Übersicht und reicht ein einzelnes Depot durch', () => {
    expect(mergeOverviews([], base)).toMatchObject({ depotId: null, positions: [], valueCents: 0 });
    const single = computeOverview(input({ depotId: 7 }));
    expect(mergeOverviews([{ name: 'A', overview: single }], base).depotId).toBeNull();
  });

  it('addiert Kennzahlen und Positionen mehrerer Depots', () => {
    const a = computeOverview(
      input({
        depotId: 1,
        transactions: [
          tx('buy', '2026-02-10', WORLD, 10, { grossCents: 50000 }),
          tx('dividend', '2026-06-12', MSFT, 0, { grossCents: 1000, taxCents: 250 }),
        ],
        prices: [{ isin: WORLD, date: '2026-06-30', price: 60, source: 'document' }],
      }),
    );
    const b = computeOverview(
      input({
        depotId: 2,
        transactions: [
          tx('opening', '2026-01-05', WORLD, 5, { totalCents: 30000 }),
          tx('sell', '2026-03-01', MSFT, 1, { grossCents: 1000 }),
        ],
        prices: [{ isin: WORLD, date: '2026-06-30', price: 60, source: 'document' }],
      }),
    );
    const merged = mergeOverviews(
      [
        { name: 'Depot A', overview: a },
        { name: 'Depot B', overview: b },
      ],
      base,
    );
    expect(merged).toMatchObject({
      depotId: null,
      startDate: null,
      investedGrossCents: 80000,
      dividendsNetCents: 750,
      valueCents: 90000,
      costCents: 80000,
      gainCents: 10000,
      gainPct: 12.5,
    });
    const world = merged.positions.find((p) => p.isin === WORLD)!;
    expect(world).toMatchObject({
      quantity: 15,
      valueCents: 90000,
      ytdGainCents: 10000,
      ytdGainPct: 12.5,
    });
    expect(merged.monthly[1]!.investedCents).toBe(50000);
    expect(merged.warnings).toEqual([
      expect.stringMatching(/^Depot B: Verkauf von Microsoft am 01\.03\.2026/),
    ]);
  });

  it('übernimmt den Kurs eines anderen Depots, wenn einem keiner bekannt ist', () => {
    const withPrice = computeOverview(
      input({
        transactions: [tx('buy', '2026-02-10', WORLD, 1, { grossCents: 5000 })],
        prices: [{ isin: WORLD, date: '2026-06-30', price: 60, source: 'document' }],
      }),
    );
    const withoutPrice = computeOverview(
      input({ transactions: [tx('buy', '2026-02-10', WORLD, 1, { grossCents: 5000 })] }),
    );
    const merged = mergeOverviews(
      [
        { name: 'B', overview: withoutPrice },
        { name: 'A', overview: withPrice },
      ],
      base,
    );
    expect(merged.positions[0]).toMatchObject({ quantity: 2, price: 60, priceSource: 'document' });
  });
});

describe('Umtausch und Vorabpauschale', () => {
  const NEW = 'LU0392494562';

  it('behandelt einen Umtausch als Verkauf und Kauf ohne Geldfluss', () => {
    const overview = computeOverview(
      input({
        securities: [
          { isin: WORLD, name: 'Alter ETF', priceEntity: null },
          { isin: NEW, name: 'Neuer ETF', priceEntity: null },
        ],
        transactions: [
          tx('buy', '2025-03-01', WORLD, 10, { grossCents: 46000 }),
          tx('exchange_out', '2026-02-20', WORLD, 10, {
            grossCents: 50000,
            taxCents: 0,
            totalCents: 0,
            gainCents: 4000,
          }),
          tx('exchange_in', '2026-02-20', NEW, 10, { grossCents: 50000, totalCents: 50000 }),
        ],
        prices: [
          { isin: WORLD, date: '2025-12-31', price: 48, source: 'document' },
          { isin: NEW, date: '2026-06-30', price: 55, source: 'document' },
        ],
      }),
    );
    // Kein Geld geflossen: weder investiert noch Verkaufserlös
    expect(overview).toMatchObject({
      investedGrossCents: 0,
      investedNetCents: 0,
      realizedCents: 4000,
      monthly: expect.arrayContaining([
        { month: 2, investedCents: 0, dividendsNetCents: 0, realizedCents: 4000 },
      ]),
    });
    const [neu, alt] = overview.positions;
    // Einstand des neuen Wertpapiers = Kurswert beim Umtausch
    expect(neu).toMatchObject({ isin: NEW, quantity: 10, costCents: 50000, valueCents: 55000 });
    expect(neu!.gainCents).toBe(5000);
    expect(alt).toMatchObject({ isin: WORLD, quantity: 0, realizedCents: 4000 });
    // Kursgewinn seit 01.01.: 480 € → 500 € (alt) und 500 € → 550 € (neu)
    expect(overview.ytdGainCents).toBe(2000 + 5000);
    expect(overview.warnings).toEqual([]);
  });

  it('warnt bei einem Umtausch ohne bekannten Bestand und bei unbekannter ISIN', () => {
    const overview = computeOverview(
      input({
        securities: [{ isin: 'WKN:NEU001', name: 'WKN NEU001', priceEntity: null }],
        transactions: [
          tx('exchange_out', '2026-02-20', WORLD, 10, { grossCents: 50000, totalCents: 0 }),
          tx('exchange_in', '2026-02-20', 'WKN:NEU001', 10, { totalCents: 50000 }),
        ],
        prices: [{ isin: 'WKN:NEU001', date: '2026-02-20', price: 50, source: 'document' }],
      }),
    );
    expect(overview.warnings).toEqual([
      expect.stringMatching(/^Umtausch von IE00B4L5Y983 am 20\.02\.2026: Für 10 Stück fehlt/),
      expect.stringContaining('Umtausch in WKN NEU001: Die ISIN ist noch unbekannt'),
    ]);
  });

  it('zählt Vorabpauschalen zu Steuern und Freistellungsauftrag, nicht zu Dividenden', () => {
    const overview = computeOverview(
      input({
        transactions: [
          tx('buy', '2025-03-01', WORLD, 10, { grossCents: 50000 }),
          tx('advance_lump_sum', '2026-01-02', WORLD, 10, { grossCents: 1000, taxCents: 263 }),
          tx('advance_lump_sum', '2025-01-02', WORLD, 10, { grossCents: 500, taxCents: 0 }),
        ],
        prices: [{ isin: WORLD, date: '2025-12-31', price: 50, source: 'document' }],
      }),
    );
    expect(overview).toMatchObject({
      advanceLumpSumCents: 1000,
      taxesCents: 263,
      dividendsGrossCents: 0,
      dividendsNetCents: 0,
      exemptionUsedCents: 1000,
    });
    expect(overview.positions[0]).toMatchObject({ quantity: 10, dividendsNetCents: 0 });
  });
});
