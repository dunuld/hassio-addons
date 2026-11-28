import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  Depot,
  DepotDocument,
  DepotUpdate,
  DocumentType,
  ImportFailure,
  ImportResult,
  OpeningInput,
  Overview,
  PriceInput,
  PriceSource,
  SecurityUpdate,
  Transaction,
  TransactionType,
} from '../../shared/api-types.js';
import { transaction, type Database, type Row } from './db/database.js';
import { badRequest, notFound } from './http-error.js';
import { DocumentParseError, parseIngDocument, type ParsedDocument } from './ing-parser.js';
import { extractLines } from './pdf-text.js';
import {
  computeOverview,
  mergeOverviews,
  type PriceRow,
  type SecurityRow,
  type StartPoint,
  type StatementRow,
} from './portfolio.js';

export interface DepotServiceOptions {
  /** Ablage der Original-PDFs; `null` = nicht speichern (Tests). */
  documentsDir?: string | null;
  /** Freistellungsauftrag in Cent */
  exemptionCents?: number;
  /** Liefert das heutige ISO-Datum (in Tests überschreibbar). */
  today?: () => string;
  /** Liest die Textzeilen eines PDFs (in Tests überschreibbar). */
  readPdf?: (file: Uint8Array) => Promise<string[]>;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const DEPOT_NUMBER_RE = /^\d{4,20}$/;
/** Yahoo-Kürzel, z. B. `VGWL.DE`, `MSFT`, `^GDAXI` */
const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9.\-=^]{0,19}$/;

/** Anzeigename eines Depots: eigene Bezeichnung, sonst die Depotnummer. */
export function depotDisplayName(number: string, label: string | null): string {
  if (label) return label;
  return number ? `Depot ${number}` : 'Depot ohne Nummer';
}

