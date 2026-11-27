// A minimal D1Database over node:sqlite, with the real migrations applied, for tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function localD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const norm = (a) => a.map((x) => (x === undefined ? null : x));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, norm(a)),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    _all: () => db.prepare(sql).all(...args).map((r) => ({ ...r })),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (ss) => { db.exec('BEGIN'); try { const out = ss.map((s) => ({ results: s._all() })); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: (sql) => db.exec(sql),
  };
}
