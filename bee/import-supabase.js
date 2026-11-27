// One-off: copy everything from Sift's Supabase database into bee-database. Safe to run again: rows already
// imported are skipped. Supabase is only read, never changed.
//
//   docker compose exec -e DATABASE_URL='postgres://…' sift node bee/import-supabase.js
//
// DATABASE_URL is the Supabase "Session pooler" connection string (Project → Connect), as for npm run fetch.
// For testing, --json file.json imports { table: [rows] } instead.
import { readFileSync } from 'node:fs';
import { openBee } from './store.js';
import { TABLES } from './records.js';

const ID_COLS = ['id', 'topic_id', 'source_id', 'deck_id', 'item_id'];
const TIME_COLS = ['last_fetched', 'published_at', 'fetched_at', 'seen_at', 'saved_at', 'due', 'introduced_at', 'created_at'];

/** Postgres types → the JSON the app expects: bigint ids as numbers, timestamps as ISO strings. */
function clean(row) {
  const out = { ...row };
  for (const c of ID_COLS) if (out[c] != null) out[c] = Number(out[c]);
  for (const c of TIME_COLS) if (out[c] instanceof Date) out[c] = out[c].toISOString();
  if (out.config && typeof out.config.deck_id === 'string' && /^\d+$/.test(out.config.deck_id)) out.config = { ...out.config, deck_id: Number(out.config.deck_id) };
  return out;
}

async function fromPostgres(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  try {
    const out = {};
    for (const t of TABLES) out[t] = await sql.unsafe(`select * from ${t}`);
    return out;
  } finally { await sql.end(); }
}

const jsonArg = process.argv.indexOf('--json');
const data = jsonArg > 0 ? JSON.parse(readFileSync(process.argv[jsonArg + 1], 'utf8'))
  : process.env.DATABASE_URL ? await fromPostgres(process.env.DATABASE_URL)
  : (console.error('Set DATABASE_URL (Supabase session pooler) or pass --json file'), process.exit(1));

const bee = await openBee();
try {
  const before = bee.counts();
  const had = new Set((await Promise.all((data.item_content || []).map(async (r) => ((await bee.content(r.item_id)) ? Number(r.item_id) : null)))).filter(Boolean));
  for (const t of TABLES) {
    const rows = (data[t] || []).map(clean);
    let n = 0;
    for (const row of rows) {
      if (t === 'item_content' && had.has(row.item_id)) continue;
      if (bee.insert(t, row)) n++;
      if (n % 200 === 0) await bee.flush();
    }
    await bee.flush();
    console.log(`${t.padEnd(14)} ${n} added, ${rows.length - n} already there`);
  }
  console.log('Before:', JSON.stringify(before), '\nAfter: ', JSON.stringify(bee.counts()));
} finally {
  await bee.close();
}
