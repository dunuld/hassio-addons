import type {
  MonthlyFigures,
  Overview,
  Position,
  PriceSource,
  Transaction,
} from '../../shared/api-types.js';

export interface PriceRow {
  isin: string;
  date: string;
  price: number;
  source: PriceSource;
}

export interface SecurityRow {
  isin: string;
  name: string;
  priceEntity: string | null;
  onlinePrices?: boolean;
  priceSymbol?: string | null;
  resolvedSymbol?: string | null;
}

/** Bestand laut Depotauszug – dient zur Plausibilitätsprüfung. */
export interface StatementRow {
  date: string;
  isin: string;
  quantity: number;
}

/** Depotauszug als Startpunkt: Bestände zum Stichtag, bewertet mit dem Kurswert des Auszugs. */
export interface StartPoint {
  date: string;
  positions: { isin: string; quantity: number; costCents: number }[];
}

export interface PortfolioInput {
  year: number;
  /** ISO-Datum von „heute“ */
  today: string;
  transactions: Transaction[];
  prices: PriceRow[];
  securities: SecurityRow[];
  /** Positionen der Depotauszüge – geprüft wird der jüngste bis zum Bewertungsstichtag */
  statement: StatementRow[];
  exemptionCents: number;
  start?: StartPoint | null;
  depotId?: number | null;
}

interface Lot {
  quantity: number;
  costCents: number;
}

interface State {
  lots: Lot[];
  buysCents: number;
  sellsCents: number;
  realizedCents: number;
  dividendsNetCents: number;
  startQuantity: number;
  startCostCents: number;
}

const EPSILON = 1e-9;
/** Bei mehreren Kursen desselben Tages gewinnt der höchste Rang. */
const SOURCE_RANK: Record<PriceSource, number> = { document: 0, yahoo: 1, ha: 2, manual: 3 };

const pct = (gain: number, base: number): number | null =>
  base > 0 ? Math.round((gain / base) * 10000) / 100 : null;

const quantityOf = (lots: Lot[]): number => lots.reduce((sum, lot) => sum + lot.quantity, 0);
const costOf = (lots: Lot[]): number => lots.reduce((sum, lot) => sum + lot.costCents, 0);

/** Buchungen, die Stücke zuführen bzw. abgeben */
const isInflow = (tx: Transaction): boolean =>
  tx.type === 'buy' || tx.type === 'opening' || tx.type === 'exchange_in';
const isOutflow = (tx: Transaction): boolean => tx.type === 'sell' || tx.type === 'exchange_out';

const formatQuantity = (quantity: number): string =>
  quantity.toLocaleString('de-DE', { maximumFractionDigits: 6 });

/** `2026-03-15` → `15.03.2026` */
export const formatDate = (iso: string): string => iso.split('-').reverse().join('.');

function emptyMonthly(): MonthlyFigures[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    investedCents: 0,
    dividendsNetCents: 0,
    realizedCents: 0,
  }));
}

/**
 * Berechnet die Jahresübersicht eines Depots: Bestände und Einstandswerte nach FIFO, realisierte
 * Gewinne, Dividenden sowie Kursgewinne seit Kauf und seit Periodenbeginn.
 *
 * Mit Startpunkt zählen nur Buchungen nach dessen Stichtag; die Bestände des Depotauszugs gehen
 * mit ihrem Kurswert als Einstandswert in die Rechnung ein.
 */
