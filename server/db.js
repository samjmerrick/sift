// Sift's database: one SQLite file, behind the small D1-style interface (prepare/bind/first/all/batch) the query code uses.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const all = (sql, args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map((x) => (x === undefined ? null : x))),
    first: async () => all(sql, args)[0] ?? null,
    all: async () => ({ results: all(sql, args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    results: () => all(sql, args),
  });
  return {
    prepare: (sql) => stmt(sql),
    // Synchronous inside, so nothing else can run between BEGIN and COMMIT.
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => ({ results: s.results() }));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
