// Test helper: a fresh database with the real migrations applied (plus a stub of Supabase's roles).
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';

export const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sift_test';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

export async function freshDb() {
  const sql = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  await sql.unsafe('drop schema if exists public cascade; create schema public;');
  await sql.unsafe(read('test/supabase-stub.sql'));
  for (const f of readdirSync(new URL('../supabase/migrations', import.meta.url)).sort()) {
    await sql.unsafe(read(`supabase/migrations/${f}`));
  }
  return sql;
}

/** Run a query as the signed-in user (role `authenticated`), so row level security applies. */
export async function asUser(sql, fn) {
  return sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    return fn(tx);
  });
}