export function computeOverview(input: PortfolioInput): Overview {
  const currentYear = Number(input.today.slice(0, 4));
  const start = input.start ?? null;
  const startYear = start ? Number(start.date.slice(0, 4)) : null;
  const year = startYear !== null ? Math.max(input.year, startYear) : input.year;
  const yearStart = `${year}-01-01`;
  const previousEnd = `${year - 1}-12-31`;
  // Liegt der Startpunkt im Jahr, beginnt der Auswertungszeitraum an seinem Stichtag
  const startInYear = start !== null && start.date >= yearStart;
  const periodStart = startInYear ? start.date : yearStart;
  const asOf = year < currentYear ? `${year}-12-31` : input.today;
  const warnings: string[] = [];
  /**
   * Hinweise auf Lücken in der Historie (fehlende Käufe, Kurse, Abweichungen zum Auszug). Mit
   * Startpunkt hat der Nutzer bewusst ab einem Depotauszug begonnen – dann entfallen sie.
   */
  const gapWarning = (message: string): void => {
    if (!start) warnings.push(message);
  };

  const names = new Map(input.securities.map((s) => [s.isin, s]));
  const nameOf = (isin: string): string => names.get(isin)?.name ?? isin;

  const prices = [...input.prices].sort(
    (a, b) => a.date.localeCompare(b.date) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source],
  );
  const priceAt = (isin: string, date: string): PriceRow | null => {
    let found: PriceRow | null = null;
    for (const price of prices) {
      if (price.date > date) break;
      if (price.isin === isin) found = price;
    }
    return found;
  };

  // Buchungen bis einschließlich Stichtag stecken bereits im Bestand des Startpunkts
  const relevant = input.transactions.filter((tx) => !start || tx.date > start.date);
  const transactions = relevant
    .filter((tx) => tx.date <= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const states = new Map<string, State>();
  const stateOf = (isin: string): State => {
    let state = states.get(isin);
    if (!state) {
      state = {
        lots: [],
        buysCents: 0,
        sellsCents: 0,
        realizedCents: 0,
        dividendsNetCents: 0,
        startQuantity: 0,
        startCostCents: 0,
      };
      states.set(isin, state);
    }
    return state;
  };

  for (const position of start?.positions ?? []) {
    if (position.quantity <= EPSILON) continue;
    stateOf(position.isin).lots.push({
      quantity: position.quantity,
      costCents: position.costCents,
    });
    if (position.costCents === 0) {
      warnings.push(
        `Startpunkt ${formatDate(start!.date)}: Für ${nameOf(position.isin)} enthält der ` +
          'Depotauszug keinen Kurswert – Einstandswert 0 €.',
      );
    }
  }

  const monthly = emptyMonthly();
  const monthOf = (date: string): MonthlyFigures => monthly[Number(date.slice(5, 7)) - 1]!;

  const totals = {
    investedGrossCents: 0,
    investedNetCents: 0,
    feesCents: 0,
    realizedCents: 0,
    dividendsGrossCents: 0,
    dividendsNetCents: 0,
    taxesCents: 0,
    advanceLumpSumCents: 0,
  };

  let snapshotTaken = false;
  const takeSnapshot = (): void => {
    snapshotTaken = true;
    for (const state of states.values()) {
      state.startQuantity = quantityOf(state.lots);
      state.startCostCents = costOf(state.lots);
    }
  };
  // Startpunkt im Jahr: Anfangsbestand ist der Bestand des Depotauszugs
  if (startInYear) takeSnapshot();

  for (const tx of transactions) {
    const inYear = tx.date >= yearStart;
    if (inYear && !snapshotTaken) takeSnapshot();
    const state = stateOf(tx.isin);

    if (isInflow(tx)) {
      state.lots.push({ quantity: tx.quantity, costCents: tx.totalCents });
      if (inYear) {
        // Für den Kursgewinn seit Jahresbeginn zählt auch ein Umtausch als Zugang …
        state.buysCents += tx.totalCents;
      }
      // … als Investition aber nicht – es fließt kein Geld
      if (inYear && tx.type !== 'exchange_in') {
        totals.investedGrossCents += tx.totalCents;
        totals.investedNetCents += tx.totalCents;
        totals.feesCents += tx.feeCents;
        monthOf(tx.date).investedCents += tx.totalCents;
      }
    } else if (isOutflow(tx)) {
      const exchange = tx.type === 'exchange_out';
      const proceedsCents = tx.grossCents - tx.feeCents;
      let remaining = tx.quantity;
      let costCents = 0;
      while (remaining > EPSILON && state.lots.length > 0) {
        const lot = state.lots[0]!;
        if (lot.quantity <= remaining + EPSILON) {
          costCents += lot.costCents;
          remaining -= lot.quantity;
          state.lots.shift();
        } else {
          const part = Math.round(lot.costCents * (remaining / lot.quantity));
          costCents += part;
          lot.costCents -= part;
          lot.quantity -= remaining;
          remaining = 0;
        }
      }
      const covered = remaining > EPSILON ? (tx.quantity - remaining) / tx.quantity : 1;
      // Die Bank kennt die vollständige Kaufhistorie – ihr Ergebnis hat Vorrang vor FIFO
      const reported = tx.gainCents ?? null;
      if (remaining > EPSILON && reported === null) {
        gapWarning(
          `${exchange ? 'Umtausch' : 'Verkauf'} von ${nameOf(tx.isin)} am ${formatDate(tx.date)}: Für ` +
            `${formatQuantity(remaining)} Stück fehlt der Kauf. Bitte ältere Kaufabrechnungen ` +
            'importieren, einen Startbestand erfassen oder einen früheren Depotauszug als ' +
            'Startpunkt wählen – der Gewinn dieser Stücke ist nicht berücksichtigt.',
        );
      }
      const realizedCents = reported ?? Math.round(proceedsCents * covered) - costCents;
      if (inYear) {
        // Nur Stücke mit bekanntem Bestand gehen in den Kursgewinn seit Jahresbeginn ein
        state.sellsCents += Math.round(proceedsCents * covered);
        state.realizedCents += realizedCents;
        totals.realizedCents += realizedCents;
        if (!exchange) totals.investedNetCents -= proceedsCents;
        totals.feesCents += tx.feeCents;
        totals.taxesCents += tx.taxCents;
        monthOf(tx.date).realizedCents += realizedCents;
      }
    } else if (tx.type === 'advance_lump_sum') {
      if (inYear) {
        totals.advanceLumpSumCents += tx.grossCents;
        totals.taxesCents += tx.taxCents;
      }
    } else if (inYear) {
      state.dividendsNetCents += tx.totalCents;
      totals.dividendsGrossCents += tx.grossCents;
      totals.dividendsNetCents += tx.totalCents;
      totals.taxesCents += tx.taxCents;
      monthOf(tx.date).dividendsNetCents += tx.totalCents;
    }
  }
  // Keine Buchung im Jahr: der Bestand zum Stichtag ist zugleich der Anfangsbestand
  if (!snapshotTaken) takeSnapshot();

  const positions: Position[] = [];
  for (const [isin, state] of states) {
    const quantity = quantityOf(state.lots);
    const held = quantity > EPSILON;
    const costCents = held ? costOf(state.lots) : 0;
    const price = held ? priceAt(isin, asOf) : null;
    if (held && isin.startsWith('WKN:')) {
      warnings.push(
        `Umtausch in ${nameOf(isin)}: Die ISIN ist noch unbekannt. Das Wertpapier wird automatisch ` +
          'zugeordnet, sobald ein Dokument mit seiner WKN importiert wird (z. B. ein Depotauszug).',
      );
    } else if (held && !price) {
      gapWarning(`Für ${nameOf(isin)} ist kein Kurs bekannt – bewertet zum Einstandswert.`);
    }
    const valueCents = price ? Math.round(quantity * price.price * 100) : costCents;

    let startValueCents = 0;
    if (state.startQuantity > EPSILON) {
      const startPrice = startInYear ? null : priceAt(isin, previousEnd);
      if (startPrice) {
        startValueCents = Math.round(state.startQuantity * startPrice.price * 100);
      } else {
        startValueCents = state.startCostCents;
        if (!startInYear) {
          gapWarning(
            `Für ${nameOf(isin)} fehlt ein Kurs zum ${formatDate(previousEnd)} – der Kursgewinn ` +
              'seit Jahresbeginn rechnet ersatzweise mit dem Einstandswert. Der ' +
              'Jahresdepotauszug liefert diesen Kurs.',
          );
        }
      }
    }
    const ytdBaseCents = startValueCents + state.buysCents;
    const ytdGainCents = valueCents + state.sellsCents - ytdBaseCents;
    const active =
      held || state.realizedCents !== 0 || state.dividendsNetCents !== 0 || state.sellsCents !== 0;
    if (!active) continue;

    positions.push({
      isin,
      name: nameOf(isin),
      quantity: held ? Math.round(quantity * 1e6) / 1e6 : 0,
      costCents,
      price: price?.price ?? null,
      priceDate: price?.date ?? null,
      priceSource: price?.source ?? null,
      priceEntity: names.get(isin)?.priceEntity ?? null,
      onlinePrices: names.get(isin)?.onlinePrices ?? true,
      priceSymbol: names.get(isin)?.priceSymbol ?? null,
      resolvedSymbol: names.get(isin)?.resolvedSymbol ?? null,
      valueCents,
      gainCents: valueCents - costCents,
      gainPct: pct(valueCents - costCents, costCents),
      ytdGainCents,
      ytdGainPct: pct(ytdGainCents, ytdBaseCents),
      ytdBaseCents,
      realizedCents: state.realizedCents,
      dividendsNetCents: state.dividendsNetCents,
    });
  }
  sortPositions(positions);

  // Bestand laut Depotauszug mit dem aus Startpunkt und Buchungen berechneten vergleichen
  const checkDate = input.statement
    .map((row) => row.date)
    .filter((date) => date <= asOf && (!start || date > start.date))
    .sort()
    .at(-1);
  const mismatches: string[] = [];
  for (const row of input.statement) {
    if (row.date !== checkDate) continue;
    let computed = start?.positions.find((p) => p.isin === row.isin)?.quantity ?? 0;
    for (const tx of relevant) {
      if (tx.isin !== row.isin || tx.date > row.date) continue;
      if (isInflow(tx)) computed += tx.quantity;
      else if (isOutflow(tx)) computed -= tx.quantity;
    }
    if (Math.abs(computed - row.quantity) > 1e-4) {
      mismatches.push(
        `${formatQuantity(row.quantity)} Stück ${nameOf(row.isin)} ` +
          `(aus den Abrechnungen: ${formatQuantity(computed)})`,
      );
    }
  }
  if (mismatches.length > 0) {
    const shown = mismatches.slice(0, 3).join(', ');
    const more = mismatches.length > 3 ? ` und ${mismatches.length - 3} weitere` : '';
    gapWarning(
      `Depotauszug vom ${formatDate(checkDate!)}: Der Bestand passt bei ` +
        `${mismatches.length === 1 ? 'einem Wertpapier' : `${mismatches.length} Wertpapieren`} ` +
        `nicht zu den Abrechnungen – ${shown}${more}. Es fehlen Abrechnungen oder ein ` +
        'Startbestand. Alternativ unter „Depots“ einen Depotauszug als Startpunkt wählen.',
    );
  }

  const years = new Set(relevant.map((tx) => Number(tx.date.slice(0, 4))));
  years.add(currentYear);
  if (startYear !== null) years.add(startYear);

  return summarize({
    year,
    depotId: input.depotId ?? null,
    startDate: start?.date ?? null,
    periodStart,
    years: [...years].filter((y) => startYear === null || y >= startYear),
    asOf,
    totals,
    exemptionCents: input.exemptionCents,
    positions,
    monthly,
    warnings,
  });
}

