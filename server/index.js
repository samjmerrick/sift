// Sift as a bee app: the page at /sift, the PostgREST-style API its supabase-js client calls, and the endpoints the
// fetching runner on bee uses. Rows live in this app's D1. People and roles are the gateway's (Cloudflare Access sign-in);
// viewers of `sift` can read, editors can change things. Feeds are fetched by the runner on bee (see runner/).
import { app } from 'bee-kit';
import { rest, applyOps, importRows, HttpError } from './rest.js';
import { feedState } from './feed.js';
import { runJob, claim, finish, tidy } from './jobs.js';

const PREFIX = '/sift';
const LEVEL = { viewer: 1, editor: 2, manager: 3, admin: 9 };
const DAY = 86400000;
const json = (body, status = 200, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const raw = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const html = (body, status = 200, headers = {}) => new Response(body, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...headers } });
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const timingSafeEqual = (a, b) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
};

/** The runner on bee: a bearer token kept as one of the app's secrets. */
async function runnerAuthorised(request, env) {
  const expected = await env.BEE.secret('sift', 'RUNNER_TOKEN');
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  return !!expected && !!given && timingSafeEqual(expected, given);
}

// ---- the runner's endpoints: /sift/_bee/... ----
const SNAPSHOT_ITEMS = `SELECT COALESCE(json_group_array(json(j)), '[]') AS t FROM (SELECT json_object('id', id, 'source_id', source_id, 'topic_id', topic_id,
  'url', url, 'title', title, 'title_key', title_key, 'summary', CASE WHEN summary = '' THEN '' ELSE substr(summary, 1, 1) END, 'image', image,
  'fetched_at', fetched_at, 'seen_at', seen_at, 'saved_at', saved_at) AS j FROM items)`;
const SNAPSHOT_SOURCES = `SELECT COALESCE(json_group_array(json(j)), '[]') AS t FROM (SELECT json_object('id', id, 'topic_id', topic_id, 'kind', kind, 'name', name,
  'config', json(config), 'include', include, 'exclude', exclude, 'weight', weight, 'enabled', json(CASE WHEN enabled THEN 'true' ELSE 'false' END),
  'last_fetched', last_fetched, 'last_error', last_error) AS j FROM sources)`;

async function runnerApi(request, env, path) {
  if (!(await runnerAuthorised(request, env))) return json({ message: 'Not authorised' }, 401);
  const db = env.DB;
  if (path === '/_bee/jobs' && request.method === 'GET') {
    await tidy(db);
    const job = await claim(db, Math.min(Number(new URL(request.url).searchParams.get('wait')) || 15, 20) * 1000);
    return job ? json(job) : json(null);
  }
  const done = /^\/_bee\/jobs\/(\d+)$/.exec(path);
  if (done && request.method === 'POST') {
    await finish(db, Number(done[1]), await request.json());
    return json({ ok: true });
  }
  if (path === '/_bee/snapshot' && request.method === 'GET') {
    const [items, sources] = await Promise.all([db.prepare(SNAPSHOT_ITEMS).first(), db.prepare(SNAPSHOT_SOURCES).first()]);
    return raw(`{"items":${items.t},"sources":${sources.t}}`);
  }
  if (path === '/_bee/apply' && request.method === 'POST') {
    return json({ applied: await applyOps(db, (await request.json()).ops) });
  }
  if (path === '/_bee/import' && request.method === 'POST') {
    return json({ imported: await importRows(db, await request.json()) });
  }
  return json({ message: 'not found' }, 404);
}

