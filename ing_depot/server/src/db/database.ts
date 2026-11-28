import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Kapselt den SQLite-Treiber (node:sqlite). */
export type Database = DatabaseSync;
export type Row = Record<string, unknown>;

export const SCHEMA_VERSION = 5;

const schemaSql = (): string => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * v2: mehrere Depots (erkannt an der Depotnummer der Dokumente) und Depotauszug als Startpunkt.
 * Bereits importierte Daten landen in einem Depot ohne Nummer.
 */
const MIGRATION_2 = `
  CREATE TABLE depots (
    id                INTEGER PRIMARY KEY,
    -- Leer = Dokumente ohne erkennbare Depotnummer
    number            TEXT NOT NULL UNIQUE,
    label             TEXT,
    -- Depotauszug, ab dessen Stichtag gerechnet wird; NULL = gesamte Historie
    start_document_id INTEGER REFERENCES documents (id) ON DELETE SET NULL
  );
  ALTER TABLE documents ADD COLUMN depot_id INTEGER REFERENCES depots (id);
  ALTER TABLE transactions ADD COLUMN depot_id INTEGER REFERENCES depots (id);
  ALTER TABLE statement_positions ADD COLUMN value_cents INTEGER;
  -- Veräußerungsgewinn/-verlust laut Verkaufsabrechnung
  ALTER TABLE transactions ADD COLUMN gain_cents INTEGER;
  INSERT INTO depots (number)
    SELECT '' WHERE EXISTS (SELECT 1 FROM documents) OR EXISTS (SELECT 1 FROM transactions);
  UPDATE documents SET depot_id = (SELECT id FROM depots WHERE number = '');
  UPDATE transactions SET depot_id = (SELECT id FROM depots WHERE number = '');
  CREATE INDEX documents_depot ON documents (depot_id);
  CREATE INDEX transactions_depot ON transactions (depot_id);
`;

/**
 * v3: Online-Kurse. Die Kursquelle wird nicht mehr per CHECK eingeschränkt (neue Quellen ohne
 * Tabellenumbau), Wertpapiere erhalten Einstellungen für den Online-Abruf.
 */
const MIGRATION_3 = `
  CREATE TABLE prices_v3 (
    isin        TEXT NOT NULL REFERENCES securities (isin),
    date        TEXT NOT NULL,
    price       REAL NOT NULL,
    source      TEXT NOT NULL,
    document_id INTEGER REFERENCES documents (id) ON DELETE CASCADE,
    PRIMARY KEY (isin, date, source)
  );
  INSERT INTO prices_v3 (isin, date, price, source, document_id)
    SELECT isin, date, price, source, document_id FROM prices;
  DROP TABLE prices;
  ALTER TABLE prices_v3 RENAME TO prices;
  ALTER TABLE securities ADD COLUMN online_prices INTEGER NOT NULL DEFAULT 1;
  -- Vom Nutzer festgelegtes bzw. automatisch ermitteltes Yahoo-Kürzel
  ALTER TABLE securities ADD COLUMN price_symbol TEXT;
  ALTER TABLE securities ADD COLUMN resolved_symbol TEXT;
`;

/**
 * v4: neue Dokument- und Buchungsarten (Umtausch, Vorabpauschale). SQLite kann CHECK-Bedingungen
 * nicht ändern, daher werden `documents` und `transactions` ohne Einschränkung der Art neu
 * aufgebaut (Fremdschlüssel sind dabei abgeschaltet, siehe `migrate`).
 */
const MIGRATION_4 = `
  CREATE TABLE documents_v4 (
    id          INTEGER PRIMARY KEY,
    type        TEXT NOT NULL,
    file_name   TEXT NOT NULL,
    sha256      TEXT NOT NULL UNIQUE,
    doc_date    TEXT NOT NULL,
    reference   TEXT,
    content_key TEXT NOT NULL UNIQUE,
    source      TEXT NOT NULL CHECK (source IN ('upload', 'inbox')),
    summary     TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    depot_id    INTEGER REFERENCES depots (id)
  );
  INSERT INTO documents_v4
      (id, type, file_name, sha256, doc_date, reference, content_key, source, summary,
       imported_at, depot_id)
    SELECT id, type, file_name, sha256, doc_date, reference, content_key, source, summary,
           imported_at, depot_id
      FROM documents;
  DROP TABLE documents;
  ALTER TABLE documents_v4 RENAME TO documents;
  CREATE INDEX documents_depot ON documents (depot_id);

  CREATE TABLE transactions_v4 (
    id          INTEGER PRIMARY KEY,
    document_id INTEGER REFERENCES documents (id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    date        TEXT NOT NULL,
    isin        TEXT NOT NULL REFERENCES securities (isin),
    quantity    REAL NOT NULL,
    price       REAL NOT NULL,
    gross_cents INTEGER NOT NULL,
    fee_cents   INTEGER NOT NULL,
    tax_cents   INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    depot_id    INTEGER REFERENCES depots (id),
    gain_cents  INTEGER
  );
  INSERT INTO transactions_v4
      (id, document_id, type, date, isin, quantity, price, gross_cents, fee_cents, tax_cents,
       total_cents, depot_id, gain_cents)
    SELECT id, document_id, type, date, isin, quantity, price, gross_cents, fee_cents, tax_cents,
           total_cents, depot_id, gain_cents
      FROM transactions;
  DROP TABLE transactions;
  ALTER TABLE transactions_v4 RENAME TO transactions;
  CREATE INDEX transactions_date ON transactions (date);
  CREATE INDEX transactions_isin ON transactions (isin);
  CREATE INDEX transactions_depot ON transactions (depot_id);
`;

/** v5: Dividendenhistorie je Wertpapier (Yahoo Finance) für den Dividendenkalender. */
const MIGRATION_5 = `
  CREATE TABLE dividend_events (
    isin     TEXT NOT NULL REFERENCES securities (isin) ON DELETE CASCADE,
    ex_date  TEXT NOT NULL,
    -- Betrag je Stück in EUR (Fremdwährung umgerechnet)
    amount   REAL NOT NULL,
    currency TEXT NOT NULL,
    PRIMARY KEY (isin, ex_date)
  );
  -- Zeitpunkt des letzten Abrufs der Dividendenhistorie (NULL = nie)
  ALTER TABLE securities ADD COLUMN dividends_fetched_at TEXT;
`;

/** Öffnet (oder erstellt) die Datenbank und wendet das Schema an. `:memory:` für Tests. */
export function openDatabase(file: string): Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Database): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Datenbank-Schema v${version} ist neuer als diese Version des Add-ons (v${SCHEMA_VERSION}).`,
    );
  }
  if (version === SCHEMA_VERSION) return;
  // Tabellenumbau (v4) nur ohne Fremdschlüsselprüfung – sonst löscht DROP TABLE per CASCADE
  // abhängige Zeilen. Der Schalter wirkt nur außerhalb einer Transaktion.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      if (version < 1) db.exec(schemaSql());
      if (version < 2) db.exec(MIGRATION_2);
      if (version < 3) db.exec(MIGRATION_3);
      if (version < 4) db.exec(MIGRATION_4);
      if (version < 5) db.exec(MIGRATION_5);
      // Künftige Migrationen: if (version < 5) { ... }
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length > 0) {
        throw new Error(`Migration fehlgeschlagen: ${broken.length} verwaiste Verweise.`);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Führt `fn` in einer Transaktion aus; bei Fehlern wird zurückgerollt. Nicht verschachteln. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
