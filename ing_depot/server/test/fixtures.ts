import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Textzeilen synthetischer ING-Dokumente. Aufbau wie die echten PDFs (Direkt-Depot, Stand 2026),
 * Depotnummern, Beträge und Bestände sind erfunden.
 */

export const DEPOT_A = '1234567890';
export const DEPOT_B = '9876543210';

const header = (depot: string, date: string): string[] => [
  'ING-DiBa AG · 60628 Frankfurt am Main',
  'Depotinhaber:',
  `Direkt-Depot Nr.: ${depot}`,
  `Datum: ${date}`,
  'Seite: 1 von 1',
];

const footer = [
  'ING-DiBa AG · Theodor-Heuss-Allee 2 · 60486 Frankfurt am Main · Sitz: Frankfurt am Main',
  'Steuernummer: 014 220 2800 4 · USt-IdNr.: DE 114 103 475 · Internet: www.ing.de',
];

export interface TradeFixture {
  depot?: string;
  kind?: 'Kauf' | 'Kauf aus Sparplan' | 'Verkauf';
  order?: string;
  isin?: string;
  wkn?: string;
  name?: string;
  quantity?: string;
  price?: string;
  date?: string;
  gross?: string;
  fee?: string | null;
  taxes?: [string, string][];
  total?: string;
  /** Verkauf: Steuerseite mit „Veräußerungsgewinn nach Differenzmethode“ */
  gain?: string;
}

export function tradeLines(f: TradeFixture = {}): string[] {
  const kind = f.kind ?? 'Kauf';
  const sell = kind === 'Verkauf';
  const date = f.date ?? '15.03.2026';
  const order = f.order ?? '12345678.001';
  const isinLine = `ISIN (WKN) ${f.isin ?? 'IE00B4L5Y983'} (${f.wkn ?? 'A0RPWH'})`;
  return [
    ...header(f.depot ?? DEPOT_A, date),
    `Wertpapierabrechnung ${kind}`,
    `Ordernummer ${order}`,
    isinLine,
    `Wertpapierbezeichnung ${f.name ?? 'iShs Core MSCI World U.ETF'}`,
    'Registered Shs USD (Acc) o.N.',
    `Nominale Stück ${f.quantity ?? '3,00000'}`,
    `Kurs EUR ${f.price ?? '56,768'}`,
    'Handelsplatz Xetra',
    `Ausführungstag / -zeit ${date} um 10:15:00 Uhr`,
    `Kurswert EUR ${f.gross ?? '170,30'}`,
    ...(f.taxes ?? []).map(([label, amount]) => `${label} EUR ${amount}`),
    ...(f.fee === null ? [] : [`Provision EUR ${f.fee ?? '2,98'}`]),
    `Endbetrag zu Ihren ${sell ? 'Gunsten' : 'Lasten'} EUR ${f.total ?? '173,28'}`,
    `Valuta ${date}`,
    `Wertpapiere ${sell ? 'zulasten' : 'zugunsten'} Wertpapierrechnung Großbritannien.`,
    ...footer,
    ...(f.gain
      ? [
          `Ordernummer ${order}`,
          isinLine,
          `Veräußerungsgewinn nach Differenzmethode ${f.gain} EUR`,
          'Abzgl. Teilfreistellung 30,00 % 1,50 EUR',
          'KapSt-pflichtiger Kapitalertrag 40,00 EUR',
          'Bemessungsgrundlage für KapSt 40,00 EUR',
          'Sparer-Pauschbetrag nach Geschäft 0,00 EUR',
        ]
      : []),
  ];
}

export const BUY_LINES = tradeLines();

/** Verkauf von 2 Stück zu 80 € mit Steuern: 160,00 − 10,00 − 0,55 − 4,90 = 144,55 */
export const SELL_LINES = tradeLines({
  kind: 'Verkauf',
  order: '22222222.001',
  quantity: '2,00',
  price: '80,00',
  date: '20.06.2026',
  gross: '160,00',
  fee: '4,90',
  taxes: [
    ['Kapitalertragsteuer 25,00 %', '10,00'],
    ['Solidaritätszuschlag 5,50 %', '0,55'],
  ],
  total: '144,55',
  gain: '40,00',
});

