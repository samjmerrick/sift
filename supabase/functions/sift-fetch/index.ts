// Edge Function:
//  - called by the Settings screen (as the signed-in owner): preview a source, fetch one source, fetch everything now;
//  - called hourly by pg_cron (see migration *_cron.sql) with a secret kept in Supabase Vault: fetch everything.
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { previewSource } from '../_shared/fetcher.js';
import { getContent } from '../_shared/reader.js';
import { fetchSource, fetchAll, enrichSummaries } from '../_shared/store.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 3, prepare: false });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Hourly job from pg_cron.
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    const [row] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'sift_cron_secret'`;
    if (!row?.decrypted_secret || !safeEqual(cronSecret, row.decrypted_secret)) return json({ error: 'Bad cron secret' }, 401);
    const results = await fetchAll(sql, { enrich: false });
    await enrichSummaries(sql, 12);
    return json(results);
  }

  // Only the owner account (see app_owner in the schema).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return json({ error: 'Not signed in' }, 401);
  const [owner] = await sql`select 1 from app_owner where user_id = ${data.user.id}`;
  if (!owner) return json({ error: 'This account is not the owner of this Sift' }, 403);

  try {
    const body = await req.json();
    switch (body.action) {
      case 'preview':
        return json((await previewSource(body.source)).slice(0, 15).map(({ content_html: _, ...rest }) => rest));
      case 'fetch_source': {
        const [src] = await sql`select * from sources where id = ${Number(body.id)}`;
        if (!src) return json({ error: 'Source not found' }, 404);
        return json(await fetchSource(sql, src));
      }
      case 'read': {
        const id = Number(body.id);
        if (!Number.isInteger(id)) return json({ error: 'Item not found' }, 404);
        const [item] = await sql`select id, url, summary, comments_url, title from items where id = ${id}`;
        if (!item) return json({ error: 'Item not found' }, 404);
        return json(await getContent(sql, id));
      }
      case 'fetch_all':
        return json(await fetchAll(sql, { enrich: false }));
      default:
        return json({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