function sortPositions(positions: Position[]): void {
  positions.sort((a, b) => b.valueCents - a.valueCents || a.name.localeCompare(b.name, 'de'));
}

interface Parts {
  year: number;
  depotId: number | null;
  startDate: string | null;
  periodStart: string;
  years: number[];
  asOf: string;
  totals: Pick<
    Overview,
    | 'investedGrossCents'
    | 'investedNetCents'
    | 'feesCents'
    | 'realizedCents'
    | 'dividendsGrossCents'
    | 'dividendsNetCents'
    | 'taxesCents'
    | 'advanceLumpSumCents'
  >;
  exemptionCents: number;
  positions: Position[];
  monthly: MonthlyFigures[];
  warnings: string[];
}

/** Bildet Depotwert, Kursgewinne und Freistellungsauftrag aus den Positionen. */
function summarize(parts: Parts): Overview {
  const sum = (pick: (p: Position) => number): number =>
    parts.positions.reduce((total, p) => total + pick(p), 0);
  const valueCents = sum((p) => p.valueCents);
  const costCents = sum((p) => p.costCents);
  const ytdGainCents = sum((p) => p.ytdGainCents);
  const ytdBaseCents = sum((p) => p.ytdBaseCents);
  const { totals } = parts;

  return {
    year: parts.year,
    depotId: parts.depotId,
    startDate: parts.startDate,
    periodStart: parts.periodStart,
    years: [...new Set(parts.years)].sort((a, b) => b - a),
    asOf: parts.asOf,
    ...totals,
    valueCents,
    costCents,
    gainCents: valueCents - costCents,
    gainPct: pct(valueCents - costCents, costCents),
    ytdGainCents,
    ytdGainPct: pct(ytdGainCents, ytdBaseCents),
    exemptionCents: parts.exemptionCents,
    exemptionUsedCents: Math.max(
      0,
      totals.dividendsGrossCents + totals.realizedCents + totals.advanceLumpSumCents,
    ),
    positions: parts.positions,
    monthly: parts.monthly,
    warnings: [...new Set(parts.warnings)],
  };
}

