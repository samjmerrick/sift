// Load rows exported from another copy of Sift: node server/import.js <db file> <rows.json>...
// Each file is {"table": [row, ...]} with column values as stored. Rows replace any with the same key.
import { readFileSync } from 'node:fs';
import { openDb } from './db.js';

const ORDER = ['topics', 'sources', 'items', 'generators', 'decks', 'cards', 'saved_cards', 'muted_domains', 'app_settings', 'item_content'];
const [file, ...inputs] = process.argv.slice(2);
if (!file || !inputs.length) { console.error('Usage: node server/import.js <db file> <rows.json>...'); process.exit(1); }

const tables = {};
for (const input of inputs) {
  for (const [table, rows] of Object.entries(JSON.parse(readFileSync(input, 'utf8')))) {
    if (!ORDER.includes(table)) throw new Error(`unknown table ${table}`);
    (tables[table] ??= []).push(...rows);
  }
}
const db = openDb(file);
const statements = ORDER.flatMap((table) => (tables[table] ?? []).map((row) => {
  const keys = Object.keys(row);
  if (!keys.every((k) => /^[a-z_]+$/.test(k))) throw new Error(`bad column in ${table}`);
  // An upsert, not OR REPLACE: replacing a parent row would delete its children.
  const key = { muted_domains: 'domain', app_settings: 'key', item_content: 'item_id' }[table] ?? 'id';
  return db.prepare(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
    ON CONFLICT ("${key}") DO UPDATE SET ${keys.map((k) => `"${k}" = excluded."${k}"`).join(', ')}`).bind(...keys.map((k) => row[k]));
}));
await db.batch(statements);
for (const table of ORDER) console.log(`${table}: ${(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n}`);
db.close();
