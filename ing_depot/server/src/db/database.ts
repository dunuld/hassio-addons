import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Kapselt den SQLite-Treiber (node:sqlite). */
export type Database = DatabaseSync;
export type Row = Record<string, unknown>;

export const SCHEMA_VERSION = 3;

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
  transaction(db, () => {
    if (version < 1) db.exec(schemaSql());
    if (version < 2) db.exec(MIGRATION_2);
    if (version < 3) db.exec(MIGRATION_3);
    // Künftige Migrationen: if (version < 4) { ... }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
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
