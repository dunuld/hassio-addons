import { describe, expect, it } from 'vitest';
import { DocumentParseError, parseDecimal, parseIngDocument } from '../src/ing-parser.js';
import {
  BUY_LINES,
  DEPOT_A,
  DEPOT_B,
  DISTRIBUTION_LINES,
  DIVIDEND_LINES,
  EUR_DIVIDEND_LINES,
  SELL_LINES,
  STATEMENT_LINES,
  tradeLines,
} from './fixtures.js';

describe('parseDecimal', () => {
  it('liest deutsche Zahlen', () => {
    expect(parseDecimal('1.234,5678')).toBe(1234.5678);
    expect(parseDecimal('3,00000')).toBe(3);
    expect(parseDecimal('42')).toBe(42);
  });
});

describe('Depotnummer', () => {
  it('liest verschiedene Schreibweisen und meldet fehlende Nummern als null', () => {
    const withHeader = (line: string) =>
      BUY_LINES.map((l) => (l.startsWith('Direkt-Depot') ? line : l));
    expect(parseIngDocument(BUY_LINES).depotNumber).toBe(DEPOT_A);
    expect(parseIngDocument(withHeader('Depotnummer 9876 543 210')).depotNumber).toBe(DEPOT_B);
    expect(parseIngDocument(withHeader('Depot-Nr.: 9876543210')).depotNumber).toBe(DEPOT_B);
    // Auf Folgeseiten fehlt die Nummer teils – dann zählt die erste Fundstelle
    expect(parseIngDocument(withHeader('Direkt-Depot Nr.:')).depotNumber).toBeNull();
  });
});

describe('Wertpapierabrechnung', () => {
  it('liest einen Kauf samt Gebühren', () => {
    expect(parseIngDocument(BUY_LINES)).toEqual({
      type: 'buy',
      depotNumber: DEPOT_A,
      isin: 'IE00B4L5Y983',
      wkn: 'A0RPWH',
      name: 'iShs Core MSCI World U.ETF',
      date: '2026-03-15',
      reference: '12345678.001',
      quantity: 3,
      price: 56.768,
      grossCents: 17030,
      feeCents: 298,
      taxCents: 0,
      totalCents: 17328,
      gainCents: null,
    });
  });

  it('liest Sparplan-Käufe mit Bruchstücken und ohne Provision', () => {
    const lines = tradeLines({
      kind: 'Kauf aus Sparplan',
      quantity: '1,23456',
      price: '81,00',
      gross: '100,00',
      fee: null,
      total: '100,00',
    });
    expect(parseIngDocument(lines)).toMatchObject({
      type: 'buy',
      quantity: 1.23456,
      price: 81,
      feeCents: 0,
      totalCents: 10000,
    });
  });

  it('berechnet den Kurs, wenn die Kurszeile fehlt', () => {
    const lines = BUY_LINES.filter((line) => !line.startsWith('Kurs EUR'));
    const doc = parseIngDocument(lines);
    expect(doc.type === 'buy' && doc.price).toBeCloseTo(56.7667, 3);
  });

  it('liest einen Verkauf mit Steuern und Veräußerungsgewinn der Bank', () => {
    expect(parseIngDocument(SELL_LINES)).toMatchObject({
      type: 'sell',
      date: '2026-06-20',
      quantity: 2,
      price: 80,
      grossCents: 16000,
      feeCents: 490,
      // „KapSt-pflichtiger Kapitalertrag“ der Steuerseite ist keine einbehaltene Steuer
      taxCents: 1055,
      totalCents: 14455,
      gainCents: 4000,
    });
  });

  it('erkennt Veräußerungsverluste', () => {
    const verlust = SELL_LINES.map((line) =>
      line.startsWith('Veräußerungsgewinn')
        ? 'Veräußerungsverlust nach Differenzmethode 12,34 EUR'
        : line,
    );
    expect(parseIngDocument(verlust)).toMatchObject({ gainCents: -1234 });
    const negativ = SELL_LINES.map((line) =>
      line.startsWith('Veräußerungsgewinn')
        ? 'Veräußerungsgewinn nach Differenzmethode -12,34 EUR'
        : line,
    );
    expect(parseIngDocument(negativ)).toMatchObject({ gainCents: -1234 });
  });

  it('behandelt eine Steuererstattung als negative Steuer', () => {
    const lines = tradeLines({
      kind: 'Verkauf',
      gross: '100,00',
      fee: '4,90',
      total: '105,10',
      quantity: '1,00',
    });
    lines.splice(
      lines.findIndex((l) => l.startsWith('Endbetrag')),
      0,
      'Steuererstattung EUR 10,00',
    );
    expect(parseIngDocument(lines)).toMatchObject({
      feeCents: 490,
      taxCents: -1000,
      gainCents: null,
    });
  });

  it('nutzt die Valuta, wenn der Ausführungstag fehlt', () => {
    const lines = BUY_LINES.filter((line) => !line.startsWith('Ausführungstag')).map((l) =>
      l.startsWith('Valuta') ? 'Valuta 17.03.2026' : l,
    );
    expect(parseIngDocument(lines)).toMatchObject({ date: '2026-03-17' });
  });

  it('meldet fehlende Pflichtfelder verständlich', () => {
    const without = (prefix: string) => BUY_LINES.filter((line) => !line.startsWith(prefix));
    expect(() => parseIngDocument(without('Kurswert'))).toThrow(/Kurswert/);
    expect(() => parseIngDocument(without('Endbetrag'))).toThrow(/Endbetrag/);
    expect(() => parseIngDocument(without('ISIN'))).toThrow(/ISIN/);
    expect(() => parseIngDocument(without('Nominale'))).toThrow(/Stückzahl/);
    const noDate = BUY_LINES.filter((l) => !/^(Ausführungstag|Valuta|Datum)/.test(l));
    expect(() => parseIngDocument(noDate)).toThrow(DocumentParseError);
  });

  it('lehnt andere Abrechnungsarten ab', () => {
    const lines = BUY_LINES.map((line) =>
      line === 'Wertpapierabrechnung Kauf' ? 'Wertpapierabrechnung Einbuchung' : line,
    );
    expect(() => parseIngDocument(lines)).toThrow(/weder Kauf noch Verkauf/);
  });

  it('nimmt die ISIN als Namen, wenn die Bezeichnung fehlt', () => {
    const lines = BUY_LINES.filter((line) => !line.startsWith('Wertpapierbezeichnung')).map((l) =>
      l.startsWith('ISIN') ? 'ISIN IE00B4L5Y983' : l,
    );
    expect(parseIngDocument(lines)).toMatchObject({ name: 'IE00B4L5Y983', wkn: null });
  });
});

