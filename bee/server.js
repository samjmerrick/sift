// Sift on bee: serves the app at /sift and the API it talks to, with the data in bee-database.
//
// The API answers the same HTTP calls as Supabase (the PostgREST subset and the sift-fetch function that the app's
// supabase-js client makes), so the app is the same code as the Supabase build. Rows are records in the `sift`
// project of bee-database, read and written over its MCP endpoint with a service token (bee/store.js) and held in
// memory for queries (preview/mock-backend.js). People and roles are the database's, as for Nibble: sign-in happens
// there (/auth/web/login) and each request asks GET /auth/whoami who is signed in. Viewers of `sift` can read;
// editors (and admins) can change things. Fetching runs here every hour, and on demand from Settings.
//
// Environment:
//   DB_TOKEN        bearer token for bee-database (its MCP_API_TOKEN, or another admin token). Required.
//   DB_URL          bee-database's base URL (default http://mcp-db:8000)
//   DB_MCP_URL      its MCP endpoint (default DB_URL/mcp/db)
//   PUBLIC_URL      the address people use, e.g. https://home.samjmerrick.com (for the Origin check)
//   PORT            default 8000
//   SIFT_FETCH_MINUTES    how often to fetch every source; default 60, 0 turns it off
//   SIFT_REFRESH_SECONDS  how often at most to look for writes made elsewhere; default 2
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDb, createMockFetch } from '../preview/mock-backend.js';
import { previewSource } from '../supabase/functions/_shared/fetcher.js';
import { openBee, MIRRORED } from './store.js';
import { dbUrl } from './dbclient.js';
import { PROJECT, rowKey, toRecord } from './records.js';
import { fetchSources, fetchAll, getContent } from './jobs.js';

const PORT = Number(process.env.PORT) || 8000;
const PREFIX = '/sift';
const DB_URL = dbUrl();
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const FETCH_MINUTES = process.env.SIFT_FETCH_MINUTES == null ? 60 : Number(process.env.SIFT_FETCH_MINUTES);
const REFRESH_MS = (process.env.SIFT_REFRESH_SECONDS == null ? 2 : Number(process.env.SIFT_REFRESH_SECONDS)) * 1000;
if (!process.env.DB_TOKEN) { console.error('Set DB_TOKEN'); process.exit(1); }

// ---- data: bee-database, mirrored in memory ----
let bee;
let db;
function load() {
  db = createDb({ onChange });
  for (const table of MIRRORED) db.load(table, bee.rows(table));
}
/** Send the in-memory backend's changes to the database (merge patches for updates, so concurrent edits survive). */
function onChange(op, table, row, patch) {
  if (table === 'item_content') return; // reader text is stored by jobs.js, never through the API
  const key = rowKey(table, row);
  if (op === 'insert') bee.insert(table, row);
  else if (op === 'update') {
    const { title, content } = toRecord(table, row);
    bee.patch(table, key, patch || row, { title, content });
  } else if (op === 'delete') {
    bee.remove(table, key);
    if (table === 'items') bee.remove('item_content', key);
  }
}
/** Pick up writes made by anything else since we last looked. */
let looked = 0;
async function fresh() {
  if (Date.now() - looked < REFRESH_MS) return;
  looked = Date.now();
  if (await bee.refresh()) load();
}
/** Connect, waiting for bee-database if it isn't up yet. */
const ready = (async () => {
  for (let attempt = 1; ; attempt++) {
    try { bee = await openBee(); load(); return; } catch (e) {
      console.warn(`database not ready (${e.message}); retrying`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 20000)));
    }
  }
})();

// ---- who is signed in: bee-database's web sign-in ----
async function whoami(req) {
  if (!req.headers.cookie) return null;
  const r = await fetch(`${DB_URL}/auth/whoami`, { headers: { Cookie: req.headers.cookie }, signal: AbortSignal.timeout(10000) });
  if (r.status === 401) return null;
  if (!r.ok) throw Object.assign(new Error("The database didn't answer."), { status: 502 });
  const info = await r.json();
  const role = info.admin ? 'admin' : info.roles?.[PROJECT];
  return { email: info.email || '', canRead: !!role, canWrite: ['editor', 'manager', 'admin'].includes(role) };
}

// ---- the sift-fetch function ----
async function functions(body) {
  const item = () => db.tables.items.find((i) => i.id === Number(body.id));
  switch (body.action) {
    case 'preview':
      return (await previewSource(body.source)).slice(0, 15).map(({ content_html: _, ...rest }) => rest);
    case 'read': {
      const it = item();
      return it ? getContent(bee, it) : { httpStatus: 404, error: 'Item not found' };
    }
    case 'fetch_source': {
      const src = db.tables.sources.find((s) => s.id === Number(body.id));
      if (!src) return { httpStatus: 404, error: 'Source not found' };
      const r = Object.values(await fetchSources(bee, [src]))[0];
      load();
      return r;
    }
    case 'fetch_all': {
      const results = await fetchSources(bee);
      load();
      return results;
    }
    default:
      return { httpStatus: 400, error: 'Unknown action' };
  }
}

