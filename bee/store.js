// Direct access to the personal database's SQLite file, for what runs on bee (server, fetch, import).
// The bee-database server keeps its full-text index up to date with triggers, so plain inserts and updates here
// are searchable straight away. Needs Node 22.13+ (node:sqlite).
import { DatabaseSync } from 'node:sqlite';
import { PROJECT, KEYS, recordId, toRecord } from './records.js';

export function openBee(path = process.env.BEE_DB) {
  if (!path) throw new Error('Set BEE_DB to the path of the bee-database SQLite file');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 15000');
  const cols = db.prepare("SELECT name FROM pragma_table_info('records')").all().map((r) => r.name);
  if (!cols.includes('metadata') || !cols.includes('collection')) throw new Error(`${path} doesn't look like a bee-database file (no records table)`);
  const now = () => new Date().toISOString();
  const keyCol = (table) => `$.${KEYS[table] || 'id'}`;

  const q = {
    rows: db.prepare('SELECT id, metadata FROM records WHERE project = ? AND collection = ? ORDER BY n'),
    insert: db.prepare(`INSERT OR IGNORE INTO records (id, project, collection, title, content, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    patch: db.prepare(`UPDATE records SET metadata = json_patch(metadata, ?), title = coalesce(?, title), content = coalesce(?, content), updated_at = ?
      WHERE project = ? AND collection = ? AND json_extract(metadata, ?) = ?`),
    remove: db.prepare('DELETE FROM records WHERE project = ? AND collection = ? AND json_extract(metadata, ?) = ?'),
    maxId: db.prepare("SELECT max(json_extract(metadata, '$.id')) AS m FROM records WHERE project = ? AND collection = ?"),
    get: db.prepare('SELECT metadata FROM records WHERE project = ? AND collection = ? AND json_extract(metadata, ?) = ? ORDER BY n DESC LIMIT 1'),
    version: db.prepare('PRAGMA data_version'),
    count: db.prepare('SELECT collection, count(*) AS n FROM records WHERE project = ? GROUP BY collection'),
  };

  return {
    db,
    /** All rows of a Sift table. */
    rows: (table) => q.rows.all(PROJECT, table).map((r) => JSON.parse(r.metadata)),
    /** One row by its key, or null. */
    get(table, key) { const r = q.get.get(PROJECT, table, keyCol(table), key); return r ? JSON.parse(r.metadata) : null; },
    /** Changes whenever another connection (the bee-database server, a cron run) commits a write. */
    dataVersion: () => q.version.get().data_version,
    /** Add a row (ignored if a row with the same key was imported before). Returns true if it was added. */
    insert(table, row) {
      const r = toRecord(table, row);
      const t = now();
      return q.insert.run(recordId(table, row), PROJECT, table, r.title, r.content, JSON.stringify(r.tags), JSON.stringify(row), t, t).changes > 0;
    },
    /** Merge fields into a row (JSON merge patch: a null value removes the field). */
    patch(table, key, fields, { title = null, content = null } = {}) {
      return q.patch.run(JSON.stringify(fields), title, content, now(), PROJECT, table, keyCol(table), key).changes;
    },
    remove: (table, key) => q.remove.run(PROJECT, table, keyCol(table), key).changes,
    nextId: (table) => (Number(q.maxId.get(PROJECT, table)?.m) || 0) + 1,
    counts: () => Object.fromEntries(q.count.all(PROJECT).map((r) => [r.collection, r.n])),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
