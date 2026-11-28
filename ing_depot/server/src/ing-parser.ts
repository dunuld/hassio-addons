/**
 * Liest ING-Depotdokumente aus den Textzeilen eines PDFs:
 * Wertpapierabrechnung (Kauf/Verkauf), Ertragsabrechnung (Dividende, Ausschüttung, Zinsen)
 * und Depotauszug. Ausgewertet werden beschriftete Zeilen („Kurswert EUR 170,30“), nicht
 * Spaltenpositionen – so bleibt der Parser gegenüber kleinen Layoutänderungen robust.
 */

export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

interface ParsedBase {
  /** Depotnummer ohne Leerzeichen; `null`, wenn sie im Dokument fehlt */
  depotNumber: string | null;
}

interface ParsedSecurity extends ParsedBase {
  isin: string;
  wkn: string | null;
  name: string;
}

export interface ParsedTrade extends ParsedSecurity {
  type: 'buy' | 'sell';
  date: string;
  reference: string | null;
  quantity: number;
  price: number;
  grossCents: number;
  feeCents: number;
  taxCents: number;
  totalCents: number;
  /** Veräußerungsgewinn bzw. -verlust laut Bank (nur Verkauf, falls ausgewiesen) */
  gainCents: number | null;
}

export interface ParsedDividend extends ParsedSecurity {
  type: 'dividend';
  date: string;
  reference: null;
  quantity: number;
  grossCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Steuerrelevanter Umtausch (z. B. Fondsverschmelzung): Abgang des alten Wertpapiers zum Kurswert,
 * Zugang des neuen zum selben Wert – ohne Geldfluss, abgesehen von einbehaltenen Steuern.
 */
export interface ParsedExchange extends ParsedSecurity {
  type: 'exchange';
  date: string;
  reference: string | null;
  quantity: number;
  price: number;
  /** Kurswert des Umtauschs = Veräußerungserlös des alten und Einstand des neuen Wertpapiers */
  grossCents: number;
  /** Einbehaltene Steuern (Endbetrag zu Ihren Lasten) */
  taxCents: number;
  /** Veräußerungsgewinn bzw. -verlust laut Bank */
  gainCents: number | null;
  /** Neues Wertpapier – im Dokument oft nur mit WKN genannt */
  target: { isin: string | null; wkn: string | null };
  targetQuantity: number;
}

/** Vorabpauschale thesaurierender Fonds: steuerpflichtiger Ertrag ohne Auszahlung. */
export interface ParsedAdvanceLumpSum extends ParsedSecurity {
  type: 'advance_lump_sum';
  date: string;
  reference: null;
  quantity: number;
  /** Höhe der Vorabpauschale */
  grossCents: number;
  /** Darauf einbehaltene Steuern */
  taxCents: number;
}

export interface ParsedStatementPosition {
  isin: string;
  /** WKN, falls im Auszug angegeben */
  wkn: string | null;
  name: string;
  quantity: number;
  /** Kurs in EUR; `null`, wenn er sich nicht sicher bestimmen ließ */
  price: number | null;
  /** Kurswert in Cent (nur zusammen mit `price`) */
  valueCents: number | null;
}

export interface ParsedStatement extends ParsedBase {
  type: 'statement';
  date: string;
  reference: null;
  positions: ParsedStatementPosition[];
}

export type ParsedDocument =
  ParsedTrade | ParsedDividend | ParsedStatement | ParsedExchange | ParsedAdvanceLumpSum;

const NUMBER = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?`;
const NUMBER_RE = new RegExp(NUMBER, 'g');
const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`;
const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
// Nur einbehaltene Steuern – nicht „KapSt-pflichtiger Kapitalertrag“ o. Ä. der Steuerseite
const TAX_LINE = /^(Kapitalertrags?teuer|Solidaritätszuschlag|Kirchensteuer)\b/i;
const FEE_LINE =
  /^(Provision|Handelsplatz|Handelsentgelt|Courtage|Fremde Spesen|Variable Börsenspesen)/i;

/** `1.234,5678` → `1234.5678` */
export function parseDecimal(text: string): number {
  return Number(text.replaceAll('.', '').replace(',', '.'));
}

const toCents = (value: number): number => Math.round(value * 100);

function isoDate(match: RegExpExecArray | null): string | null {
  if (!match) return null;
  const [, dd, mm, yyyy] = match.slice(-4);
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** Letzte Zahl einer Zeile – bei beschrifteten Zeilen steht der Betrag rechts. */
function lastNumber(line: string | undefined): number | null {
  const last = line?.match(NUMBER_RE)?.at(-1);
  return last === undefined ? null : parseDecimal(last);
}

class Lines {
  constructor(readonly lines: string[]) {}

  find(pattern: RegExp): string | undefined {
    return this.lines.find((line) => pattern.test(line));
  }

  filter(pattern: RegExp): string[] {
    return this.lines.filter((line) => pattern.test(line));
  }

  /** Betrag in Cent aus der ersten passenden Zeile. */
  cents(pattern: RegExp): number | null {
    const value = lastNumber(this.find(pattern));
    return value === null ? null : toCents(value);
  }

  sumCents(pattern: RegExp): number {
    return this.filter(pattern).reduce((sum, line) => sum + toCents(lastNumber(line) ?? 0), 0);
  }

  date(...patterns: RegExp[]): string | null {
    for (const pattern of patterns) {
      for (const line of this.lines) {
        const date = isoDate(pattern.exec(line));
        if (date) return date;
      }
    }
    return null;
  }
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new DocumentParseError(`Das Feld „${field}“ wurde im Dokument nicht gefunden.`);
  }
  return value;
}

/** `Depotnummer 1234 567 890` / `Depot-Nr.: 1234567890` → `1234567890` */
function parseDepotNumber(doc: Lines): string | null {
  for (const line of doc.lines) {
    const match = /\bDepot\s*(?:nummer|-?\s*Nr\.?)\s*:?\s*(\d[\d ]{3,}\d)\b/i.exec(line);
    if (match) return match[1]!.replaceAll(' ', '');
  }
  return null;
}

function parseSecurity(doc: Lines): ParsedSecurity {
  const isinLine = required(
    doc.lines.find((line) => /ISIN/.test(line) && ISIN_RE.test(line)),
    'ISIN',
  );
  const isin = ISIN_RE.exec(isinLine)![1]!;
  const wkn = /\(([A-Z0-9]{6})\)/.exec(isinLine.slice(isinLine.indexOf(isin)))?.[1] ?? null;
  const name = /^Wertpapierbezeichnung\s+(.+)/.exec(doc.find(/^Wertpapierbezeichnung\s+\S/) ?? '');
  return { depotNumber: parseDepotNumber(doc), isin, wkn, name: name?.[1]?.trim() ?? isin };
}

function parseQuantity(doc: Lines): number {
  const match = doc.find(/^Nominale\b/)?.match(NUMBER_RE)?.[0];
  const quantity = match === undefined ? null : parseDecimal(match);
  if (!quantity || quantity <= 0) throw new DocumentParseError('Stückzahl („Nominale“) fehlt.');
  return quantity;
}

function parseTrade(doc: Lines, type: 'buy' | 'sell'): ParsedTrade {
  const security = parseSecurity(doc);
  const quantity = parseQuantity(doc);
  const grossCents = required(doc.cents(/^Kurswert\b/), 'Kurswert');
  const totalCents = required(doc.cents(/^Endbetrag\b/), 'Endbetrag');
  const date = required(
    doc.date(
      new RegExp(String.raw`Ausführungstag\D*${DATE}`),
      new RegExp(String.raw`^Datum\s+${DATE}`),
      new RegExp(String.raw`Valuta\D*${DATE}`),
    ),
    'Ausführungstag',
  );

  let feeCents: number;
  let taxCents = 0;
  if (type === 'buy') {
    feeCents = totalCents - grossCents;
  } else {
    taxCents = doc.sumCents(TAX_LINE);
    feeCents = grossCents - taxCents - totalCents;
    if (feeCents < 0) {
      // z. B. Steuererstattung: Gebühren aus den Einzelzeilen, Steuern als Rest
      feeCents = doc.sumCents(FEE_LINE);
      taxCents = grossCents - feeCents - totalCents;
    }
  }

  const gainCents = type === 'sell' ? parseReportedGain(doc) : null;

  const priceLine = doc.find(/^Kurs\s+EUR\b/);
  return {
    type,
    ...security,
    date,
    reference: /Ordernummer\s+([\d.]+)/.exec(doc.find(/Ordernummer/) ?? '')?.[1] ?? null,
    quantity,
    price: lastNumber(priceLine) ?? grossCents / 100 / quantity,
    grossCents,
    feeCents,
    taxCents,
    totalCents,
    gainCents,
  };
}

/** Steuerseite: „Veräußerungsgewinn nach Differenzmethode 123,45 EUR“; `null`, wenn sie fehlt. */
function parseReportedGain(doc: Lines): number | null {
  const gainLine = doc.find(/^Veräußerungs(gewinn|verlust)\b/i);
  if (!gainLine) return null;
  const value = toCents(lastNumber(gainLine) ?? 0);
  const negative =
    /verlust/i.test(gainLine) || new RegExp(String.raw`-\s*(${NUMBER})\s*(EUR)?$`).test(gainLine);
  return negative ? -value : value;
}

function parseTradeDate(doc: Lines, field: string): string {
  return required(
    doc.date(
      new RegExp(String.raw`Ausführungstag\D*${DATE}`),
      new RegExp(String.raw`Valuta\D*${DATE}`),
      new RegExp(String.raw`^Datum:?\s+${DATE}`),
    ),
    field,
  );
}

/**
 * „Wertpapierabrechnung zum steuerrelevanten Umtausch“: Das neue Wertpapier steht nur im
 * Hinweistext, etwa „Ihre Anteile wurden im Verhältnis 1:1 in die WKN NEU001 umgetauscht.“
 */
function parseExchange(doc: Lines): ParsedExchange {
  const security = parseSecurity(doc);
  const quantity = parseQuantity(doc);
  const grossCents = required(doc.cents(/^Kurswert\b/), 'Kurswert');
  const text = doc.lines.join(' ');
  const target = new RegExp(
    String.raw`in (?:die|das|den) (?:(?:WKN|Wertpapier-?Kenn-?Nummer)\s+([A-Z0-9]{6})|ISIN\s+([A-Z]{2}[A-Z0-9]{9}\d))`,
    'i',
  ).exec(text);
  if (!target) {
    throw new DocumentParseError(
      'Umtausch erkannt, aber das neue Wertpapier (WKN oder ISIN) fehlt im Dokument.',
    );
  }
  const ratio = new RegExp(String.raw`Verhältnis\s+(${NUMBER})\s*:\s*(${NUMBER})`, 'i').exec(text);
  const factor = ratio ? parseDecimal(ratio[2]!) / parseDecimal(ratio[1]!) : 1;
  const taxCents = doc.sumCents(TAX_LINE) || (doc.cents(/^Endbetrag zu Ihren Lasten\b/) ?? 0);
  return {
    type: 'exchange',
    ...security,
    date: parseTradeDate(doc, 'Ausführungstag'),
    reference: /Ordernummer\s+([\d.]+)/.exec(doc.find(/Ordernummer/) ?? '')?.[1] ?? null,
    quantity,
    price: lastNumber(doc.find(/^Kurs\s+EUR\b/)) ?? grossCents / 100 / quantity,
    grossCents,
    taxCents,
    gainCents: parseReportedGain(doc),
    target: { wkn: target[1]?.toUpperCase() ?? null, isin: target[2]?.toUpperCase() ?? null },
    targetQuantity: Math.round(quantity * factor * 1e6) / 1e6,
  };
}

/** Vorabpauschale: Betrag und darauf einbehaltene Steuern (oft 0,00 €). */
function parseAdvanceLumpSum(doc: Lines): ParsedAdvanceLumpSum {
  const security = parseSecurity(doc);
  const grossCents = required(
    doc.cents(/^Vorabpauschale\b.*\d/) ?? doc.cents(/^Vorabpauschale\s+EUR\b/),
    'Vorabpauschale',
  );
  const charged = doc.cents(/^Gesamtbetrag zu Ihren Lasten\b/);
  return {
    type: 'advance_lump_sum',
    ...security,
    date: required(
      doc.date(
        new RegExp(String.raw`^Zahltag\s+${DATE}`),
        new RegExp(String.raw`^Ex-Tag\s+${DATE}`),
        new RegExp(String.raw`Valuta\D*${DATE}`),
      ),
      'Zahltag',
    ),
    reference: null,
    quantity: parseQuantity(doc),
    grossCents,
    taxCents: doc.sumCents(TAX_LINE) || (charged ?? 0),
  };
}

function parseDividend(doc: Lines): ParsedDividend {
  const security = parseSecurity(doc);
  // Fremdwährung: der in EUR umgerechnete Bruttobetrag steht in einer eigenen Zeile
  const grossCents = required(
    doc.cents(/^Umg\. z\. Dev\.-Kurs/) ?? doc.cents(/^Brutto\s+EUR\b/) ?? doc.cents(/^Brutto\b/),
    'Brutto',
  );
  const totalCents = required(doc.cents(/^Gesamtbetrag zu Ihren Gunsten/), 'Gesamtbetrag');
  const date = required(
    doc.date(
      new RegExp(String.raw`^Zahltag\s+${DATE}`),
      new RegExp(String.raw`Valuta\D*${DATE}`),
      new RegExp(String.raw`^Datum\s+${DATE}`),
    ),
    'Zahltag',
  );
  return {
    type: 'dividend',
    ...security,
    date,
    reference: null,
    quantity: parseQuantity(doc),
    grossCents,
    taxCents: grossCents - totalCents,
    totalCents,
  };
}

/** Positionszeile im Depotauszug: „10 Stück iShs Core MSCI World U.ETF 50,00 EUR 500,00 EUR“ */
const POSITION_RE = new RegExp(String.raw`^(${NUMBER}) (?:Stück|St\.) (.+)$`);
const PRICE_VALUE_RE = new RegExp(String.raw` (${NUMBER}) ([A-Z]{3}) (${NUMBER}) EUR$`);
const VALUE_RE = new RegExp(String.raw` (${NUMBER}) EUR$`);

/**
 * Depotauszug: jede Position beginnt mit einer Zeile „Stück, Bezeichnung, Kurs, Kurswert“;
 * die ISIN steht in einer der folgenden Zeilen („ISIN (WKN): IE00B4L5Y983 (A0RPWH)“).
 */
function parseStatement(doc: Lines): ParsedStatement {
  const date = required(
    doc.date(new RegExp(String.raw`\b(?:per|zum|vom)\s+${DATE}`), new RegExp(DATE)),
    'Stichtag',
  );
  const positions = new Map<string, ParsedStatementPosition>();
  let current: Omit<ParsedStatementPosition, 'isin' | 'wkn'> | null = null;

  for (const line of doc.lines) {
    const position = POSITION_RE.exec(line);
    if (position) {
      const quantity = parseDecimal(position[1]!);
      let rest = position[2]!;
      let price: number | null = null;
      let valueCents: number | null = null;
      const priced = PRICE_VALUE_RE.exec(rest);
      const valued = priced ? null : VALUE_RE.exec(rest);
      if (priced) {
        valueCents = toCents(parseDecimal(priced[3]!));
        // Kurs in Fremdwährung: EUR-Kurs aus dem Kurswert ableiten
        price = priced[2] === 'EUR' ? parseDecimal(priced[1]!) : valueCents / 100 / quantity;
        rest = rest.slice(0, priced.index);
      } else if (valued) {
        valueCents = toCents(parseDecimal(valued[1]!));
        price = valueCents / 100 / quantity;
        rest = rest.slice(0, valued.index);
      }
      current = quantity > 0 ? { name: rest.trim(), quantity, price, valueCents } : null;
      continue;
    }
    const isin = ISIN_RE.exec(line)?.[1];
    if (isin && current) {
      const wkn = /\(([A-Z0-9]{6})\)/.exec(line.slice(line.indexOf(isin)))?.[1] ?? null;
      if (!positions.has(isin))
        positions.set(isin, { isin, wkn, ...current, name: current.name || isin });
      current = null;
    }
  }

  if (positions.size === 0) {
    throw new DocumentParseError('Im Depotauszug wurden keine Positionen gefunden.');
  }
  return {
    type: 'statement',
    depotNumber: parseDepotNumber(doc),
    date,
    reference: null,
    positions: [...positions.values()],
  };
}

/** Erkennt die Dokumentart und liest das Dokument aus. */
export function parseIngDocument(rawLines: string[]): ParsedDocument {
  const doc = new Lines(rawLines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean));
  const text = doc.lines.join('\n');

