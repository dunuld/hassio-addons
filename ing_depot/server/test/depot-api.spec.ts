import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase, SCHEMA_VERSION, transaction, type Database } from '../src/db/database.js';
import {
  DepotService,
  isValidDate,
  localToday,
  normalizeFileName,
  shiftDate,
} from '../src/depot.service.js';
import { FAILED_DIR, IMPORTED_DIR, scanInbox } from '../src/inbox.js';
import {
  BUY_LINES,
  DEPOT_A,
  DEPOT_B,
  DIVIDEND_LINES,
  EUR_DIVIDEND_LINES,
  SELL_LINES,
  STATEMENT_LINES,
  advanceLines,
  exchangeLines,
  fakePdf,
  statementLines,
  realPdf,
  textReader,
  tradeLines,
} from './fixtures.js';

let tmp: string;
let db: Database;
let depot: DepotService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ing-depot-api-'));
  db = openDatabase(':memory:');
  depot = new DepotService(db, {
    documentsDir: join(tmp, 'documents'),
    exemptionCents: 100000,
    today: () => '2026-07-01',
    readPdf: textReader,
  });
  app = createApp({ depot, scanInbox: () => scanInbox(depot, join(tmp, 'inbox')) });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const uploadFiles = (...files: [string, Buffer][]) => {
  const req = request(app).post('/api/documents');
  files.forEach(([name, content]) => req.attach('files', content, name));
  return req;
};

describe('Datenbank', () => {
  it('legt die Datei an, setzt die Schema-Version und lehnt neuere Schemata ab', () => {
    const file = join(tmp, 'sub', 'depot.db');
    const first = openDatabase(file);
    expect(first.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
    first.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    first.close();
    expect(() => openDatabase(file)).toThrow(/neuer als diese Version/);
  });

  it('rollt Transaktionen bei Fehlern zurück', () => {
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO securities (isin, name) VALUES ('X', 'Y')").run();
        throw new Error('Abbruch');
      }),
    ).toThrow('Abbruch');
    expect(db.prepare('SELECT COUNT(*) AS n FROM securities').get()?.['n']).toBe(0);
  });
});