describe('Ertragsabrechnung', () => {
  it('liest eine Ausschüttung ohne Steuerabzug', () => {
    expect(parseIngDocument(DISTRIBUTION_LINES)).toEqual({
      type: 'dividend',
      depotNumber: DEPOT_A,
      isin: 'DE0002635307',
      wkn: '263530',
      name: 'iShares STOXX Europe 600 UCITS ETF',
      date: '2026-03-20',
      reference: null,
      quantity: 10,
      grossCents: 400,
      taxCents: 0,
      totalCents: 400,
    });
  });

  it('liest EUR-Erträge mit deutscher Steuer', () => {
    expect(parseIngDocument(EUR_DIVIDEND_LINES)).toMatchObject({
      date: '2026-05-12',
      grossCents: 7700,
      taxCents: 2030,
      totalCents: 5670,
    });
  });

  it('rechnet Fremdwährungsdividenden in EUR', () => {
    expect(parseIngDocument(DIVIDEND_LINES)).toMatchObject({
      date: '2026-06-12',
      quantity: 20,
      grossCents: 915,
      taxCents: 137,
      totalCents: 778,
    });
  });

  it('meldet einen fehlenden Gesamtbetrag', () => {
    const lines = DIVIDEND_LINES.filter((l) => !l.startsWith('Gesamtbetrag'));
    expect(() => parseIngDocument(lines)).toThrow(/Gesamtbetrag/);
  });
});

describe('Depotauszug', () => {
  it('liest Stichtag, Depotnummer und Positionen mit Kurs und Kurswert', () => {
    expect(parseIngDocument(STATEMENT_LINES)).toEqual({
      type: 'statement',
      depotNumber: DEPOT_A,
      date: '2025-12-31',
      reference: null,
      positions: [
        {
          isin: 'IE00B4L5Y983',
          name: 'iShs Core MSCI World U.ETF',
          quantity: 10,
          price: 50,
          valueCents: 50000,
        },
        {
          isin: 'US5949181045',
          name: 'Microsoft Corp.',
          quantity: 20,
          price: 400,
          valueCents: 800000,
        },
      ],
    });
  });

  it('kommt mit fehlenden Kursen, Fremdwährung und Bruchstücken zurecht', () => {
    const doc = parseIngDocument([
      'Depotauszug per 30.06.2026',
      '5 Stück Ohne Kurs AG',
      'ISIN (WKN): DE0008404005 (840400)',
      '3 Stück Fremd Inc. 12,00 USD 33,00 EUR',
      'ISIN (WKN): US5949181045 (870747)',
      '12,34567 Stück Nur Kurswert ETF 1.234,56 EUR',
      'ISIN (WKN): LU0274208692 (DBX1MW)',
      '7 Stück Ohne ISIN',
      '0 Stück Leer',
      'ISIN (WKN): FR0000120271 (850727)',
      'Fehlen Kurse? Dann liegt uns kein offizieller Schlusskurs vor.',
    ]);
    expect(doc).toMatchObject({
      depotNumber: null,
      positions: [
        { isin: 'DE0008404005', name: 'Ohne Kurs AG', quantity: 5, price: null, valueCents: null },
        { isin: 'US5949181045', name: 'Fremd Inc.', quantity: 3, price: 11, valueCents: 3300 },
        { isin: 'LU0274208692', quantity: 12.34567, valueCents: 123456 },
      ],
    });
    expect(doc.type === 'statement' && doc.positions).toHaveLength(3);
  });

  it('meldet einen Auszug ohne Positionen oder Stichtag', () => {
    expect(() => parseIngDocument(['Depotauszug per 31.12.2025'])).toThrow(/keine Positionen/);
    expect(() => parseIngDocument(['Depotauszug'])).toThrow(/Stichtag/);
  });
});

describe('Dokumentart', () => {
  it('lehnt unbekannte Dokumente ab', () => {
    expect(() => parseIngDocument(['Kontoauszug', 'Girokonto'])).toThrow(/Unbekannte Dokumentart/);
  });
});