// ---- HTTP ----
const api = createMockFetch({ get tables() { return db.tables; }, get views() { return db.views; }, insert: (...a) => db.insert(...a),
  remove: (...a) => db.remove(...a), changed: (...a) => db.changed(...a), feedState: (...a) => db.feedState(...a) }, { functions });
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...headers });
  res.end(body);
};
const redirect = (res, status, location) => { res.writeHead(status, { Location: location }); res.end(); };

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The app's page, for signed-in people with a role in `sift`. */
async function page(req, res) {
  const who = await whoami(req);
  if (!who) return redirect(res, 303, `/auth/web/login?next=${PREFIX}/`);
  if (!who.canRead) {
    return html(res, 403, `<!doctype html><meta charset=utf-8><title>Sift</title><p>${escape(who.email || 'This account')} `
      + "hasn't been given access to Sift. Ask Sam to add you.</p>");
  }
  const doc = await readFile(join(PUBLIC, 'index.html'), 'utf8');
  // The page shares its origin with the database and its sign-in cookie, so only our own scripts may run.
  const inline = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return html(res, 200, doc, { 'Content-Security-Policy': `script-src 'self' ${inline.join(' ')}; object-src 'none'; base-uri 'none'` });
}

/** The app's static files (public/): the same code that is public on GitHub, so no sign-in needed. */
async function asset(res, pathname) {
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    return res.end("window.SIFT_CONFIG = { supabaseUrl: location.origin + '/sift', supabaseKey: 'bee', bee: true };");
  }
  const file = normalize(join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { message: 'forbidden' });
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { send(res, 404, { message: 'not found' }); }
}

async function apiCall(req, res, path, search) {
  const who = await whoami(req);
  if (!who || !who.canRead) return send(res, 401, { message: 'Not signed in', code: 'PGRST301' });
  const reading = ['GET', 'HEAD'].includes(req.method) || path === '/rest/v1/rpc/feed_state';
  const chunks = [];
  if (!['GET', 'HEAD'].includes(req.method)) {
    // Browsers send Origin on writes; another site must not be able to use the signed-in cookie.
    const origin = req.headers.origin;
    if (origin && origin !== PUBLIC_URL) return send(res, 403, { message: 'Wrong origin' });
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 5_000_000) return send(res, 413, { message: 'Too much data in one request' });
      chunks.push(c);
    }
  }
  const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  // A viewer can open articles (action "read"); everything else that isn't a read needs an editor.
  let viewerAllowed = reading;
  if (path === '/functions/v1/sift-fetch') { try { viewerAllowed = JSON.parse(raw).action === 'read'; } catch { /* refused below */ } }
  if (!viewerAllowed && !who.canWrite) return send(res, 403, { message: "Your account can't change things in Sift." });
  await ready;
  await fresh();
  const r = await api(`http://bee${path}${search}`, { method: req.method, headers: req.headers, body: raw });
  const out = await r.text();
  try { await bee.flush(); } catch (e) { load(); throw e; }
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
  res.end(out);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://bee');
    if (url.pathname === '/health' || url.pathname === `${PREFIX}/health`) return send(res, 200, { ok: true });
    if (url.pathname === PREFIX) return redirect(res, 308, `${PREFIX}/`);
    if (!url.pathname.startsWith(`${PREFIX}/`)) return send(res, 404, { message: 'not found' });
    const path = url.pathname.slice(PREFIX.length);
    if (path.startsWith('/rest/v1/') || path.startsWith('/functions/v1/')) return await apiCall(req, res, path, url.search);
    // The database owns the session; 307 repeats this POST there.
    if (path === '/logout' && req.method === 'POST') return redirect(res, 307, '/auth/web/logout');
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { message: 'method not allowed' });
    if (path === '/' || path === '/index.html') return await page(req, res);
    return await asset(res, path);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { message: err.message });
  }
}).listen(PORT, () => console.log(`Sift on bee: http://localhost:${PORT}${PREFIX}/`));

// ---- hourly fetch ----
let running = false;
async function hourly() {
  if (running) return;
  running = true;
  try {
    await ready;
    await bee.flush();
    if (await bee.refresh({ all: true })) load();
    const { results, summaries, removed } = await fetchAll(bee);
    const added = Object.values(results).reduce((s, r) => s + r.added, 0);
    const errors = Object.values(results).filter((r) => r.error).length;
    console.log(`${new Date().toISOString()} fetch: ${added} new from ${Object.keys(results).length} sources (${errors} failed), ${summaries} summaries, ${removed} removed`);
    load();
  } catch (e) { console.error('fetch failed', e); } finally { running = false; }
}
if (FETCH_MINUTES > 0) {
  setTimeout(hourly, 30000);
  setInterval(hourly, FETCH_MINUTES * 60000);
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => { try { await bee?.close(); } finally { process.exit(0); } });
}
