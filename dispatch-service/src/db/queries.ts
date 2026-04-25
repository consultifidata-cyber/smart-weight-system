import type Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DispatchDoc {
  doc_id:          string;
  doc_no:          string;
  entry_date:      string;
  truck_no:        string;
  customer_id:     number | null;
  customer_name:   string;
  location:        string | null;
  plant_id:        string;
  shift_id:        string | null;
  delay_reason:    string | null;
  status:          string;
  sync_status:     string;
  idempotency_key: string | null;
  total_bags:      number;
  total_weight_gm: number;
  created_at:      string;
  closed_at:       string | null;
  django_doc_id:   number | null;
  django_doc_no:   string | null;
  sync_error:      string | null;
  last_sync_at:    string | null;
}

export interface DispatchLine {
  line_id:          string;
  doc_id:           string;
  qr_code:          string;
  bag_id:           string | null;
  pack_name:        string | null;
  pack_config_id:   number | null;
  item_id:          number | null;
  actual_weight_gm: number | null;
  source:           string;
  scanned_at:       string;
  synced:           number;
}

export interface FgBagRow {
  bag_id:           string;
  actual_weight_gm: number | null;
  pack_config_id:   number;
  item_id:          number;
  pack_name:        string | null;
  qr_code:          string;
}

export interface SkuSummary {
  pack_name:       string | null;
  bag_count:       number;
  total_weight_gm: number;
}

export interface PartyRow {
  party_id:   number;
  party_name: string;
  party_code: string | null;
  gst_no:     string | null;
  city:       string | null;
}

// ── Queries class ─────────────────────────────────────────────────────────────

export class DispatchQueries {
  private db: Database.Database;

  // ── dispatch_doc statements ────────────────────────────────────────────────
  private _insertDoc!:     Database.Statement;
  private _getDoc!:        Database.Statement;
  private _listDocs!:      Database.Statement;
  private _closeDoc!:      Database.Statement;
  private _updateTotals!:  Database.Statement;
  private _countByDate!:   Database.Statement;

  // ── dispatch_line statements ───────────────────────────────────────────────
  private _insertLine!:        Database.Statement;
  private _getLinesByDoc!:     Database.Statement;
  private _checkQrInDoc!:      Database.Statement;
  private _checkQrOtherDocs!:  Database.Statement;
  private _getSkuSummary!:     Database.Statement;

  // ── fg_bag (read-only) ─────────────────────────────────────────────────────
  private _getBagByQr!:    Database.Statement;