  if (/Wertpapierabrechnung/i.test(text)) {
    if (/Wertpapierabrechnung\s+(?:zum\s+)?(?:steuerrelevanten\s+)?Umtausch/i.test(text)) {
      return parseExchange(doc);
    }
    const kind =
      /Wertpapierabrechnung\s+(Kauf|Verkauf)/i.exec(text) ?? /^(Kauf|Verkauf)\b/im.exec(text);
    if (kind) return parseTrade(doc, kind[1]!.toLowerCase() === 'kauf' ? 'buy' : 'sell');
    throw new DocumentParseError(
      'Wertpapierabrechnung erkannt, aber weder Kauf noch Verkauf – diese Art wird nicht unterstützt.',
    );
  }
  if (/Dividendengutschrift|Ertragsgutschrift|Zinsgutschrift/i.test(text))
    return parseDividend(doc);
  if (/Depotauszug|Depotübersicht|Depotbewertung/i.test(text)) return parseStatement(doc);
  // Überschrift „Vorabpauschale“ – nicht der Hinweis auf der Steuerseite einer Verkaufsabrechnung
  if (/^Vorabpauschale(\s+gem\.|$)/im.test(text)) return parseAdvanceLumpSum(doc);

  throw new DocumentParseError(
    'Unbekannte Dokumentart. Unterstützt werden Wertpapierabrechnungen (Kauf, Verkauf, ' +
      'Umtausch), Ertragsabrechnungen, Vorabpauschalen und Depotauszüge der ING.',
  );
}
