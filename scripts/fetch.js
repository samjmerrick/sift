// Fetch all enabled sources into the database once, from your own machine (the deployed app does this hourly
// inside Supabase). Needs DATABASE_URL: the Supabase *Session pooler* connection string (Project → Connect).
import postgres from 'postgres';
import { fetchAll } from '../supabase/functions/_shared/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false, onnotice: () => {} });
try {
  const results = await fetchAll(sql);
  let errors = 0;
  for (const [name, r] of Object.entries(results)) {
    if (r.error) errors++;
    console.log(`${name.padEnd(28)} ${r.error ? `ERROR: ${r.error}` : `+${r.added}`}`);
  }
  if (errors && errors === Object.keys(results).length) process.exitCode = 1; // everything failed: surface it in Actions
} finally {
  await sql.end();
}
