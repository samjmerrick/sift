// Edge Function used by the Settings screen: preview a source, fetch one source, or fetch everything now.
// The hourly fetch runs in GitHub Actions (scripts/fetch.js) using the same shared code.
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { previewSource } from '../_shared/fetcher.js';
import { fetchSource, fetchAll } from '../_shared/store.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 3, prepare: false });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Only signed-in users (with sign-ups disabled, that's just you).
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return json({ error: 'Not signed in' }, 401);

  try {
    const body = await req.json();
    switch (body.action) {
      case 'preview':
        return json((await previewSource(body.source)).slice(0, 15));
      case 'fetch_source': {
        const [src] = await sql`select * from sources where id = ${Number(body.id)}`;
        if (!src) return json({ error: 'Source not found' }, 404);
        return json(await fetchSource(sql, src));
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