// ---- the sift-fetch function ----
async function functions(env, body) {
  const db = env.DB;
  const job = async (kind, input) => {
    const r = await runJob(db, kind, input);
    if (!r.ok) throw new HttpError(r.timedOut ? 504 : 502, r.error);
    return r.result;
  };
  switch (body.action) {
    case 'preview':
      if (!body.source || typeof body.source !== 'object') throw new HttpError(400, 'Missing source');
      return job('preview', { source: body.source });
    case 'read': {
      const item = await db.prepare('SELECT id, url, title, summary, image, domain FROM items WHERE id = ?').bind(Number(body.id)).first();
      if (!item) throw new HttpError(404, 'Item not found');
      let row = await db.prepare('SELECT * FROM item_content WHERE item_id = ?').bind(item.id).first();
      if (!row || (row.status === 'failed' && Date.now() - Date.parse(row.fetched_at) > DAY)) row = await job('read', { item });
      const { status, title, byline, site_name, html: body_, text_length, lead_image, error } = row;
      return { status, title: title ?? item.title ?? null, byline, site_name, html: body_, text_length, lead_image, error, url: item.url };
    }
    case 'fetch_source': {
      if (!(await db.prepare('SELECT 1 AS x FROM sources WHERE id = ?').bind(Number(body.id)).first())) throw new HttpError(404, 'Source not found');
      return Object.values(await job('fetch_source', { id: Number(body.id) }))[0];
    }
    case 'fetch_all':
      return job('fetch_all', {});
    default:
      throw new HttpError(400, 'Unknown action');
  }
}

async function api(request, env, path, search, user) {
  const method = request.method;
  const level = LEVEL[user.role] ?? 0;
  const isRead = method === 'GET' || method === 'HEAD' || path === '/rest/v1/rpc/feed_state';
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    // Browsers send Origin on writes; another site must not be able to use the signed-in cookie.
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return json({ message: 'Wrong origin' }, 403);
    const text = await request.text();
    if (text.length > 5_000_000) return json({ message: 'Too much data in one request' }, 413);
    try { body = text ? JSON.parse(text) : undefined; } catch { return json({ message: 'Body must be JSON', code: 'PGRST102' }, 400); }
  }
  // A viewer can open articles (action "read"); everything else that isn't a read needs an editor.
  const viewerOk = isRead || (path === '/functions/v1/sift-fetch' && body?.action === 'read');
  if (!viewerOk && level < LEVEL.editor) return json({ message: "Your account can't change things in Sift." }, 403);
  try {
    if (path === '/rest/v1/rpc/feed_state') return raw(await feedState(env.DB, body?.p_day_start));
    if (path === '/functions/v1/sift-fetch') return json(await functions(env, body ?? {}));
    if (path.startsWith('/rest/v1/rpc/')) return json({ message: `function ${path.slice(13)} not found` }, 404);
    const r = await rest(env.DB, method, path.slice('/rest/v1/'.length), new URLSearchParams(search), request.headers, body);
    return json(r.body, r.status);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status === 504 || e.status === 502 || e.status === 404 && path.includes('functions') ? { error: e.message } : { message: e.message, code: e.code }, e.status);
    throw e;
  }
}

/** The app's page, with a content security policy that allows only the page's own scripts. */
async function page(request, env, user) {
  if (!(user.role in LEVEL)) return html(`<!doctype html><meta charset=utf-8><title>Sift</title><p>${escape(user.email)} hasn't been given access to Sift. Ask Sam to add you.</p>`, 403);
  const res = await env.ASSETS.fetch(new Request(new URL('/', request.url), { headers: request.headers }));
  const doc = await res.text();
  const hashes = [];
  for (const m of doc.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1]));
    hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`);
  }
  return html(doc, 200, { 'Content-Security-Policy': `script-src 'self' ${hashes.join(' ')}; object-src 'none'; base-uri 'none'` });
}

export default app('sift', {
  // The runner has its own bearer token, so these paths skip the signed-in check.
  open: (pathname) => pathname.startsWith(`${PREFIX}/_bee/`),
  async fetch(request, env, ctx, bee) {
    const url = new URL(request.url);
    // The page's links are relative, so it must be served at /sift/ (not /sift).
    if (url.pathname === PREFIX && bee) return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 308);
    const path = url.pathname.slice(PREFIX.length) || '/';
    if (!bee) return runnerApi(request, env, path);
    if (path.startsWith('/rest/v1/') || path.startsWith('/functions/v1/')) return api(request, env, path, url.search, bee.user);
    if (path === '/config.js') {
      return new Response("window.SIFT_CONFIG = { supabaseUrl: location.origin + '/sift', supabaseKey: 'bee', bee: true };",
        { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    if (path === '/logout' && request.method === 'POST') return Response.redirect(`${url.origin}/cdn-cgi/access/logout`, 303);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ message: 'method not allowed' }, 405);
    if (path === '/' || path === '/index.html') return page(request, env, bee.user);
    return null; // static files from public/
  },
});