export const localToday = (): string => {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const quantityText = (quantity: number): string =>
  quantity.toLocaleString('de-DE', { maximumFractionDigits: 6 });

/** Browser senden UTF-8-Dateinamen, die busboy als latin1 liest – hier zurückwandeln. */
export function normalizeFileName(name: string | undefined): string {
  let result = basename(name?.trim() || 'dokument.pdf');
  const decoded = Buffer.from(result, 'latin1').toString('utf8');
  if (!decoded.includes('�') && [...result].some((c) => c.charCodeAt(0) > 0x7f)) {
    result = decoded;
  }
  return result.slice(0, 200);
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const DOCUMENT_LABEL: Record<DocumentType, string> = {
  buy: 'Kauf',
  sell: 'Verkauf',
  dividend: 'Ertrag',
  statement: 'Depotauszug',
  exchange: 'Umtausch',
  advance_lump_sum: 'Vorabpauschale',
};

/** Platzhalter-Kennung für ein Wertpapier, von dem bisher nur die WKN bekannt ist. */
export const wknPlaceholder = (wkn: string): string => `WKN:${wkn}`;

function summarize(doc: ParsedDocument): string {
  if (doc.type === 'statement') {
    return `Depotauszug mit ${doc.positions.length} Position${doc.positions.length === 1 ? '' : 'en'}`;
  }
  if (doc.type === 'dividend') return `Ertrag ${doc.name}`;
  if (doc.type === 'advance_lump_sum') return `Vorabpauschale ${doc.name}`;
  if (doc.type === 'exchange') {
    const target = doc.target.isin ?? `WKN ${doc.target.wkn}`;
    return `Umtausch ${quantityText(doc.quantity)} × ${doc.name} → ${target}`;
  }
  return `${DOCUMENT_LABEL[doc.type]} ${quantityText(doc.quantity)} × ${doc.name}`;
}

/** Schlüssel, der dasselbe Dokument unabhängig von der Datei erkennt. */
function contentKey(doc: ParsedDocument): string {
  const depot = doc.depotNumber ?? '';
  if (doc.type === 'statement') return `${depot}|statement|${doc.date}`;
  if (doc.reference) return `${depot}|${doc.type}|${doc.reference}`;
  const amount = 'totalCents' in doc ? doc.totalCents : doc.grossCents;
  return [depot, doc.type, doc.isin, doc.date, doc.quantity, amount].join('|');
}

function toDocument(row: Row): DepotDocument {
  return {
    id: Number(row['id']),
    depotId: Number(row['depot_id']),
    depotName: depotDisplayName(
      String(row['depot_number']),
      (row['depot_label'] as string | null) ?? null,
    ),
    type: row['type'] as DocumentType,
    fileName: String(row['file_name']),
    date: String(row['doc_date']),
    reference: (row['reference'] as string | null) ?? null,
    source: row['source'] as 'upload' | 'inbox',
    importedAt: String(row['imported_at']),
    summary: String(row['summary']),
  };
}

function toTransaction(row: Row): Transaction {
  return {
    id: Number(row['id']),
    documentId: row['document_id'] === null ? null : Number(row['document_id']),
    depotId: Number(row['depot_id']),
    type: row['type'] as TransactionType,
    date: String(row['date']),
    isin: String(row['isin']),
    name: String(row['name']),
    quantity: Number(row['quantity']),
    price: Number(row['price']),
    grossCents: Number(row['gross_cents']),
    feeCents: Number(row['fee_cents']),
    taxCents: Number(row['tax_cents']),
    totalCents: Number(row['total_cents']),
    gainCents: row['gain_cents'] === null ? null : Number(row['gain_cents']),
  };
}

const DOCUMENT_SELECT = `
  SELECT d.*, p.number AS depot_number, p.label AS depot_label
    FROM documents d JOIN depots p ON p.id = d.depot_id`;

const TRANSACTION_SELECT = `
  SELECT t.*, s.name FROM transactions t JOIN securities s ON s.isin = t.isin`;

/** Import, Speicherung und Auswertung der Depotdaten. */
export class DepotService {
  private readonly documentsDir: string | null;
  private readonly exemptionCents: number;
  private readonly today: () => string;
  private readonly readPdf: (file: Uint8Array) => Promise<string[]>;
  private readonly listeners: (() => void)[] = [];

  constructor(
    private readonly db: Database,
    options: DepotServiceOptions = {},
  ) {
    this.documentsDir = options.documentsDir ?? null;
    this.exemptionCents = options.exemptionCents ?? 0;
    this.today = options.today ?? localToday;
    this.readPdf =
      options.readPdf ?? (async (file) => (await extractLines(file)).map((line) => line.text));
  }

  /** Meldet Änderungen am Datenbestand (z. B. um HA-Sensoren zu aktualisieren). */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- Import ----

  async importPdf(
    file: Uint8Array,
    originalName: string | undefined,
    source: 'upload' | 'inbox' = 'upload',
  ): Promise<ImportResult> {
    const fileName = normalizeFileName(originalName);
    const failed = (message: string): ImportResult => ({ fileName, status: 'failed', message });

    const sha256 = createHash('sha256').update(file).digest('hex');
    if (this.db.prepare('SELECT 1 FROM documents WHERE sha256 = ?').get(sha256)) {
      return { fileName, status: 'duplicate', message: 'Diese Datei wurde bereits importiert.' };
    }

    let parsed: ParsedDocument;
    try {
      const lines = await this.readPdf(file);
      if (lines.length === 0) {
        return failed('Die PDF enthält keinen lesbaren Text (evtl. ein Scan).');
      }
      parsed = parseIngDocument(lines);
    } catch (error) {
      if (error instanceof DocumentParseError) return failed(error.message);
      console.error(`PDF „${fileName}“ konnte nicht gelesen werden:`, error);
      return failed('Die Datei ist keine lesbare PDF.');
    }

    const key = contentKey(parsed);
    if (this.db.prepare('SELECT 1 FROM documents WHERE content_key = ?').get(key)) {
      return {
        fileName,
        status: 'duplicate',
        message: 'Dieses Dokument wurde bereits importiert (andere Datei, gleicher Inhalt).',
      };
    }

    const id = transaction(this.db, () => this.store(parsed, { fileName, sha256, key, source }));
    if (this.documentsDir) {
      mkdirSync(this.documentsDir, { recursive: true });
      writeFileSync(join(this.documentsDir, `${id}.pdf`), file);
    }
    this.changed();
    const document = this.getDocument(id);
    return { fileName, status: 'imported', message: document.summary, document };
  }

  /**
   * Legt ein Wertpapier an bzw. ergänzt es. Der Name wird überschrieben, wenn bisher nur die ISIN
   * bekannt war oder `preferName` gesetzt ist (Abrechnungen führen den vollständigen Namen).
   * War das Wertpapier bisher nur per WKN bekannt (Umtausch), wird der Platzhalter übernommen.
   */
  private upsertSecurity(
    isin: string,
    name: string,
    wkn: string | null = null,
    preferName = wkn !== null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO securities (isin, wkn, name) VALUES (?, ?, ?)
         ON CONFLICT (isin) DO UPDATE SET
           wkn = COALESCE(excluded.wkn, wkn),
           name = CASE WHEN name = isin OR ? THEN excluded.name ELSE name END`,
      )
      .run(isin, wkn, name, preferName ? 1 : 0);
    if (wkn) this.adoptPlaceholder(isin, wkn);
  }

  /** Überträgt Buchungen und Kurse vom WKN-Platzhalter auf das Wertpapier mit ISIN. */
  private adoptPlaceholder(isin: string, wkn: string): void {
    const placeholder = wknPlaceholder(wkn);
    if (!this.db.prepare('SELECT 1 FROM securities WHERE isin = ?').get(placeholder)) return;
    this.db.prepare('UPDATE transactions SET isin = ? WHERE isin = ?').run(isin, placeholder);
    this.db
      .prepare('UPDATE statement_positions SET isin = ? WHERE isin = ?')
      .run(isin, placeholder);
    this.db.prepare('UPDATE OR IGNORE prices SET isin = ? WHERE isin = ?').run(isin, placeholder);
    this.db.prepare('DELETE FROM prices WHERE isin = ?').run(placeholder);
    this.db.prepare('DELETE FROM securities WHERE isin = ?').run(placeholder);
  }

  /** ISIN des Zielwertpapiers eines Umtauschs; nur per WKN bekannt → Platzhalter. */
  private exchangeTarget(target: { isin: string | null; wkn: string | null }): string {
    if (target.isin) {
      this.upsertSecurity(target.isin, target.isin, target.wkn, false);
      return target.isin;
    }
    const wkn = target.wkn!;
    const known = this.db
      .prepare("SELECT isin FROM securities WHERE wkn = ? AND isin NOT LIKE 'WKN:%'")
      .get(wkn);
    if (known) return String(known['isin']);
    const placeholder = wknPlaceholder(wkn);
    this.upsertSecurity(placeholder, `WKN ${wkn}`, null, false);
    return placeholder;
  }

  private insertTransaction(row: {
    documentId: number | null;
    depotId: number;
    type: TransactionType;
    date: string;
    isin: string;
    quantity: number;
    price: number;
    grossCents: number;
    feeCents: number;
    taxCents: number;
    totalCents: number;
    gainCents?: number | null;
  }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO transactions
             (document_id, depot_id, type, date, isin, quantity, price,
              gross_cents, fee_cents, tax_cents, total_cents, gain_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.documentId,
          row.depotId,
          row.type,
          row.date,
          row.isin,
          row.quantity,
          row.price,
          row.grossCents,
          row.feeCents,
          row.taxCents,
          row.totalCents,
          row.gainCents ?? null,
        ).lastInsertRowid,
    );
  }

  private upsertPrice(
    isin: string,
    date: string,
    price: number,
    source: PriceSource,
    documentId: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO prices (isin, date, price, source, document_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (isin, date, source) DO UPDATE SET
           price = excluded.price, document_id = excluded.document_id`,
      )
      .run(isin, date, price, source, documentId);
  }

  /** ID des Depots mit dieser Nummer; ein unbekanntes Depot wird angelegt. */
  private depotFor(number: string): number {
    const row = this.db.prepare('SELECT id FROM depots WHERE number = ?').get(number);
    if (row) return Number(row['id']);
    return Number(
      this.db.prepare('INSERT INTO depots (number) VALUES (?)').run(number).lastInsertRowid,
    );
  }

  /** Entfernt Depots, zu denen weder Dokumente noch Buchungen gehören. */
  private removeEmptyDepots(): void {
    this.db.exec(`
      DELETE FROM depots
       WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.depot_id = depots.id)
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.depot_id = depots.id)`);
  }

  private store(
    doc: ParsedDocument,
    meta: { fileName: string; sha256: string; key: string; source: 'upload' | 'inbox' },
  ): number {
    const depotId = this.depotFor(doc.depotNumber ?? '');
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO documents
             (depot_id, type, file_name, sha256, doc_date, reference, content_key, source, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          depotId,
          doc.type,
          meta.fileName,
          meta.sha256,
          doc.date,
          doc.reference,
          meta.key,
          meta.source,
          summarize(doc),
        ).lastInsertRowid,
    );

    if (doc.type === 'statement') {
      const insert = this.db.prepare(
        `INSERT INTO statement_positions (document_id, date, isin, quantity, value_cents)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const position of doc.positions) {
        // Namen aus dem Auszug sind oft gekürzt – nur übernehmen, wenn keiner bekannt ist
        this.upsertSecurity(position.isin, position.name, position.wkn, false);
        insert.run(id, doc.date, position.isin, position.quantity, position.valueCents);
        if (position.price) {
          this.upsertPrice(position.isin, doc.date, position.price, 'document', id);
        }
      }
      return id;
    }

    this.upsertSecurity(doc.isin, doc.name, doc.wkn);
    const base = { documentId: id, depotId, date: doc.date, isin: doc.isin, feeCents: 0 };

    if (doc.type === 'exchange') {
      // Abgang wie ein Verkauf zum Kurswert, Zugang wie ein Kauf zum selben Wert
      const target = this.exchangeTarget(doc.target);
      this.insertTransaction({
        ...base,
        type: 'exchange_out',
        quantity: doc.quantity,
        price: doc.price,
        grossCents: doc.grossCents,
        taxCents: doc.taxCents,
        totalCents: -doc.taxCents,
        gainCents: doc.gainCents,
      });
      const targetPrice = doc.grossCents / 100 / doc.targetQuantity;
      this.insertTransaction({
        ...base,
        type: 'exchange_in',
        isin: target,
        quantity: doc.targetQuantity,
        price: targetPrice,
        grossCents: doc.grossCents,
        taxCents: 0,
        totalCents: doc.grossCents,
      });
      this.upsertPrice(doc.isin, doc.date, doc.price, 'document', id);
      this.upsertPrice(target, doc.date, targetPrice, 'document', id);
      return id;
    }

    if (doc.type === 'advance_lump_sum') {
      this.insertTransaction({
        ...base,
        type: 'advance_lump_sum',
        quantity: doc.quantity,
        price: 0,
        grossCents: doc.grossCents,
        taxCents: doc.taxCents,
        totalCents: -doc.taxCents,
      });
      return id;
    }

    const price = doc.type === 'dividend' ? 0 : doc.price;
    this.insertTransaction({
      ...base,
      type: doc.type,
      quantity: doc.quantity,
      price,
      grossCents: doc.grossCents,
      feeCents: doc.type === 'dividend' ? 0 : doc.feeCents,
      taxCents: doc.taxCents,
      totalCents: doc.totalCents,
      gainCents: doc.type === 'sell' ? doc.gainCents : null,
    });
    if (price > 0) this.upsertPrice(doc.isin, doc.date, price, 'document', id);
    return id;
  }

  // ---- Dokumente ----

  listDocuments(depotId?: number): DepotDocument[] {
    const order = 'ORDER BY d.doc_date DESC, d.id DESC';
    const rows = depotId
      ? this.db.prepare(`${DOCUMENT_SELECT} WHERE d.depot_id = ? ${order}`).all(depotId)
      : this.db.prepare(`${DOCUMENT_SELECT} ${order}`).all();
    return rows.map(toDocument);
  }

  getDocument(id: number): DepotDocument {
    const row = this.db.prepare(`${DOCUMENT_SELECT} WHERE d.id = ?`).get(id);
    if (!row) throw notFound('Dokument nicht gefunden');
    return toDocument(row);
  }

  /** Pfad der gespeicherten Original-PDF; `null`, wenn sie nicht (mehr) vorliegt. */
  documentFile(id: number): string | null {
    this.getDocument(id);
    if (!this.documentsDir) return null;
    const file = join(this.documentsDir, `${id}.pdf`);
    return existsSync(file) ? file : null;
  }

  deleteDocument(id: number): void {
    this.getDocument(id);
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
      this.removeEmptyDepots();
    });
    if (this.documentsDir) rmSync(join(this.documentsDir, `${id}.pdf`), { force: true });
    this.changed();
  }

  // ---- Nicht erkannte Dateien aus dem Eingangsordner ----

  addFailure(fileName: string, reason: string): void {
    this.db
      .prepare('INSERT INTO import_failures (file_name, reason) VALUES (?, ?)')
      .run(fileName, reason);
  }

  listFailures(): ImportFailure[] {
    return this.db
      .prepare('SELECT * FROM import_failures ORDER BY id DESC')
      .all()
      .map((row) => ({
        id: Number(row['id']),
        fileName: String(row['file_name']),
        reason: String(row['reason']),
        createdAt: String(row['created_at']),
      }));
  }

  deleteFailure(id: number): void {
    const result = this.db.prepare('DELETE FROM import_failures WHERE id = ?').run(id);
    if (result.changes === 0) throw notFound('Eintrag nicht gefunden');
  }

  // ---- Buchungen ----

  listTransactions(year?: number, depotId?: number): Transaction[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (year) {
      where.push('t.date BETWEEN ? AND ?');
      params.push(`${year}-01-01`, `${year}-12-31`);
    }
    if (depotId) {
      where.push('t.depot_id = ?');
      params.push(depotId);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(`${TRANSACTION_SELECT} ${filter} ORDER BY t.date DESC, t.id DESC`)
      .all(...params)
      .map(toTransaction);
  }

  addOpening(input: Partial<OpeningInput>): Transaction {
    const depotNumber = String(input.depotNumber ?? '').replace(/\s/g, '');
    if (!DEPOT_NUMBER_RE.test(depotNumber)) {
      throw badRequest('Ungültige Depotnummer.', 'INVALID_DEPOT');
    }
    const isin = String(input.isin ?? '')
      .trim()
      .toUpperCase();
    if (!ISIN_RE.test(isin)) throw badRequest('Ungültige ISIN.', 'INVALID_ISIN');
    if (!isValidDate(input.date)) throw badRequest('Ungültiges Datum.', 'INVALID_DATE');
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw badRequest('Die Stückzahl muss größer als 0 sein.', 'INVALID_QUANTITY');
    }
    const costCents = Number(input.costCents);
    if (!Number.isInteger(costCents) || costCents < 0) {
      throw badRequest('Ungültiger Einstandswert.', 'INVALID_COST');
    }
    const name = String(input.name ?? '').trim() || isin;
    const date = input.date;

    const id = transaction(this.db, () => {
      this.upsertSecurity(isin, name);
      const depotId = this.depotFor(depotNumber);
      const price = costCents / 100 / quantity;
      if (price > 0) this.upsertPrice(isin, date, price, 'document');
      return Number(
        this.db
          .prepare(
            `INSERT INTO transactions
               (depot_id, type, date, isin, quantity, price,
                gross_cents, fee_cents, tax_cents, total_cents)
             VALUES (?, 'opening', ?, ?, ?, ?, ?, 0, 0, ?)`,
          )
          .run(depotId, date, isin, quantity, price, costCents, costCents).lastInsertRowid,
      );
    });
    this.changed();
    return toTransaction(this.db.prepare(`${TRANSACTION_SELECT} WHERE t.id = ?`).get(id)!);
  }

  /** Löscht einen manuell erfassten Startbestand; importierte Buchungen hängen am Dokument. */
  deleteTransaction(id: number): void {
    const row = this.db.prepare('SELECT document_id FROM transactions WHERE id = ?').get(id);
    if (!row) throw notFound('Buchung nicht gefunden');
    if (row['document_id'] !== null) {
      throw badRequest(
        'Importierte Buchungen werden über das zugehörige Dokument gelöscht.',
        'IMPORTED_TRANSACTION',
      );
    }
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      this.removeEmptyDepots();
    });
    this.changed();
  }

  // ---- Depots ----

  listDepots(): Depot[] {
    const statements = new Map<number, { id: number; date: string }[]>();
    const statementRows = this.db
      .prepare(
        `SELECT id, depot_id, doc_date FROM documents
          WHERE type = 'statement' ORDER BY doc_date DESC, id DESC`,
      )
      .all();
    for (const row of statementRows) {
      const depotId = Number(row['depot_id']);
      const list = statements.get(depotId) ?? [];
      list.push({ id: Number(row['id']), date: String(row['doc_date']) });
      statements.set(depotId, list);
    }
    return this.db
      .prepare(
        `SELECT p.*, s.doc_date AS start_date,
                (SELECT COUNT(*) FROM documents d WHERE d.depot_id = p.id) AS document_count
           FROM depots p LEFT JOIN documents s ON s.id = p.start_document_id
          ORDER BY p.number = '', p.number`,
      )
      .all()
      .map((row) => {
        const id = Number(row['id']);
        const number = String(row['number']);
        const label = (row['label'] as string | null) ?? null;
        return {
          id,
          number,
          label,
          displayName: depotDisplayName(number, label),
          startDocumentId:
            row['start_document_id'] === null ? null : Number(row['start_document_id']),
          startDate: (row['start_date'] as string | null) ?? null,
          documentCount: Number(row['document_count']),
          statements: statements.get(id) ?? [],
        };
      });
  }

  private requireDepot(id: number): Depot {
    const depot = this.listDepots().find((d) => d.id === id);
    if (!depot) throw notFound('Depot nicht gefunden');
    return depot;
  }

  updateDepot(id: number, update: Partial<DepotUpdate>): Depot {
    const depot = this.requireDepot(id);
    if (update.label !== undefined) {
      const label = update.label === null ? null : String(update.label).trim().slice(0, 60) || null;
      this.db.prepare('UPDATE depots SET label = ? WHERE id = ?').run(label, id);
    }
    if (update.startDocumentId !== undefined) {
      const start = update.startDocumentId;
      if (start !== null && !depot.statements.some((s) => s.id === start)) {
        throw badRequest(
          'Als Startpunkt eignet sich nur ein Depotauszug dieses Depots.',
          'INVALID_START',
        );
      }
      this.db.prepare('UPDATE depots SET start_document_id = ? WHERE id = ?').run(start, id);
    }
    this.changed();
    return this.requireDepot(id);
  }

  // ---- Kurse ----

  private requireSecurity(isin: string): void {
    if (!this.db.prepare('SELECT 1 FROM securities WHERE isin = ?').get(isin)) {
      throw notFound('Wertpapier nicht gefunden');
    }
  }

  addPrice(isin: string, input: Partial<PriceInput>, source: PriceSource = 'manual'): void {
    this.requireSecurity(isin);
    const price = Number(input.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw badRequest('Der Kurs muss größer als 0 sein.', 'INVALID_PRICE');
    }
    const date = input.date ?? this.today();
    if (!isValidDate(date)) throw badRequest('Ungültiges Datum.', 'INVALID_DATE');
    this.upsertPrice(isin, date, price, source);
    this.changed();
  }

  setPriceEntity(isin: string, entity: string | null | undefined, notify = true): void {
    this.requireSecurity(isin);
    const value = entity?.trim() || null;
    if (value && !ENTITY_RE.test(value)) {
      throw badRequest('Ungültige Entität (erwartet z. B. sensor.msci_world).', 'INVALID_ENTITY');
    }
    this.db.prepare('UPDATE securities SET price_entity = ? WHERE isin = ?').run(value, isin);
    if (notify) this.changed();
  }

  /**
   * Ändert die Kurs-Einstellungen eines Wertpapiers. Nur übergebene Felder werden geändert;
   * ein neues Yahoo-Kürzel verwirft das automatisch ermittelte.
   */
  updateSecurity(isin: string, update: Partial<SecurityUpdate>): void {
    this.requireSecurity(isin);
    let symbol: string | null | undefined;
    if (update.priceSymbol !== undefined) {
      symbol = update.priceSymbol === null ? null : String(update.priceSymbol).trim() || null;
      if (symbol && !SYMBOL_RE.test(symbol)) {
        throw badRequest('Ungültiges Kürzel (erwartet z. B. VGWL.DE).', 'INVALID_SYMBOL');
      }
    }
    if (update.onlinePrices !== undefined && typeof update.onlinePrices !== 'boolean') {
      throw badRequest('onlinePrices muss true oder false sein.', 'INVALID_ONLINE');
    }
    transaction(this.db, () => {
      if (update.priceEntity !== undefined) this.setPriceEntity(isin, update.priceEntity, false);
      if (update.onlinePrices !== undefined) {
        this.db
          .prepare('UPDATE securities SET online_prices = ? WHERE isin = ?')
          .run(update.onlinePrices ? 1 : 0, isin);
      }
      if (symbol !== undefined) {
        this.db
          .prepare('UPDATE securities SET price_symbol = ?, resolved_symbol = NULL WHERE isin = ?')
          .run(symbol, isin);
      }
    });
    this.changed();
  }

  /** Wertpapiere mit Online-Abruf samt festgelegtem bzw. ermitteltem Yahoo-Kürzel. */
  onlineSecurities(): {
    isin: string;
    name: string;
    symbol: string | null;
    resolved: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT isin, name, price_symbol, resolved_symbol FROM securities
          WHERE online_prices = 1 AND isin NOT LIKE 'WKN:%'`,
      )
      .all()
      .map((row) => ({
        isin: String(row['isin']),
        name: String(row['name']),
        symbol: (row['price_symbol'] as string | null) ?? null,
        resolved: (row['resolved_symbol'] as string | null) ?? null,
      }));
  }

  setResolvedSymbol(isin: string, symbol: string | null): void {
    this.db.prepare('UPDATE securities SET resolved_symbol = ? WHERE isin = ?').run(symbol, isin);
  }

  /**
   * Speichert einen Online-Kurs, ohne Zuhörer zu benachrichtigen – der Abruf meldet
   * die Änderung gesammelt über `notifyChanged()`.
   */
  storeOnlinePrice(isin: string, date: string, price: number): void {
    this.upsertPrice(isin, date, price, 'yahoo');
  }

  notifyChanged(): void {
    this.changed();
  }

  /** Gibt es einen Kurs (beliebiger Quelle) im Zeitraum `from` bis `to`? */
  hasPriceBetween(isin: string, from: string, to: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM prices WHERE isin = ? AND date BETWEEN ? AND ?')
      .get(isin, from, to);
  }

  /** Wertpapiere, deren Kurs aus einer HA-Entität gelesen wird. */
  priceEntities(): { isin: string; entity: string }[] {
    return this.db
      .prepare('SELECT isin, price_entity FROM securities WHERE price_entity IS NOT NULL')
      .all()
      .map((row) => ({ isin: String(row['isin']), entity: String(row['price_entity']) }));
  }

  // ---- Auswertung ----

  /**
   * Jahresübersicht eines Depots oder – ohne `depotId` – aller Depots zusammen.
   * Jedes Depot wird für sich gerechnet (FIFO und Startpunkt gelten je Depot).
   */
  overview(year?: number, depotId?: number): Overview {
    const today = this.today();
    const selectedYear = year ?? Number(today.slice(0, 4));
    const securities: SecurityRow[] = this.db
      .prepare(
        'SELECT isin, name, price_entity, online_prices, price_symbol, resolved_symbol FROM securities',
      )
      .all()
      .map((row) => ({
        isin: String(row['isin']),
        name: String(row['name']),
        priceEntity: (row['price_entity'] as string | null) ?? null,
        onlinePrices: Number(row['online_prices']) === 1,
        priceSymbol: (row['price_symbol'] as string | null) ?? null,
        resolvedSymbol: (row['resolved_symbol'] as string | null) ?? null,
      }));
    const prices: PriceRow[] = this.db
      .prepare('SELECT isin, date, price, source FROM prices')
      .all()
      .map((row) => ({
        isin: String(row['isin']),
        date: String(row['date']),
        price: Number(row['price']),
        source: row['source'] as PriceSource,
      }));
    const transactions = this.listTransactions();
    const base = { year: selectedYear, today, exemptionCents: this.exemptionCents };

    const compute = (depot: Depot): Overview =>
      computeOverview({
        ...base,
        depotId: depot.id,
        transactions: transactions.filter((tx) => tx.depotId === depot.id),
        prices,
        securities,
        statement: this.statementRows(depot.id),
        start: this.startPoint(depot),
      });

    if (depotId) return compute(this.requireDepot(depotId));

    const depots = this.listDepots();
    const startYear = (d: Depot): number | null =>
      d.startDate ? Number(d.startDate.slice(0, 4)) : null;
    // Depots, deren Startpunkt nach dem gewählten Jahr liegt, tragen zu diesem Jahr nichts bei
    const parts = depots
      .filter((d) => (startYear(d) ?? selectedYear) <= selectedYear)
      .map((depot) => ({ name: depot.displayName, overview: compute(depot) }));
    const merged = mergeOverviews(parts, base);
    const years = depots.flatMap((d) => (startYear(d) === null ? [] : [startYear(d)!]));
    return { ...merged, years: [...new Set([...merged.years, ...years])].sort((a, b) => b - a) };
  }

  /** Positionen aller Depotauszüge eines Depots (Plausibilitätsprüfung). */
  private statementRows(depotId: number): StatementRow[] {
    return this.db
      .prepare(
        `SELECT sp.date, sp.isin, sp.quantity FROM statement_positions sp
           JOIN documents d ON d.id = sp.document_id WHERE d.depot_id = ?`,
      )
      .all(depotId)
      .map((row) => ({
        date: String(row['date']),
        isin: String(row['isin']),
        quantity: Number(row['quantity']),
      }));
  }

  /** Bestände des als Startpunkt gewählten Depotauszugs, bewertet mit ihrem Kurswert. */
  private startPoint(depot: Depot): StartPoint | null {
    if (!depot.startDocumentId || !depot.startDate) return null;
    const positions = this.db
      .prepare('SELECT isin, quantity, value_cents FROM statement_positions WHERE document_id = ?')
      .all(depot.startDocumentId)
      .map((row) => ({
        isin: String(row['isin']),
        quantity: Number(row['quantity']),
        costCents: Number(row['value_cents'] ?? 0),
      }));
    return { date: depot.startDate, positions };
  }
}