  // ── party_master ───────────────────────────────────────────────────────────
  private _listParties!:   Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this._prepare();
  }

  private _prepare(): void {
    // ── dispatch_doc ────────────────────────────────────────────────────────
    this._insertDoc = this.db.prepare(`
      INSERT INTO dispatch_doc
        (doc_id, doc_no, entry_date, truck_no, customer_id, customer_name,
         location, plant_id, shift_id, delay_reason, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getDoc = this.db.prepare(
      `SELECT * FROM dispatch_doc WHERE doc_id = ?`
    );

    this._listDocs = this.db.prepare(`
      SELECT doc_id, doc_no, entry_date, truck_no, customer_name,
             status, sync_status, total_bags, total_weight_gm,
             created_at, closed_at
      FROM   dispatch_doc
      ORDER  BY created_at DESC
      LIMIT  100
    `);

    this._closeDoc = this.db.prepare(`
      UPDATE dispatch_doc
      SET    status      = 'CLOSED',
             sync_status = 'PENDING',
             closed_at   = ?
      WHERE  doc_id = ? AND status = 'DRAFT'
    `);

    this._updateTotals = this.db.prepare(`
      UPDATE dispatch_doc
      SET    total_bags      = total_bags + 1,
             total_weight_gm = total_weight_gm + ?
      WHERE  doc_id = ?
    `);

    this._countByDate = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM dispatch_doc WHERE entry_date = ?`
    );

    // ── dispatch_line ───────────────────────────────────────────────────────
    this._insertLine = this.db.prepare(`
      INSERT INTO dispatch_line
        (line_id, doc_id, qr_code, bag_id, pack_name, pack_config_id,
         item_id, actual_weight_gm, source, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._getLinesByDoc = this.db.prepare(`
      SELECT line_id, qr_code, bag_id, pack_name, actual_weight_gm, source, scanned_at
      FROM   dispatch_line
      WHERE  doc_id = ?
      ORDER  BY scanned_at DESC
    `);

    this._checkQrInDoc = this.db.prepare(`
      SELECT line_id FROM dispatch_line
      WHERE  doc_id = ? AND qr_code = ?
      LIMIT  1
    `);

    // Check if QR is in any OTHER non-declined dispatch
    this._checkQrOtherDocs = this.db.prepare(`
      SELECT d.doc_no, d.truck_no, d.customer_name
      FROM   dispatch_line  l
      JOIN   dispatch_doc   d ON l.doc_id = d.doc_id
      WHERE  l.qr_code = ?
        AND  d.status  != 'DECLINED'
        AND  d.doc_id  != ?
      LIMIT  1
    `);

    this._getSkuSummary = this.db.prepare(`
      SELECT COALESCE(pack_name, 'Unknown') AS pack_name,
             COUNT(*)                       AS bag_count,
             COALESCE(SUM(actual_weight_gm), 0) AS total_weight_gm
      FROM   dispatch_line
      WHERE  doc_id = ?
      GROUP  BY pack_name
      ORDER  BY pack_name
    `);

    // ── fg_bag (read-only cross-reference) ──────────────────────────────────
    this._getBagByQr = this.db.prepare(`
      SELECT b.bag_id, b.actual_weight_gm, b.pack_config_id, b.item_id, b.qr_code,
             p.pack_name
      FROM   fg_bag         b
      LEFT   JOIN fg_pack_config p ON p.pack_id = b.pack_config_id
      WHERE  b.qr_code = ?
      LIMIT  1
    `);

    // ── party_master ────────────────────────────────────────────────────────
    this._listParties = this.db.prepare(
      `SELECT party_id, party_name, party_code, gst_no, city
       FROM   party_master
       ORDER  BY party_name`
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  createDoc(
    docId: string, docNo: string, entryDate: string, truckNo: string,
    customerId: number | null, customerName: string, location: string | null,
    plantId: string, shiftId: string | null, delayReason: string | null,
    idempotencyKey: string, createdAt: string,
  ): void {
    this._insertDoc.run(
      docId, docNo, entryDate, truckNo, customerId, customerName,
      location, plantId, shiftId, delayReason, idempotencyKey, createdAt,
    );
  }

  getDoc(docId: string): DispatchDoc | undefined {
    return this._getDoc.get(docId) as DispatchDoc | undefined;
  }

  listDocs(): Partial<DispatchDoc>[] {
    return this._listDocs.all() as Partial<DispatchDoc>[];
  }

  closeDoc(docId: string, closedAt: string): number {
    return this._closeDoc.run(closedAt, docId).changes;
  }

  /** Count existing docs on a date — used for sequential doc_no generation */
  countDocsByDate(date: string): number {
    return (this._countByDate.get(date) as { cnt: number }).cnt;
  }

  /** Insert a scan line + update doc totals atomically */
  insertScanLine(
    lineId: string, docId: string, qrCode: string,
    bagId: string | null, packName: string | null,
    packConfigId: number | null, itemId: number | null,
    actualWeightGm: number, source: string, scannedAt: string,
  ): void {
    this.db.transaction(() => {
      this._insertLine.run(
        lineId, docId, qrCode, bagId, packName,
        packConfigId, itemId, actualWeightGm, source, scannedAt,
      );
      this._updateTotals.run(actualWeightGm, docId);
    })();
  }

  getLinesByDoc(docId: string): DispatchLine[] {
    return this._getLinesByDoc.all(docId) as DispatchLine[];
  }

  checkQrInDoc(docId: string, qrCode: string): boolean {
    return !!this._checkQrInDoc.get(docId, qrCode);
  }

  checkQrInOtherDocs(qrCode: string, currentDocId: string): { doc_no: string; truck_no: string; customer_name: string } | undefined {
    return this._checkQrOtherDocs.get(qrCode, currentDocId) as { doc_no: string; truck_no: string; customer_name: string } | undefined;
  }

  getSkuSummary(docId: string): SkuSummary[] {
    return this._getSkuSummary.all(docId) as SkuSummary[];
  }

  getBagByQr(qrCode: string): FgBagRow | undefined {
    return this._getBagByQr.get(qrCode) as FgBagRow | undefined;
  }

  listParties(): PartyRow[] {
    return this._listParties.all() as PartyRow[];
  }
}