/** Ausschüttung eines ETF ohne Steuerabzug (Sparer-Pauschbetrag) */
export const DISTRIBUTION_LINES = [
  ...header(DEPOT_A, '23.03.2026'),
  'Ertragsgutschrift',
  'ISIN (WKN) DE0002635307 (263530)',
  'Wertpapierbezeichnung iShares STOXX Europe 600 UCITS ETF',
  'Inhaber-Anlageaktien',
  'Nominale 10,00 Stück',
  'Ertragsausschüttung per Stück 0,400000 EUR',
  'Ex-Tag 20.03.2026',
  'Zahltag 20.03.2026',
  'Brutto EUR 4,00',
  'Gesamtbetrag zu Ihren Gunsten EUR 4,00',
  'Valuta 20.03.2026',
  'Keine Fondsausgangsquellensteuer',
  'Ausschüttung gem §2 Abs. 11 InvStG 4,00 EUR',
  'KapSt-pflichtiger Kapitalertrag 2,80 EUR',
  'Mit Sparer-Pauschbetrag verrechnet -2,80 EUR',
];

/** Ertragsgutschrift mit Kapitalertragsteuer und Soli */
export const EUR_DIVIDEND_LINES = [
  ...header(DEPOT_A, '13.05.2026'),
  'Ertragsgutschrift',
  'ISIN (WKN) DE0008404005 (840400)',
  'Wertpapierbezeichnung Allianz SE',
  'vink.Namens-Aktien o.N.',
  'Nominale 5,00 Stück',
  'Ex-Tag 08.05.2026',
  'Zahltag 12.05.2026',
  'Brutto EUR 77,00',
  'Kapitalertragsteuer 25,00 % EUR 19,25',
  'Solidaritätszuschlag 5,50 % EUR 1,05',
  'Gesamtbetrag zu Ihren Gunsten EUR 56,70',
  'Valuta 12.05.2026',
  'KapSt-pflichtiger Kapitalertrag 77,00 EUR',
  'Bemessungsgrundlage für KapSt 77,00 EUR',
];

/** Dividende in Fremdwährung (Aufbau angenommen, kein echtes Muster vorhanden) */
export const DIVIDEND_LINES = [
  ...header(DEPOT_A, '13.06.2026'),
  'Dividendengutschrift',
  'ISIN (WKN) US5949181045 (870747)',
  'Wertpapierbezeichnung Microsoft Corp.',
  'Registered Shares DL-,00000625',
  'Nominale 20,00 Stück',
  'Ex-Tag 20.05.2026',
  'Zahltag 12.06.2026',
  'Zins-/Dividendensatz 0,51 USD',
  'Brutto USD 10,20',
  'Umg. z. Dev.-Kurs (1,1144) EUR 9,15',
  'QuSt 15,00 % (EUR 1,37) USD 1,53',
  'Gesamtbetrag zu Ihren Gunsten EUR 7,78',
];

export interface StatementPositionFixture {
  quantity: string;
  name: string;
  isin: string;
  /** Standard: aus der ISIN abgeleitet */
  wkn?: string;
  price: string;
  value: string;
}

export function statementLines(
  date: string,
  positions: StatementPositionFixture[],
  depot = DEPOT_A,
): string[] {
  return [
    ...header(depot, '13.01.2026'),
    `Depotauszug per ${date}`,
    'Sehr geehrte Damen und Herren,',
    'wir übersenden Ihnen hiermit eine Aufstellung der für Sie verwahrten Wertpapiere.',
    'Stücke/Nominale Wertpapier-Informationen Kurs Kurswert',
    'Devisenkurs',
    ...positions.flatMap((p) => [
      `${p.quantity} Stück ${p.name} ${p.price} EUR ${p.value} EUR`,
      'Registered Shares o.N.',
      `ISIN (WKN): ${p.isin} (${p.wkn ?? p.isin.slice(5, 11)})`,
      'Verwahrart: Wertpapierrechnung',
      'Lagerland: Großbritannien',
    ]),
    `Anzahl Posten: ${positions.length} Gesamtkurswert 8.500,00 EUR`,
    'Fehlen Kurse? Dann liegt uns kein offizieller Schlusskurs vor.',
    ...footer,
  ];
}

export const STATEMENT_LINES = statementLines('31.12.2025', [
  {
    quantity: '10',
    name: 'iShs Core MSCI World U.ETF',
    isin: 'IE00B4L5Y983',
    wkn: 'A0RPWH',
    price: '50,00',
    value: '500,00',
  },
  {
    quantity: '20',
    name: 'Microsoft Corp.',
    isin: 'US5949181045',
    wkn: '870747',
    price: '400,00',
    value: '8.000,00',
  },
]);

