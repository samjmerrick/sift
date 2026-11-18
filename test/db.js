// Test helper: a fresh database with the real migrations applied (plus a stub of Supabase's roles).
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';

export const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sift_test';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

export async function freshDb() {
  const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  await sql.unsafe('drop schema if exists private cascade; drop schema if exists public cascade; create schema public;');
  await sql.unsafe(read('test/supabase-stub.sql'));
  for (const f of readdirSync(new URL('../supabase/migrations', import.meta.url)).sort()) {
    await sql.unsafe(read(`supabase/migrations/${f}`));
  }
  await sql`insert into app_owner (user_id) values (${OWNER})`;
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
