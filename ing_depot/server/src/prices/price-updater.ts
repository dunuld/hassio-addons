import type { PriceUpdateMode, PriceUpdateStatus } from '../../../shared/api-types.js';
import { shiftDate, type DepotService } from '../depot.service.js';
import type { YahooClient } from './yahoo.js';

/** Börsenschluss für den täglichen Abruf (deutsche Zeit, nach Ende des Xetra-/Tradegate-Handels) */
const DAILY_AT = '22:30';
/** Handelszeit für laufende Abrufe (deutsche Zeit) */
const INTRADAY_FROM = '08:00';
const INTRADAY_TO = DAILY_AT;
const MAX_ERRORS = 20;
/** Ein Kurs bis zu so vielen Tagen vor dem 31.12. gilt als Jahresschlusskurs (Feiertage) */
const YEAR_END_WINDOW_DAYS = 10;
/** Dividendenhistorie je Wertpapier höchstens so oft neu abrufen */
const DIVIDEND_REFRESH_MS = 20 * 60 * 60 * 1000;
/** Zeitraum der abgerufenen Dividendenhistorie (Tage zurück) */
const DIVIDEND_HISTORY_DAYS = 400;

const BERLIN = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Wochentag, Datum und Uhrzeit in deutscher Zeit. */
export function berlinClock(now: Date): { weekday: string; date: string; time: string } {
  const parts = Object.fromEntries(BERLIN.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    weekday: String(parts['weekday']),
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}`,
  };
}

const isTradingDay = (weekday: string): boolean => !['Sat', 'Sun'].includes(weekday);

/**
 * Ist ein Abruf fällig?
 * - `daily`: an Börsentagen ab 22:30 Uhr, einmal pro Tag
 * - `intraday`: zusätzlich an Börsentagen zwischen 08:00 und 22:30 Uhr alle `intervalMinutes`
 */
export function isDue(
  mode: PriceUpdateMode,
  intervalMinutes: number,
  now: Date,
  lastRun: Date | null,
): boolean {
  if (mode === 'off') return false;
  const clock = berlinClock(now);
  if (!isTradingDay(clock.weekday)) return false;

  const last = lastRun ? berlinClock(lastRun) : null;
  const closedToday = clock.time >= DAILY_AT;
  const ranAfterClose = !!last && last.date === clock.date && last.time >= DAILY_AT;
  if (closedToday && !ranAfterClose) return true;

  if (mode === 'intraday' && clock.time >= INTRADAY_FROM && clock.time < INTRADAY_TO) {
    return !lastRun || now.getTime() - lastRun.getTime() >= intervalMinutes * 60_000;
  }
  return false;
}

/** ISO-Datum minus `days` Tage. */
function minusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export interface PriceUpdaterOptions {
  mode: PriceUpdateMode;
  intervalMinutes: number;
  now?: () => Date;
  /** Pause zwischen zwei Anfragen an Yahoo (ms), um nicht gesperrt zu werden */
  pauseMs?: number;
  log?: (message: string) => void;
}

/**
 * Holt Online-Kurse für alle gehaltenen Wertpapiere mit aktiviertem Online-Abruf und füllt
 * fehlende Jahresschlusskurse (31.12. des Vorjahres) für den „Kursgewinn seit 01.01.“ nach.
 */
export class PriceUpdater {
  private readonly now: () => Date;
  private readonly pauseMs: number;
  private readonly log: (message: string) => void;
  private lastRun: Date | null = null;
  private lastUpdated = 0;
  private lastErrors: string[] = [];
  private current: Promise<PriceUpdateStatus> | null = null;
  /** Bereits erfolglos gesuchte Jahresschlusskurse – nicht bei jedem Lauf erneut anfragen */
  private readonly missingYearEnds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly depot: DepotService,
    private readonly yahoo: YahooClient,
    private readonly options: PriceUpdaterOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.pauseMs = options.pauseMs ?? 300;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  status(): PriceUpdateStatus {
    return {
      mode: this.options.mode,
      intervalMinutes: this.options.intervalMinutes,
      running: this.current !== null,
      lastRunAt: this.lastRun?.toISOString() ?? null,
      lastUpdated: this.lastUpdated,
      lastErrors: [...this.lastErrors],
    };
  }

  /** Startet die Zeitsteuerung: sofort ein Abruf, danach jede Minute prüfen, ob einer fällig ist. */
  start(): void {
    if (this.options.mode === 'off' || this.timer) return;
    void this.run();
    this.timer = setInterval(() => {
      if (isDue(this.options.mode, this.options.intervalMinutes, this.now(), this.lastRun)) {
        void this.run();
      }
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Führt einen Abruf aus; läuft bereits einer, wird dessen Ergebnis geliefert. */
  run(): Promise<PriceUpdateStatus> {
    this.current ??= this.update()
      .catch((error: unknown) => {
        this.lastErrors = [`Abruf fehlgeschlagen: ${String(error)}`];
        return 0;
      })
      .then((updated) => {
        this.lastRun = this.now();
        this.lastUpdated = updated;
        if (updated > 0) this.depot.notifyChanged();
        for (const error of this.lastErrors) this.log(`Online-Kurse: ${error}`);
        this.current = null;
        return this.status();
      });
    return this.current;
  }

  private pause(): Promise<void> {
    return this.pauseMs > 0
      ? new Promise((resolve) => setTimeout(resolve, this.pauseMs))
      : Promise.resolve();
  }

  private async update(): Promise<number> {
    this.lastErrors = [];
    const fail = (message: string) => {
      if (this.lastErrors.length < MAX_ERRORS) this.lastErrors.push(message);
    };
    const securities = this.depot.onlineSecurities();
    if (securities.length === 0) return 0;
    const online = new Map(securities.map((s) => [s.isin, s]));

    const today = berlinClock(this.now()).date;
    const year = Number(today.slice(0, 4));
    const current = this.depot.overview(year);
    const held = current.positions.filter((p) => p.quantity > 0 && online.has(p.isin));

    const symbols = new Map<string, string | null>();
    const symbolFor = async (isin: string): Promise<string | null> => {
      if (symbols.has(isin)) return symbols.get(isin)!;
      const security = online.get(isin)!;
      let symbol = security.symbol ?? security.resolved;
      if (!symbol) {
        symbol = await this.yahoo.findSymbol(isin);
        await this.pause();
        this.depot.setResolvedSymbol(isin, symbol);
        if (!symbol) {
          fail(
            `${security.name}: Kein Yahoo-Kürzel zur ISIN ${isin} gefunden – bitte in der ` +
              'Positionsliste unter „Kurs“ eintragen.',
          );
        }
      }
      symbols.set(isin, symbol);
      return symbol;
    };

    let updated = 0;
    for (const position of held) {
      try {
        const symbol = await symbolFor(position.isin);
        if (!symbol) continue;
        const quote = await this.yahoo.latest(symbol);
        await this.pause();
        if (!quote) {
          fail(`${position.name}: Yahoo kennt das Kürzel ${symbol} nicht.`);
          continue;
        }
        this.depot.storeOnlinePrice(position.isin, quote.date, quote.price);
        updated++;
      } catch (error) {
        fail(`${position.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.refreshDividends(today, held, symbolFor, fail);
    updated += await this.fillYearEnds(year, current.years, online, symbolFor, fail);
    return updated;
  }

  /**
   * Holt die Dividendenhistorie (Ex-Tag, Betrag je Stück) der gehaltenen Wertpapiere für den
   * Dividendenkalender – je Wertpapier höchstens einmal in 20 Stunden.
   */
  private async refreshDividends(
    today: string,
    held: { isin: string; name: string }[],
    symbolFor: (isin: string) => Promise<string | null>,
    fail: (message: string) => void,
  ): Promise<void> {
    const staleBefore = new Date(this.now().getTime() - DIVIDEND_REFRESH_MS).toISOString();
    const from = shiftDate(today, { days: -DIVIDEND_HISTORY_DAYS });
    for (const position of held) {
      const last = this.depot.dividendsFetchedAt(position.isin);
      if (last && last > staleBefore) continue;
      try {
        const symbol = await symbolFor(position.isin);
        if (!symbol) continue;
        const events = await this.yahoo.dividends(symbol, from, today);
        await this.pause();
        // Unbekanntes Kürzel wurde beim Kursabruf bereits gemeldet
        if (events === null) continue;
        this.depot.replaceDividendEvents(
          position.isin,
          from,
          today,
          events,
          this.now().toISOString(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`${position.name}: Dividenden – ${message}`);
      }
    }
  }

  /**
   * Holt für jedes ausgewertete Jahr den Schlusskurs zum 31.12. des Vorjahres für alle Positionen,
   * die an diesem Tag gehalten wurden und für die noch kein Kurs aus den letzten Tagen vorliegt
   * (etwa weil der Jahresdepotauszug fehlt).
   */
  private async fillYearEnds(
    currentYear: number,
    years: number[],
    online: Map<string, { name: string }>,
    symbolFor: (isin: string) => Promise<string | null>,
    fail: (message: string) => void,
  ): Promise<number> {
    let updated = 0;
    const firstYear = Math.min(...years);
    for (let year = firstYear; year <= currentYear; year++) {
      const yearEnd = `${year - 1}-12-31`;
      // Bestand zum 31.12. des Vorjahres = Positionen der Übersicht des Vorjahres
      const positions = this.depot
        .overview(year - 1)
        .positions.filter((p) => p.quantity > 0 && online.has(p.isin));
      for (const position of positions) {
        const key = `${position.isin}|${yearEnd}`;
        if (this.missingYearEnds.has(key)) continue;
        if (
          this.depot.hasPriceBetween(
            position.isin,
            minusDays(yearEnd, YEAR_END_WINDOW_DAYS),
            yearEnd,
          )
        ) {
          continue;
        }
        try {
          const symbol = await symbolFor(position.isin);
          if (!symbol) continue;
          const quote = await this.yahoo.closeOn(symbol, yearEnd);
          await this.pause();
          if (!quote) {
            this.missingYearEnds.add(key);
            fail(
              `${position.name}: Kein Schlusskurs zum ${yearEnd.split('-').reverse().join('.')} bei Yahoo.`,
            );
            continue;
          }
          this.depot.storeOnlinePrice(position.isin, quote.date, quote.price);
          updated++;
        } catch (error) {
          fail(`${position.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return updated;
  }
}
