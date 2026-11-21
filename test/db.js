// Test helper: a fresh database with the real migrations applied (plus a stub of Supabase's roles).
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { installPack } from '../public/lib/packs.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sift_test';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A data layer over plain SQL with the shape installPack uses (the app itself uses supabase-js). */
export const sqlData = (sql) => ({
  topics: () => sql`select * from topics`,
  deckStats: () => sql`select * from decks`,
  nextTopicPosition: async () => (await sql`select coalesce(max(position), 0) + 1 as p from topics`)[0].p,
  update: async (table, id, patch) => { await sql`update ${sql(table)} set ${sql(patch)} where id = ${id}`; },
  setting: async (key, fallback) => (await sql`select value from app_settings where key = ${key}`)[0]?.value ?? fallback,
  insert: async (table, row) => (await sql`insert into ${sql(table)} ${sql(row)} returning *`)[0],
  addCards: async (deckId, rows) => { await sql`insert into cards ${sql(rows.map(([front, back, note = ''], i) => ({ deck_id: deckId, front, back, note, position: i + 1 })))}`; return rows.length; },
});

/** A fresh database with the real migrations; `packs` are names of public/starters/*.json to install as content. */
export async function freshDb({ packs = [] } = {}) {
  const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  await sql.unsafe('drop schema if exists private cascade; drop schema if exists public cascade; create schema public;');
  await sql.unsafe(read('test/supabase-stub.sql'));
  for (const f of readdirSync(new URL('../supabase/migrations', import.meta.url)).sort()) {
    await sql.unsafe(read(`supabase/migrations/${f}`));
  }
  await sql`insert into app_owner (user_id) values (${OWNER})`;
  for (const name of packs) await installPack(sqlData(sql), JSON.parse(read(`public/starters/${name}.json`)));
  return sql;
}

/** Run a query as a signed-in user (role `authenticated` + JWT sub), so row level security applies. */
export const OWNER = '00000000-0000-0000-0000-00000000000a';
export async function asUser(sql, fn, userId = OWNER) {
  return sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
    return fn(tx);
  });
}
