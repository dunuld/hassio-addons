/**
 * Kurse von Yahoo Finance (inoffizielle, frei zugängliche Schnittstelle, kein Schlüssel nötig).
 *
 * - Kürzelsuche per ISIN (`/v1/finance/search`), bevorzugt Handelsplätze in EUR (Xetra zuerst)
 * - aktueller Kurs und Tagesschlusskurse (`/v8/finance/chart`)
 * - Fremdwährungen werden mit dem Devisenkurs von Yahoo in EUR umgerechnet (z. B. `USDEUR=X`)
 */

export type FetchFn = typeof fetch;

export interface Quote {
  /** Kurs in EUR */
  price: number;
  /** ISO-Datum des Kurses (Börsentag, deutsche Zeit) */
  date: string;
  /** Ursprüngliche Währung des Kürzels, z. B. `USD` */
  currency: string;
}

export class YahooError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YahooError';
  }
}

const BASE_URL = 'https://query1.finance.yahoo.com';
const USER_AGENT = 'Mozilla/5.0 (compatible; ing-depot-addon)';

/** Handelsplätze mit Kursen in EUR, in absteigender Vorliebe (Yahoo-Börsencodes). */
const EUR_EXCHANGES = [
  'GER',
  'FRA',
  'STU',
  'MUN',
  'BER',
  'DUS',
  'HAM',
  'HAN',
  'AMS',
  'PAR',
  'MIL',
  'BRU',
  'VIE',
  'MCE',
  'LIS',
  'HEL',
  'IRL',
];

const BERLIN_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });

/** Unix-Zeit (Sekunden) → ISO-Datum in deutscher Zeit. */
export const berlinDate = (seconds: number): string => BERLIN_DATE.format(new Date(seconds * 1000));

const isoToUnix = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 1000;
const DAY = 86_400;

interface SearchQuote {
  symbol?: unknown;
  exchange?: unknown;
}

interface ChartResult {
  meta?: { currency?: unknown; regularMarketPrice?: unknown; regularMarketTime?: unknown };
  timestamp?: unknown;
  indicators?: { quote?: { close?: unknown }[] };
}

export interface YahooOptions {
  fetchFn?: FetchFn;
  baseUrl?: string;
}

export class YahooClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  /** Devisenkurse je Währung und Tag (bzw. `latest`), gilt für die Lebensdauer des Clients */
  private readonly fxCache = new Map<string, Promise<number>>();

  constructor(options: YahooOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  private async getJson(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new YahooError(`Yahoo Finance nicht erreichbar (${String(error)})`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new YahooError(`Yahoo Finance antwortet mit Status ${res.status}`);
    return res.json();
  }

  /** Sucht das Yahoo-Kürzel zu einer ISIN; bevorzugt EUR-Handelsplätze. `null` = nichts gefunden. */
  async findSymbol(isin: string): Promise<string | null> {
    const body = (await this.getJson(
      `/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=10&newsCount=0`,
    )) as { quotes?: SearchQuote[] } | null;
    const quotes = (body?.quotes ?? []).filter(
      (q): q is { symbol: string; exchange?: unknown } => typeof q.symbol === 'string',
    );
    const rank = (q: { exchange?: unknown }): number => {
      const index = EUR_EXCHANGES.indexOf(String(q.exchange));
      return index >= 0 ? index : EUR_EXCHANGES.length;
    };
    // Stabile Sortierung: innerhalb gleicher Rangstufe bleibt Yahoos Relevanz-Reihenfolge
    return [...quotes].sort((a, b) => rank(a) - rank(b))[0]?.symbol ?? null;
  }

  private async chart(symbol: string, query: string): Promise<ChartResult | null> {
    const body = (await this.getJson(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&${query}`,
    )) as { chart?: { result?: ChartResult[] | null } } | null;
    return body?.chart?.result?.[0] ?? null;
  }

  /** Aktueller Kurs eines Kürzels, in EUR umgerechnet. `null` = Kürzel unbekannt. */
  async latest(symbol: string): Promise<Quote | null> {
    const result = await this.chart(symbol, 'range=5d');
    const price = Number(result?.meta?.regularMarketPrice);
    const time = Number(result?.meta?.regularMarketTime);
    if (!result || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return null;
    const currency = String(result.meta?.currency ?? 'EUR');
    return this.toEur(price, currency, null, berlinDate(time));
  }

  /**
   * Letzter Schlusskurs an oder vor `date` (bis zu 10 Tage zurück), in EUR umgerechnet.
   * `null` = für den Zeitraum liegt kein Kurs vor.
   */
  async closeOn(symbol: string, date: string): Promise<Quote | null> {
    const end = isoToUnix(date) + DAY;
    const result = await this.chart(symbol, `period1=${end - 11 * DAY}&period2=${end}`);
    if (!result) return null;
    const timestamps = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
    const closes = result.indicators?.quote?.[0]?.close;
    const closeList = Array.isArray(closes) ? (closes as unknown[]) : [];
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const day = berlinDate(Number(timestamps[i]));
      const close = Number(closeList[i]);
      if (day <= date && closeList[i] !== null && Number.isFinite(close) && close > 0) {
        return this.toEur(close, String(result.meta?.currency ?? 'EUR'), day, day);
      }
    }
    return null;
  }

  /** Rechnet einen Kurs in EUR um; `fxDate` = Devisenkurs dieses Tages, `null` = aktueller. */
  private async toEur(
    value: number,
    currency: string,
    fxDate: string | null,
    date: string,
  ): Promise<Quote> {
    let amount = value;
    let unit = currency;
    // Londoner Kurse in Pence
    if (unit === 'GBp' || unit === 'GBX') {
      amount /= 100;
      unit = 'GBP';
    }
    if (unit === 'EUR') return { price: Math.round(amount * 10_000) / 10_000, date, currency };
    // Umgerechnete Kurse auf Cent runden – mehr Stellen gibt die Umrechnung nicht her
    amount *= await this.fxRate(unit, fxDate);
    return { price: Math.round(amount * 100) / 100, date, currency };
  }

  private fxRate(currency: string, date: string | null): Promise<number> {
    const key = `${currency}|${date ?? 'latest'}`;
    let rate = this.fxCache.get(key);
    if (!rate) {
      const symbol = `${currency}EUR=X`;
      rate = (date ? this.closeOn(symbol, date) : this.latest(symbol)).then((quote) => {
        if (!quote) throw new YahooError(`Kein Devisenkurs ${currency}→EUR verfügbar`);
        return quote.price;
      });
      // Fehlschläge nicht zwischenspeichern
      rate.catch(() => this.fxCache.delete(key));
      this.fxCache.set(key, rate);
    }
    return rate;
  }
}