/**
 * Fasst die Übersichten mehrerer Depots zusammen. Positionen derselben ISIN werden addiert;
 * Hinweise erhalten den Depotnamen als Präfix.
 */
export function mergeOverviews(
  parts: { name: string; overview: Overview }[],
  base: { year: number; today: string; exemptionCents: number },
): Overview {
  if (parts.length === 1) return { ...parts[0]!.overview, depotId: null };
  if (parts.length === 0) {
    return computeOverview({
      ...base,
      transactions: [],
      prices: [],
      securities: [],
      statement: [],
    });
  }

  const overviews = parts.map((p) => p.overview);
  const keys = [
    'investedGrossCents',
    'investedNetCents',
    'feesCents',
    'realizedCents',
    'dividendsGrossCents',
    'dividendsNetCents',
    'taxesCents',
    'advanceLumpSumCents',
  ] as const;
  const totals = Object.fromEntries(
    keys.map((key) => [key, overviews.reduce((sum, o) => sum + o[key], 0)]),
  ) as Parts['totals'];

  const positions = new Map<string, Position>();
  for (const overview of overviews) {
    for (const p of overview.positions) {
      const existing = positions.get(p.isin);
      if (!existing) {
        positions.set(p.isin, { ...p });
        continue;
      }
      existing.quantity = Math.round((existing.quantity + p.quantity) * 1e6) / 1e6;
      existing.costCents += p.costCents;
      existing.valueCents += p.valueCents;
      existing.gainCents += p.gainCents;
      existing.ytdGainCents += p.ytdGainCents;
      existing.ytdBaseCents += p.ytdBaseCents;
      existing.realizedCents += p.realizedCents;
      existing.dividendsNetCents += p.dividendsNetCents;
      if (existing.price === null && p.price !== null) {
        existing.price = p.price;
        existing.priceDate = p.priceDate;
        existing.priceSource = p.priceSource;
      }
    }
  }
  const merged = [...positions.values()].map((p) => ({
    ...p,
    gainPct: pct(p.gainCents, p.costCents),
    ytdGainPct: pct(p.ytdGainCents, p.ytdBaseCents),
  }));
  sortPositions(merged);

  const monthly = emptyMonthly();
  for (const overview of overviews) {
    overview.monthly.forEach((m, i) => {
      monthly[i]!.investedCents += m.investedCents;
      monthly[i]!.dividendsNetCents += m.dividendsNetCents;
      monthly[i]!.realizedCents += m.realizedCents;
    });
  }

  return summarize({
    year: base.year,
    depotId: null,
    startDate:
      overviews
        .map((o) => o.startDate)
        .filter((d): d is string => d !== null)
        .sort()[0] ?? null,
    // Frühester Beginn – Depots ohne Startpunkt im Jahr beginnen am 01.01.
    periodStart: overviews.map((o) => o.periodStart).sort()[0]!,
    years: overviews.flatMap((o) => o.years),
    asOf: overviews[0]!.asOf,
    totals,
    exemptionCents: base.exemptionCents,
    positions: merged,
    monthly,
    warnings: parts.flatMap(({ name, overview }) => overview.warnings.map((w) => `${name}: ${w}`)),
  });
}
