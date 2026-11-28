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

export interface ParsedStatementPosition {
  isin: string;
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

export type ParsedDocument = ParsedTrade | ParsedDividend | ParsedStatement;

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

  // Steuerseite des Verkaufs: „Veräußerungsgewinn nach Differenzmethode 123,45 EUR“
  const gainLine = type === 'sell' ? doc.find(/^Veräußerungs(gewinn|verlust)\b/i) : undefined;
  let gainCents: number | null = null;
  if (gainLine) {
    const value = toCents(lastNumber(gainLine) ?? 0);
    const negative =
      /verlust/i.test(gainLine) || new RegExp(String.raw`-\s*(${NUMBER})\s*(EUR)?$`).test(gainLine);
    gainCents = negative ? -value : value;
  }

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
  let current: Omit<ParsedStatementPosition, 'isin'> | null = null;

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
      if (!positions.has(isin))
        positions.set(isin, { isin, ...current, name: current.name || isin });
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

  throw new DocumentParseError(
    'Unbekannte Dokumentart. Unterstützt werden Wertpapierabrechnungen (Kauf/Verkauf), ' +
      'Ertragsabrechnungen und Depotauszüge der ING.',
  );
}