export interface ExchangeFixture {
  depot?: string;
  isin?: string;
  wkn?: string;
  name?: string;
  quantity?: string;
  price?: string;
  gross?: string;
  /** Endbetrag zu Ihren Lasten (einbehaltene Steuern) */
  charged?: string;
  /** Hinweistext mit dem neuen Wertpapier */
  note?: string;
  gain?: string | null;
}

/** „Wertpapierabrechnung zum steuerrelevanten Umtausch“ (Fondsverschmelzung) */
export function exchangeLines(f: ExchangeFixture = {}): string[] {
  const isinLine = `ISIN (WKN) ${f.isin ?? 'LU0392494562'} (${f.wkn ?? 'ETF110'})`;
  return [
    ...header(f.depot ?? DEPOT_A, '21.02.2026'),
    'Wertpapierabrechnung zum steuerrelevanten Umtausch',
    'Ordernummer 55555555.001',
    isinLine,
    `Wertpapierbezeichnung ${f.name ?? 'Alter Welt-ETF'}`,
    'Act.Nom. UCITS ETF DR (C)o.N.',
    `Nominale Stück ${f.quantity ?? '10,00000'}`,
    `Kurs EUR ${f.price ?? '50,00'}`,
    'Ausführungstag 20.02.2026',
    `Kurswert EUR ${f.gross ?? '500,00'}`,
    `Zwischensumme EUR ${f.gross ?? '500,00'}`,
    `Endbetrag zu Ihren Lasten EUR ${f.charged ?? '0,00'}`,
    'Valuta 20.02.2026',
    'Wertpapiere zulasten Girosammelverwahrung.',
    f.note ?? 'Ihre Anteile wurden im Verhältnis 1:1 in die WKN NEU001 umgetauscht.',
    'Jahressteuerbescheinigung folgt.',
    ...footer,
    'Ordernummer 55555555.001',
    isinLine,
    ...(f.gain === null
      ? []
      : [`Veräußerungsgewinn nach Differenzmethode ${f.gain ?? '40,00'} EUR`]),
    'Abzüglich besitzanteilige Vorabpauschale 2,00 EUR',
    'KapSt-pflichtiger Kapitalertrag 26,60 EUR',
  ];
}

export interface AdvanceFixture {
  depot?: string;
  isin?: string;
  name?: string;
  amount?: string;
  taxes?: [string, string][];
  total?: string;
  charged?: boolean;
}

/** Mitteilung zur Vorabpauschale eines thesaurierenden Fonds */
export function advanceLines(f: AdvanceFixture = {}): string[] {
  return [
    ...header(f.depot ?? DEPOT_A, '20.01.2026'),
    'Vorabpauschale',
    `ISIN (WKN) ${f.isin ?? 'IE00B4L5Y983'} (A0RPWH)`,
    `Wertpapierbezeichnung ${f.name ?? 'iShs Core MSCI World U.ETF'}`,
    'Registered Shs USD (Acc) o.N.',
    'Nominale 10,00 Stück',
    'Ex-Tag 02.01.2026',
    'Zahltag 02.01.2026',
    `Vorabpauschale gem. § 18 InvStG EUR ${f.amount ?? '0,00'}`,
    ...(f.taxes ?? []).map(([label, amount]) => `${label} EUR ${amount}`),
    `KapSt-pflichtiger Kapitalertrag EUR ${f.amount ?? '0,00'}`,
    `Gesamtbetrag zu Ihren ${f.charged ? 'Lasten' : 'Gunsten'} EUR ${f.total ?? '0,00'}`,
    'Der ermittelte Wert für die Vorabpauschale beträgt 0,00 EUR. Es erfolgt daher keine Steuerbelastung.',
    ...footer,
  ];
}

/** Fasst Zeilen zu einem „PDF“ für den Test-Reader zusammen (siehe `textReader`). */
export const fakePdf = (lines: string[]): Buffer => Buffer.from(lines.join('\n'), 'utf8');

/** PDF-Reader für Tests: der Dateiinhalt ist der Text, eine Zeile je Zeile. */
export const textReader = (file: Uint8Array): Promise<string[]> =>
  Promise.resolve(Buffer.from(file).toString('utf8').split('\n').filter(Boolean));

/** Echte PDF mit einer Textzeile je Eintrag (für den Weg über pdf.js). */
export async function realPdf(lines: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595, 842]);
  lines.forEach((line, i) => {
    const row = i % 45;
    if (i > 0 && row === 0) page = pdf.addPage([595, 842]);
    page.drawText(line, { x: 60, y: 780 - row * 16, size: 10, font });
  });
  return Buffer.from(await pdf.save());
}