describe('Hilfsfunktionen', () => {
  it('normalisiert Dateinamen', () => {
    expect(normalizeFileName(undefined)).toBe('dokument.pdf');
    expect(normalizeFileName('/pfad/zu/Abrechnung.pdf')).toBe('Abrechnung.pdf');
    expect(normalizeFileName(Buffer.from('Erträge.pdf', 'utf8').toString('latin1'))).toBe(
      'Erträge.pdf',
    );
    expect(normalizeFileName('Erträge.pdf')).toBe('Erträge.pdf');
  });

  it('prüft Datumswerte', () => {
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('28.02.2026')).toBe(false);
    expect(isValidDate(42)).toBe(false);
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Import per Upload', () => {
  it('importiert mehrere Dokumente und erkennt Duplikate', async () => {
    const res = await uploadFiles(
      ['kauf.pdf', fakePdf(BUY_LINES)],
      ['verkauf.pdf', fakePdf(SELL_LINES)],
      ['dividende.pdf', fakePdf(DIVIDEND_LINES)],
      ['auszug.pdf', fakePdf(STATEMENT_LINES)],
      ['kauf-kopie.pdf', fakePdf(BUY_LINES)],
      ['kauf-neu-erzeugt.pdf', fakePdf([...BUY_LINES, 'Seite 1 von 1'])],
      ['unbekannt.pdf', fakePdf(['Kontoauszug'])],
      ['leer.pdf', Buffer.from('')],
    ).expect(200);

    expect(res.body.map((r: { status: string }) => r.status)).toEqual([
      'imported',
      'imported',
      'imported',
      'imported',
      'duplicate',
      'duplicate',
      'failed',
      'failed',
    ]);
    expect(res.body[0].message).toBe('Kauf 3 × iShs Core MSCI World U.ETF');
    expect(res.body[3].message).toBe('Depotauszug mit 2 Positionen');
    expect(res.body[5].message).toContain('gleicher Inhalt');
    expect(res.body[6].message).toContain('Unbekannte Dokumentart');
    expect(res.body[7].message).toContain('keinen lesbaren Text');

    const documents = await request(app).get('/api/documents').expect(200);
    expect(documents.body).toHaveLength(4);
    expect(documents.body[0]).toMatchObject({ type: 'sell', date: '2026-06-20', source: 'upload' });

    const transactions = await request(app).get('/api/transactions?year=2026').expect(200);
    expect(transactions.body.map((t: { type: string }) => t.type)).toEqual([
      'sell',
      'dividend',
      'buy',
    ]);
    expect((await request(app).get('/api/transactions').expect(200)).body).toHaveLength(3);
  });

  it('liest echte PDFs über pdf.js', async () => {
    const real = new DepotService(db, { today: () => '2026-07-01' });
    const result = await real.importPdf(await realPdf(BUY_LINES), 'kauf.pdf');
    expect(result).toMatchObject({ status: 'imported', document: { type: 'buy' } });
    expect(real.documentFile(result.document!.id)).toBeNull();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await real.importPdf(Buffer.from('kein pdf'), 'kaputt.pdf');
    expect(broken).toMatchObject({ status: 'failed', message: 'Die Datei ist keine lesbare PDF.' });
  });

  it('lehnt Uploads ohne Datei, mit zu großer Datei oder falschem Feld ab', async () => {
    const none = await request(app).post('/api/documents').expect(400);
    expect(none.body.code).toBe('NO_FILE');
    const big = await uploadFiles(['gross.pdf', Buffer.alloc(10 * 1024 * 1024 + 1)]).expect(413);
    expect(big.body.code).toBe('FILE_TOO_LARGE');
    const wrong = await request(app)
      .post('/api/documents')
      .attach('datei', Buffer.from('x'), 'x.pdf')
      .expect(400);
    expect(wrong.body.code).toBe('INVALID_UPLOAD');
  });

  it('liefert die Original-PDF aus und löscht Dokumente samt Buchungen', async () => {
    const [imported] = (await uploadFiles(['kauf.pdf', fakePdf(BUY_LINES)]).expect(200)).body;
    const id = imported.document.id;

    const file = await request(app).get(`/api/documents/${id}/file`).expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');

    await request(app).delete(`/api/documents/${id}`).expect(204);
    await request(app).get(`/api/documents/${id}/file`).expect(404);
    await request(app).delete(`/api/documents/${id}`).expect(404);
    await request(app).delete('/api/documents/abc').expect(400);
    expect((await request(app).get('/api/transactions')).body).toEqual([]);
    expect(existsSync(join(tmp, 'documents', `${id}.pdf`))).toBe(false);

    // Ohne Ablage gibt es keine Datei zum Ausliefern
    const noStore = new DepotService(db, { readPdf: textReader });
    const result = await noStore.importPdf(fakePdf(BUY_LINES), 'kauf.pdf');
    await request(app).get(`/api/documents/${result.document!.id}/file`).expect(404);
  });
});

describe('Übersicht', () => {
  it('fasst das Jahr zusammen und meldet Abweichungen zum Depotauszug', async () => {
    await uploadFiles(
      ['kauf.pdf', fakePdf(BUY_LINES)],
      ['verkauf.pdf', fakePdf(SELL_LINES)],
      ['dividende.pdf', fakePdf(DIVIDEND_LINES)],
      ['auszug.pdf', fakePdf(STATEMENT_LINES)],
    ).expect(200);

    const { body } = await request(app).get('/api/overview').expect(200);
    expect(body).toMatchObject({
      year: 2026,
      asOf: '2026-07-01',
      investedGrossCents: 17328,
      dividendsNetCents: 778,
      dividendsGrossCents: 915,
      exemptionCents: 100000,
    });
    // Verkauf: Veräußerungsgewinn laut Bank
    expect(body.realizedCents).toBe(4000);
    expect(body.positions).toHaveLength(2);
    expect(body.positions[0]).toMatchObject({ isin: 'IE00B4L5Y983', quantity: 1, price: 80 });
    expect(body.warnings.join(' ')).toContain('Depotauszug vom 31.12.2025');

    const past = await request(app).get('/api/overview?year=2025').expect(200);
    expect(past.body).toMatchObject({ year: 2025, asOf: '2025-12-31', investedGrossCents: 0 });
    await request(app).get('/api/overview?year=abc').expect(400);
    await request(app).get('/api/transactions?year=1800').expect(400);
  });
});

describe('Startbestand', () => {
  const opening = {
    depotNumber: ' 1234 567 890 ',
    isin: 'us5949181045',
    name: 'Microsoft',
    date: '2020-01-15',
    quantity: 20,
    costCents: 400000,
  };

  it('erfasst und löscht einen Startbestand', async () => {
    const created = await request(app).post('/api/transactions').send(opening).expect(201);
    expect(created.body).toMatchObject({
      type: 'opening',
      depotId: expect.any(Number),
      isin: 'US5949181045',
      name: 'Microsoft',
      documentId: null,
      price: 200,
      totalCents: 400000,
    });
    const overview = depot.overview();
    expect(overview.positions[0]).toMatchObject({ quantity: 20, costCents: 400000 });

    expect(depot.listDepots()).toMatchObject([{ number: DEPOT_A, documentCount: 0 }]);

    await request(app).delete(`/api/transactions/${created.body.id}`).expect(204);
    await request(app).delete(`/api/transactions/${created.body.id}`).expect(404);
    // Depot ohne Dokumente und Buchungen verschwindet
    expect(depot.listDepots()).toEqual([]);
  });

  it('prüft die Eingaben', async () => {
    const post = (patch: object) =>
      request(app)
        .post('/api/transactions')
        .send({ ...opening, ...patch });
    expect((await post({ depotNumber: 'abc' }).expect(400)).body.code).toBe('INVALID_DEPOT');
    expect((await post({ isin: 'XX' }).expect(400)).body.code).toBe('INVALID_ISIN');
    expect((await post({ date: '2020-13-01' }).expect(400)).body.code).toBe('INVALID_DATE');
    expect((await post({ quantity: 0 }).expect(400)).body.code).toBe('INVALID_QUANTITY');
    expect((await post({ costCents: 1.5 }).expect(400)).body.code).toBe('INVALID_COST');
    await request(app).post('/api/transactions').send([]).expect(400);
    // Ohne Namen und mit Einstandswert 0 (z. B. Gratisaktie)
    const free = await post({ name: ' ', costCents: 0 }).expect(201);
    expect(free.body).toMatchObject({ name: 'US5949181045', price: 0 });
  });

  it('löscht importierte Buchungen nur über das Dokument', async () => {
    await uploadFiles(['kauf.pdf', fakePdf(BUY_LINES)]).expect(200);
    const [tx] = depot.listTransactions();
    const res = await request(app).delete(`/api/transactions/${tx!.id}`).expect(400);
    expect(res.body.code).toBe('IMPORTED_TRANSACTION');
  });
});

describe('Kurse', () => {
  beforeEach(async () => {
    await uploadFiles(['kauf.pdf', fakePdf(BUY_LINES)]).expect(200);
  });

  it('übernimmt manuelle Kurse', async () => {
    await request(app).post('/api/securities/IE00B4L5Y983/prices').send({ price: 60 }).expect(204);
    expect(depot.overview().positions[0]).toMatchObject({
      price: 60,
      priceDate: '2026-07-01',
      priceSource: 'manual',
      valueCents: 18000,
    });
    // Erneutes Setzen am selben Tag überschreibt
    await request(app)
      .post('/api/securities/IE00B4L5Y983/prices')
      .send({ price: 61, date: '2026-07-01' })
      .expect(204);
    expect(depot.overview().positions[0]!.price).toBe(61);

    await request(app).post('/api/securities/IE00B4L5Y983/prices').send({ price: -1 }).expect(400);
    await request(app)
      .post('/api/securities/IE00B4L5Y983/prices')
      .send({ price: 5, date: 'gestern' })
      .expect(400);
    await request(app).post('/api/securities/XX0000000000/prices').send({ price: 5 }).expect(404);
  });

  it('hinterlegt und entfernt die Kurs-Entität', async () => {
    const put = (priceEntity: unknown) =>
      request(app).put('/api/securities/IE00B4L5Y983').send({ priceEntity });
    await put(' sensor.msci_world ').expect(204);
    expect(depot.priceEntities()).toEqual([{ isin: 'IE00B4L5Y983', entity: 'sensor.msci_world' }]);
    expect(depot.overview().positions[0]!.priceEntity).toBe('sensor.msci_world');
    expect((await put('Kein Sensor').expect(400)).body.code).toBe('INVALID_ENTITY');
    await put(null).expect(204);
    expect(depot.priceEntities()).toEqual([]);
    await request(app).put('/api/securities/XX0000000000').send({}).expect(404);
  });

  it('stellt Online-Abruf und Yahoo-Kürzel je Wertpapier ein', async () => {
    const put = (update: object) => request(app).put('/api/securities/IE00B4L5Y983').send(update);
    const position = () => depot.overview().positions[0]!;
    expect(position()).toMatchObject({
      onlinePrices: true,
      priceSymbol: null,
      resolvedSymbol: null,
    });

    depot.setResolvedSymbol('IE00B4L5Y983', 'IWDA.L');
    expect(position().resolvedSymbol).toBe('IWDA.L');
    await put({ priceSymbol: ' EUNL.DE ', onlinePrices: false }).expect(204);
    // Ein eigenes Kürzel verwirft das ermittelte
    expect(position()).toMatchObject({
      onlinePrices: false,
      priceSymbol: 'EUNL.DE',
      resolvedSymbol: null,
    });
    expect(depot.onlineSecurities()).toEqual([]);

    await put({ priceSymbol: '', onlinePrices: true }).expect(204);
    expect(position()).toMatchObject({ onlinePrices: true, priceSymbol: null });
    expect(depot.onlineSecurities()).toEqual([
      { isin: 'IE00B4L5Y983', name: 'iShs Core MSCI World U.ETF', symbol: null, resolved: null },
    ]);
    await put({ priceSymbol: null }).expect(204);

    expect((await put({ priceSymbol: 'mit leerzeichen' }).expect(400)).body.code).toBe(
      'INVALID_SYMBOL',
    );
    expect((await put({ onlinePrices: 'ja' }).expect(400)).body.code).toBe('INVALID_ONLINE');
  });

  it('speichert Online-Kurse ohne Einzelmeldung und prüft Zeiträume', () => {
    const listener = vi.fn();
    depot.onChange(listener);
    depot.storeOnlinePrice('IE00B4L5Y983', '2025-12-30', 61.5);
    expect(listener).not.toHaveBeenCalled();
    expect(depot.hasPriceBetween('IE00B4L5Y983', '2025-12-21', '2025-12-31')).toBe(true);
    expect(depot.hasPriceBetween('IE00B4L5Y983', '2024-12-21', '2024-12-31')).toBe(false);
    depot.notifyChanged();
    expect(listener).toHaveBeenCalledOnce();
    expect(depot.overview(2026).positions[0]).toMatchObject({ priceSource: 'document' });
    // Gleicher Tag: Online-Kurs schlägt den Kurs aus dem Dokument
    depot.storeOnlinePrice('IE00B4L5Y983', '2026-03-15', 58);
    expect(depot.overview(2026).positions[0]).toMatchObject({ price: 58, priceSource: 'yahoo' });
  });

  it('meldet Änderungen an Zuhörer', () => {
    const listener = vi.fn();
    depot.onChange(listener);
    depot.addPrice('IE00B4L5Y983', { price: 70 });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('Eingangsordner', () => {
  it('importiert PDFs, verschiebt sie und merkt sich nicht erkannte Dateien', async () => {
    const inbox = join(tmp, 'inbox');
    // Ordner fehlt noch: kein Fehler
    expect((await request(app).post('/api/inbox/scan').expect(200)).body).toEqual([]);

    mkdirSync(join(inbox, FAILED_DIR), { recursive: true });
    writeFileSync(join(inbox, FAILED_DIR, 'unbekannt.pdf'), 'alt');
    writeFileSync(join(inbox, 'kauf.pdf'), fakePdf(BUY_LINES));
    writeFileSync(join(inbox, 'kauf2.PDF'), fakePdf(tradeLines({ order: '999.001' })));
    writeFileSync(join(inbox, 'unbekannt.pdf'), fakePdf(['Kontoauszug']));
    writeFileSync(join(inbox, 'notiz.txt'), 'kein PDF');

    const res = await request(app).post('/api/inbox/scan').expect(200);
    expect(res.body.map((r: { status: string }) => r.status)).toEqual([
      'imported',
      'imported',
      'failed',
    ]);
    expect(readdirSync(inbox).sort()).toEqual([FAILED_DIR, IMPORTED_DIR, 'notiz.txt']);
    expect(readdirSync(join(inbox, IMPORTED_DIR)).sort()).toEqual(['kauf.pdf', 'kauf2.PDF']);
    expect(readdirSync(join(inbox, FAILED_DIR)).sort()).toEqual([
      'unbekannt-1.pdf',
      'unbekannt.pdf',
    ]);
    expect(depot.listDocuments().every((d) => d.source === 'inbox')).toBe(true);

    const failures = await request(app).get('/api/import-failures').expect(200);
    expect(failures.body).toHaveLength(1);
    expect(failures.body[0]).toMatchObject({ fileName: 'unbekannt.pdf' });
    await request(app).delete(`/api/import-failures/${failures.body[0].id}`).expect(204);
    await request(app).delete(`/api/import-failures/${failures.body[0].id}`).expect(404);

    // Alle auf einmal ausblenden
    depot.addFailure('a.pdf', 'Unbekannt');
    depot.addFailure('b.pdf', 'Unbekannt');
    expect(depot.clearFailures()).toBe(2);
    await request(app).delete('/api/import-failures').expect(204);
    expect((await request(app).get('/api/import-failures').expect(200)).body).toEqual([]);
  });

  it('antwortet ohne konfigurierten Eingangsordner mit einer leeren Liste', async () => {
    const plain = createApp({ depot });
    expect((await request(plain).post('/api/inbox/scan').expect(200)).body).toEqual([]);
  });
});

describe('Depots', () => {
  const statementB = statementLines(
    '31.12.2025',
    [
      {
        quantity: '4',
        name: 'Microsoft Corp.',
        isin: 'US5949181045',
        price: '400,00',
        value: '1.600,00',
      },
    ],
    DEPOT_B,
  );

  it('ordnet Dokumente anhand der Depotnummer zu und filtert danach', async () => {
    await uploadFiles(
      ['kauf.pdf', fakePdf(BUY_LINES)],
      ['kauf-b.pdf', fakePdf(tradeLines({ depot: DEPOT_B }))],
      ['auszug-b.pdf', fakePdf(statementB)],
      ['ohne-nummer.pdf', fakePdf(BUY_LINES.filter((l) => !l.startsWith('Direkt-Depot')))],
    ).expect(200);

    const depots = (await request(app).get('/api/depots').expect(200)).body;
    expect(depots).toMatchObject([
      { number: DEPOT_A, displayName: `Depot ${DEPOT_A}`, documentCount: 1, statements: [] },
      { number: DEPOT_B, documentCount: 2, statements: [{ date: '2025-12-31' }] },
      { number: '', displayName: 'Depot ohne Nummer', documentCount: 1 },
    ]);
    const [a, b] = depots;

    const docsB = (await request(app).get(`/api/documents?depot=${b.id}`).expect(200)).body;
    expect(docsB.map((d: { depotName: string }) => d.depotName)).toEqual([
      `Depot ${DEPOT_B}`,
      `Depot ${DEPOT_B}`,
    ]);
    const txA = (await request(app).get(`/api/transactions?depot=${a.id}`).expect(200)).body;
    expect(txA).toHaveLength(1);
    await request(app).get('/api/transactions?depot=x').expect(400);

    const overviewB = (await request(app).get(`/api/overview?depot=${b.id}`).expect(200)).body;
    expect(overviewB).toMatchObject({ depotId: b.id, investedGrossCents: 17328 });
    const all = (await request(app).get('/api/overview').expect(200)).body;
    expect(all).toMatchObject({ depotId: null, investedGrossCents: 3 * 17328 });
    // Hinweise tragen den Depotnamen
    expect(all.warnings.some((w: string) => w.startsWith(`Depot ${DEPOT_B}: `))).toBe(true);
    await request(app).get('/api/overview?depot=999').expect(404);
  });

  it('benennt Depots um und setzt einen Depotauszug als Startpunkt', async () => {
    const buyB = tradeLines({
      depot: DEPOT_B,
      isin: 'US5949181045',
      name: 'Microsoft Corp.',
      quantity: '1,00',
      price: '420,00',
      gross: '420,00',
      fee: '0,00',
      total: '420,00',
    });
    await uploadFiles(
      ['kauf-a.pdf', fakePdf(BUY_LINES)],
      ['auszug-b.pdf', fakePdf(statementB)],
      ['kauf-b.pdf', fakePdf(buyB)],
    ).expect(200);
    const [a, b] = depot.listDepots();
    const statementId = b!.statements[0]!.id;

    // Ohne Startpunkt fehlen die 4 Stück aus dem Auszug
    expect(depot.overview(2026, b!.id).positions[0]).toMatchObject({ quantity: 1 });

    const updated = await request(app)
      .put(`/api/depots/${b!.id}`)
      .send({ label: '  Gemeinschaftsdepot ', startDocumentId: statementId })
      .expect(200);
    expect(updated.body).toMatchObject({
      label: 'Gemeinschaftsdepot',
      displayName: 'Gemeinschaftsdepot',
      startDocumentId: statementId,
      startDate: '2025-12-31',
    });

    expect(depot.overview(2026).startDate).toBe('2025-12-31');
    const overview = depot.overview(2026, b!.id);
    expect(overview.positions[0]).toMatchObject({ quantity: 5, costCents: 160000 + 42000 });
    expect(overview.warnings).toEqual([]);

    // Fremder Depotauszug als Startpunkt ist nicht erlaubt
    const wrong = await request(app)
      .put(`/api/depots/${a!.id}`)
      .send({ startDocumentId: statementId })
      .expect(400);
    expect(wrong.body.code).toBe('INVALID_START');
    await request(app).put('/api/depots/999').send({}).expect(404);

    // Startpunkt zurücksetzen und Bezeichnung entfernen
    await request(app)
      .put(`/api/depots/${b!.id}`)
      .send({ label: null, startDocumentId: null })
      .expect(200);
    expect(depot.listDepots()[1]).toMatchObject({ label: null, startDocumentId: null });

    // Löschen des Auszugs hebt den Startpunkt auf
    depot.updateDepot(b!.id, { startDocumentId: statementId });
    await request(app).delete(`/api/documents/${statementId}`).expect(204);
    expect(depot.listDepots()[1]).toMatchObject({ startDocumentId: null, statements: [] });
  });

  it('lässt Depots mit späterem Startpunkt in früheren Jahren weg', async () => {
    await uploadFiles(
      ['kauf-a.pdf', fakePdf(tradeLines({ date: '15.03.2024' }))],
      ['auszug-b.pdf', fakePdf(statementB)],
    ).expect(200);
    const [, b] = depot.listDepots();
    depot.updateDepot(b!.id, { startDocumentId: b!.statements[0]!.id });
    // Startpunkt 31.12.2025 liegt im Jahr 2025 – also dort enthalten
    // Bewertet mit dem Kurs der Abrechnung (3 × 56,768 €)
    expect(depot.overview(2025).valueCents).toBe(17030 + 160000);
    const early = depot.overview(2024);
    expect(early.investedGrossCents).toBe(17328);
    expect(early.valueCents).toBe(17030);
    expect(early.years).toEqual([2026, 2025, 2024]);
  });
});

describe('Migration', () => {
  it('ordnet Daten aus Schema v1 einem Depot ohne Nummer zu', () => {
    const file = join(tmp, 'alt.db');
    const old = new DatabaseSync(file);
    old.exec(readFileSync(join(import.meta.dirname, '../src/db/schema.sql'), 'utf8'));
    old.exec(`
      INSERT INTO securities (isin, name) VALUES ('IE00B4L5Y983', 'World');
      INSERT INTO documents (type, file_name, sha256, doc_date, content_key, source, summary)
        VALUES ('buy', 'kauf.pdf', 'abc', '2026-01-02', 'k', 'upload', 'Kauf');
      INSERT INTO transactions
          (document_id, type, date, isin, quantity, price, gross_cents, fee_cents, tax_cents, total_cents)
        VALUES (1, 'buy', '2026-01-02', 'IE00B4L5Y983', 1, 10, 1000, 0, 0, 1000);
      INSERT INTO prices (isin, date, price, source) VALUES ('IE00B4L5Y983', '2026-06-30', 12, 'manual');
      PRAGMA user_version = 1;`);
    old.close();

    const migrated = openDatabase(file);
    const service = new DepotService(migrated, { today: () => '2026-07-01' });
    expect(service.listDepots()).toMatchObject([{ number: '', documentCount: 1 }]);
    expect(service.listTransactions()[0]).toMatchObject({ depotId: 1, gainCents: null });
    // v3: Kurse bleiben erhalten, neue Quellen sind möglich
    expect(service.overview(2026).positions[0]).toMatchObject({
      price: 12,
      priceSource: 'manual',
      onlinePrices: true,
    });
    // v4: Fremdschlüssel wieder aktiv, neue Buchungsarten erlaubt, Daten erhalten
    expect(migrated.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    expect(migrated.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
    migrated
      .prepare(
        `INSERT INTO transactions (type, date, isin, quantity, price, gross_cents, fee_cents,
           tax_cents, total_cents, depot_id) VALUES ('advance_lump_sum', '2026-01-02',
           'IE00B4L5Y983', 1, 0, 0, 0, 0, 0, 1)`,
      )
      .run();
    expect(() =>
      migrated.prepare('DELETE FROM securities WHERE isin = ?').run('IE00B4L5Y983'),
    ).toThrow(/FOREIGN KEY/);
    service.storeOnlinePrice('IE00B4L5Y983', '2026-07-01', 13);
    expect(service.overview(2026).positions[0]).toMatchObject({ price: 13, priceSource: 'yahoo' });
    migrated.close();
  });
});

describe('Online-Kurse (API)', () => {
  it('liefert ohne Kursabruf den Status „aus“', async () => {
    const off = {
      mode: 'off',
      intervalMinutes: 15,
      running: false,
      lastRunAt: null,
      lastUpdated: 0,
      lastErrors: [],
    };
    expect((await request(app).get('/api/prices/status').expect(200)).body).toEqual(off);
    expect((await request(app).post('/api/prices/refresh').expect(200)).body).toEqual(off);
  });

  it('liefert Status und stößt den Abruf an', async () => {
    const status = {
      mode: 'daily' as const,
      intervalMinutes: 15,
      running: false,
      lastRunAt: '2026-07-01T20:30:00.000Z',
      lastUpdated: 2,
      lastErrors: [],
    };
    const prices = { status: vi.fn(() => status), run: vi.fn(async () => status) };
    const withPrices = createApp({ depot, prices });
    expect((await request(withPrices).get('/api/prices/status').expect(200)).body).toEqual(status);
    await request(withPrices).post('/api/prices/refresh').expect(200);
    expect(prices.run).toHaveBeenCalledOnce();
  });
});

describe('Umtausch und Vorabpauschale (Import)', () => {
  const NEW_ISIN = 'LU1681043599';
  const statementWithNew = statementLines('31.03.2026', [
    {
      quantity: '10',
      name: 'Neuer ETF',
      isin: NEW_ISIN,
      wkn: 'NEU001',
      price: '55,00',
      value: '550,00',
    },
  ]);
  const oldBuy = tradeLines({
    order: '7.001',
    isin: 'LU0392494562',
    wkn: 'ETF110',
    name: 'Alter Welt-ETF',
    date: '10.03.2025',
    quantity: '10,00',
    price: '46,00',
    gross: '460,00',
    fee: '0,00',
    total: '460,00',
  });

  it('legt das nur per WKN bekannte Ziel als Platzhalter an und ordnet es später zu', async () => {
    const res = await uploadFiles(
      ['kauf-alt.pdf', fakePdf(oldBuy)],
      ['umtausch.pdf', fakePdf(exchangeLines())],
    ).expect(200);
    expect(res.body[1]).toMatchObject({
      status: 'imported',
      message: 'Umtausch 10 × Alter Welt-ETF → WKN NEU001',
      document: { type: 'exchange' },
    });

    const types = depot.listTransactions().map((t) => [t.type, t.isin]);
    expect(types).toEqual(
      expect.arrayContaining([
        ['exchange_out', 'LU0392494562'],
        ['exchange_in', 'WKN:NEU001'],
      ]),
    );
    let overview = depot.overview(2026);
    expect(overview).toMatchObject({ realizedCents: 4000, investedGrossCents: 0 });
    expect(overview.positions[0]).toMatchObject({
      isin: 'WKN:NEU001',
      name: 'WKN NEU001',
      costCents: 50000,
      price: 50,
    });
    expect(overview.warnings.join(' ')).toContain('ISIN ist noch unbekannt');
    // Platzhalter werden nicht online abgefragt
    expect(depot.onlineSecurities().map((s) => s.isin)).toEqual(['LU0392494562']);

    // Depotauszug mit ISIN und WKN → Platzhalter wird übernommen
    await uploadFiles(['auszug.pdf', fakePdf(statementWithNew)]).expect(200);
    overview = depot.overview(2026);
    expect(overview.positions[0]).toMatchObject({
      isin: NEW_ISIN,
      name: 'Neuer ETF',
      quantity: 10,
      costCents: 50000,
      price: 55,
    });
    expect(overview.warnings).toEqual([]);
    expect(depot.listTransactions().some((t) => t.isin.startsWith('WKN:'))).toBe(false);
    expect(
      depot
        .onlineSecurities()
        .map((s) => s.isin)
        .sort(),
    ).toEqual(['LU0392494562', NEW_ISIN]);
  });

  it('nutzt eine bereits bekannte WKN direkt und erkennt Duplikate über die Ordernummer', async () => {
    await uploadFiles(['auszug.pdf', fakePdf(statementWithNew)]).expect(200);
    const res = await uploadFiles(
      ['umtausch.pdf', fakePdf(exchangeLines())],
      ['umtausch-kopie.pdf', fakePdf([...exchangeLines(), 'Seite 2 von 2'])],
    ).expect(200);
    expect(res.body.map((r: { status: string }) => r.status)).toEqual(['imported', 'duplicate']);
    const incoming = depot.listTransactions().find((t) => t.type === 'exchange_in')!;
    expect(incoming).toMatchObject({ isin: NEW_ISIN, quantity: 10, price: 50, totalCents: 50000 });
  });

  it('übernimmt eine im Dokument genannte Ziel-ISIN', async () => {
    const note = `Ihre Anteile wurden im Verhältnis 1:2 in die ISIN ${NEW_ISIN} umgetauscht.`;
    await uploadFiles(['umtausch.pdf', fakePdf(exchangeLines({ note }))]).expect(200);
    const incoming = depot.listTransactions().find((t) => t.type === 'exchange_in')!;
    expect(incoming).toMatchObject({ isin: NEW_ISIN, quantity: 20, price: 25 });
    // Name noch unbekannt – bis ein Dokument ihn liefert
    expect(incoming.name).toBe(NEW_ISIN);
  });

  it('importiert Vorabpauschalen', async () => {
    const res = await uploadFiles(
      ['vorab-0.pdf', fakePdf(advanceLines())],
      [
        'vorab-steuer.pdf',
        fakePdf(
          advanceLines({
            isin: 'DE0002635307',
            name: 'iShares STOXX Europe 600 UCITS ETF',
            amount: '10,00',
            taxes: [['Kapitalertragsteuer 25,00 %', '2,50']],
            total: '2,50',
            charged: true,
          }),
        ),
      ],
    ).expect(200);
    expect(res.body.map((r: { message: string }) => r.message)).toEqual([
      'Vorabpauschale iShs Core MSCI World U.ETF',
      'Vorabpauschale iShares STOXX Europe 600 UCITS ETF',
    ]);
    expect(depot.listDocuments().map((d) => d.type)).toEqual([
      'advance_lump_sum',
      'advance_lump_sum',
    ]);
    const overview = depot.overview(2026);
    expect(overview).toMatchObject({ advanceLumpSumCents: 1000, taxesCents: 250 });
    // Ohne Bestand entsteht keine Position
    expect(overview.positions).toEqual([]);
    expect(depot.listTransactions()[0]).toMatchObject({
      type: 'advance_lump_sum',
      totalCents: expect.any(Number),
    });
  });
});

describe('Dividendenkalender', () => {
  const WORLD = 'IE00B4L5Y983';
  const worldDividend = (zahltag: string) =>
    EUR_DIVIDEND_LINES.map((line) =>
      line
        .replace('ISIN (WKN) DE0008404005 (840400)', `ISIN (WKN) ${WORLD} (A0RPWH)`)
        .replace(
          'Wertpapierbezeichnung Allianz SE',
          'Wertpapierbezeichnung iShs Core MSCI World U.ETF',
        )
        .replace('Zahltag 12.05.2026', `Zahltag ${zahltag}`),
    );

  beforeEach(async () => {
    await uploadFiles(
      ['kauf.pdf', fakePdf(BUY_LINES)],
      ['dividende-usd.pdf', fakePdf(DIVIDEND_LINES)],
      ['dividende-eur.pdf', fakePdf(EUR_DIVIDEND_LINES)],
    ).expect(200);
    depot.replaceDividendEvents(
      WORLD,
      '2025-05-27',
      '2026-07-01',
      [
        { exDate: '2025-06-20', amount: 9, currency: 'EUR' }, // älter als 12 Monate
        { exDate: '2025-09-10', amount: 0.5, currency: 'EUR' },
        { exDate: '2025-12-10', amount: 0.6, currency: 'USD' },
        { exDate: '2026-06-10', amount: 0.4, currency: 'EUR' },
      ],
      '2026-07-01T20:30:00.000Z',
    );
  });

  it('zeigt gezahlte, ausstehende und erwartete Dividenden je Monat', async () => {
    const { body } = await request(app).get('/api/dividends').expect(200);
    expect(body).toMatchObject({
      year: 2026,
      depotId: null,
      isCurrentYear: true,
      paidGrossCents: 7700 + 915,
      paidNetCents: 5670 + 778,
      // 3 Stück × (0,40 ausstehend + 0,50 + 0,60 erwartet)
      expectedGrossCents: 120 + 150 + 180,
      withoutHistory: [],
    });
    const month = (m: number) => body.months[m - 1];
    expect(month(5)).toMatchObject({ paidGrossCents: 7700, expectedGrossCents: 0 });
    expect(month(6).entries).toEqual([
      expect.objectContaining({
        date: '2026-06-10',
        status: 'pending',
        perShare: 0.4,
        grossCents: 120,
        netCents: null,
      }),
      expect.objectContaining({
        date: '2026-06-12',
        status: 'paid',
        isin: 'US5949181045',
        grossCents: 915,
        netCents: 778,
      }),
    ]);
    expect(month(9).entries).toEqual([
      expect.objectContaining({
        date: '2026-09-10',
        status: 'expected',
        quantity: 3,
        grossCents: 150,
      }),
    ]);
    expect(month(12).entries).toEqual([
      expect.objectContaining({ date: '2026-12-10', grossCents: 180 }),
    ]);
    // Die Zahlung vom Juni 2025 liegt vor dem 12-Monats-Fenster
    expect(month(6).expectedGrossCents).toBe(120);
  });

  it('erkennt die Gutschrift zu einem ausstehenden Ex-Tag', async () => {
    await uploadFiles(['world.pdf', fakePdf(worldDividend('20.06.2026'))]).expect(200);
    const calendar = depot.dividendCalendar(2026);
    expect(calendar.months[5]!.entries.map((e) => e.status)).toEqual(['paid', 'paid']);
  });

  it('nennt gehaltene Wertpapiere ohne Dividendenhistorie', () => {
    depot.addOpening({
      depotNumber: '1234567890',
      isin: 'DE0007236101',
      name: 'Siemens AG',
      date: '2025-01-10',
      quantity: 2,
      costCents: 40000,
    });
    depot.updateSecurity(WORLD, { onlinePrices: false });
    expect(depot.dividendCalendar(2026)).toMatchObject({
      withoutHistory: ['iShs Core MSCI World U.ETF', 'Siemens AG'],
      expectedGrossCents: 0,
    });
  });

  it('zeigt für vergangene Jahre nur gezahlte Dividenden und filtert nach Depot', async () => {
    const past = (await request(app).get('/api/dividends?year=2025').expect(200)).body;
    expect(past).toMatchObject({
      year: 2025,
      isCurrentYear: false,
      paidGrossCents: 0,
      expectedGrossCents: 0,
    });
    expect(past.years).toEqual([2026]);
    const [only] = depot.listDepots();
    const filtered = (await request(app).get(`/api/dividends?depot=${only!.id}`).expect(200)).body;
    expect(filtered).toMatchObject({ depotId: only!.id, paidGrossCents: 8615 });
    await request(app).get('/api/dividends?year=abc').expect(400);
  });

  it('verschiebt Ex-Tage um Jahre und Tage', () => {
    expect(shiftDate('2025-02-28', { years: 1 })).toBe('2026-02-28');
    expect(shiftDate('2024-02-29', { years: 1 })).toBe('2025-03-01');
    expect(shiftDate('2026-07-01', { days: -365 })).toBe('2025-07-01');
  });
});
