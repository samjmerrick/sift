// Sift's backend on bee: the API the GitHub Pages app talks to, with your data in the personal database.
//
// It answers the same HTTP calls as Supabase (the PostgREST subset, password sign-in and the sift-fetch function
// that the app's supabase-js client makes), so public/ runs unchanged: point config.js's supabaseUrl at this
// server. Rows live in the personal database's SQLite file (one record per row, see bee/records.js) and are kept
// in memory for queries (preview/mock-backend.js); every change is written straight to the file. Writes made by
// anything else (Claude through the connector, a cron run of bee/fetch.js) are picked up on the next request.
// Fetching runs here every hour, and on demand from Settings.
//
//   BEE_DB=/path/to/bee-database.db SIFT_PASSWORD=… SIFT_ORIGIN=https://you.github.io node bee/server.js
//
// Environment:
//   BEE_DB          the bee-database SQLite file (required)
//   SIFT_PASSWORD   the password to sign in with (required)
//   SIFT_EMAIL      the email to sign in with (optional; any email works if unset)
//   SIFT_ORIGIN     where the app is served from, for CORS (e.g. https://samjmerrick.github.io); default *
//   PORT            default 8787
//   SIFT_FETCH_MINUTES  how often to fetch every source; default 60, 0 turns it off
//   SIFT_SERVE_APP  set to 1 to also serve public/ (with a config.js pointing here), for local testing
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { createDb, createMockFetch } from '../preview/mock-backend.js';
import { previewSource } from '../supabase/functions/_shared/fetcher.js';
import { openBee } from './store.js';
import { TABLES, toRecord } from './records.js';
import { fetchSources, fetchAll, getContent } from './jobs.js';

const PORT = Number(process.env.PORT) || 8787;
const PASSWORD = process.env.SIFT_PASSWORD;
const EMAIL = (process.env.SIFT_EMAIL || '').trim().toLowerCase();
const ORIGIN = process.env.SIFT_ORIGIN || '*';
const FETCH_MINUTES = process.env.SIFT_FETCH_MINUTES == null ? 60 : Number(process.env.SIFT_FETCH_MINUTES);
if (!PASSWORD) { console.error('Set SIFT_PASSWORD'); process.exit(1); }

const bee = openBee();

// ---- data: the personal database, mirrored in memory ----
let db;
let version;
function load() {
  db = createDb({ onChange });
  for (const table of TABLES) if (table !== 'item_content') db.load(table, bee.rows(table));
  version = bee.dataVersion();
}
/** Save the in-memory backend's changes to the file (merge patches for updates, so concurrent edits survive). */
function onChange(op, table, row, patch) {
  if (table === 'item_content') return; // reader text is stored by jobs.js, never through the API
  const key = row[{ muted_domains: 'domain', app_settings: 'key' }[table] || 'id'];
  if (op === 'insert') bee.insert(table, row);
  else if (op === 'update') {
    const { title, content } = toRecord(table, row);
    bee.patch(table, key, patch || row, { title, content });
  } else if (op === 'delete') {
    bee.remove(table, key);
    if (table === 'items') bee.remove('item_content', key);
  }
}
/** Reload when something else wrote to the database since we last looked. */
function fresh() { if (bee.dataVersion() !== version) load(); }
load();

// ---- sign-in: one password, HS256 tokens signed with a key derived from it ----
const SECRET = createHash('sha256').update(`sift:${PASSWORD}`).digest();
const USER = { id: '00000000-0000-0000-0000-0000000000be', aud: 'authenticated', role: 'authenticated', email: EMAIL || 'sift@bee' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (s) => createHmac('sha256', SECRET).update(s).digest('base64url');
function token(kind, seconds) {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, role: 'authenticated', email: USER.email, kind, exp: Math.floor(Date.now() / 1000) + seconds })}`;
  return `${head}.${sign(head)}`;
}
function verify(t, kind) {
  const [h, p, s] = String(t || '').split('.');
  if (!h || !p || !s) return false;
  const want = Buffer.from(sign(`${h}.${p}`));
  const got = Buffer.from(s);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  try { const c = JSON.parse(Buffer.from(p, 'base64url').toString()); return c.kind === kind && c.exp > Date.now() / 1000; } catch { return false; }
}
function session() {
  const expires_in = 3600;
  return { access_token: token('access', expires_in), token_type: 'bearer', expires_in, expires_at: Math.floor(Date.now() / 1000) + expires_in,
    refresh_token: token('refresh', 90 * 86400), user: USER };
}
const same = (a, b) => { const x = createHash('sha256').update(String(a)).digest(); const y = createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x, y); };
let failures = [];
function signIn(body) {
  failures = failures.filter((t) => t > Date.now() - 15 * 60000);
  if (failures.length >= 10) return [429, { error: 'too_many_attempts', error_description: 'Too many wrong passwords. Try again in 15 minutes.' }];
  const okEmail = !EMAIL || String(body?.email || '').trim().toLowerCase() === EMAIL;
  if (okEmail && same(body?.password || '', PASSWORD)) return [200, session()];
  failures.push(Date.now());
  return [400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }];
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
const cors = (req) => ({
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const send = (req, res, status, body) => {
  res.writeHead(status, { ...cors(req), 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
async function serveApp(res, pathname) {
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return res.end("window.SIFT_CONFIG = { supabaseUrl: location.origin, supabaseKey: 'bee' };");
  }
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bee');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
    const chunks = [];
    if (!['GET', 'HEAD'].includes(req.method)) for await (const c of req) chunks.push(c);
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const json = () => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

    if (url.pathname === '/health') return send(req, res, 200, { ok: true });
    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') { const [status, body] = signIn(json()); return send(req, res, status, body); }
      if (grant === 'refresh_token') {
        return verify(json().refresh_token, 'refresh') ? send(req, res, 200, session())
          : send(req, res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      }
      return send(req, res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/functions/v1/') || url.pathname.startsWith('/auth/v1/')) {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!verify(bearer, 'access')) return send(req, res, 401, { message: 'Not signed in', code: 'PGRST301' });
      if (url.pathname === '/auth/v1/user') return send(req, res, 200, USER);
      if (url.pathname === '/auth/v1/logout') return send(req, res, 204);
      if (url.pathname.startsWith('/auth/v1/')) return send(req, res, 404, { message: 'not found' });
      fresh();
      const r = await api(`http://bee${req.url}`, { method: req.method, headers: req.headers, body: raw });
      const out = await r.text();
      res.writeHead(r.status, { ...cors(req), 'Content-Type': r.headers.get('content-type') || 'application/json' });
      return res.end(out);
    }
    if (process.env.SIFT_SERVE_APP) return await serveApp(res, url.pathname);
    return send(req, res, 404, { message: 'not found' });
  } catch (err) {
    console.error(err);
    send(req, res, err.status || 500, { message: err.message });
  }
}).listen(PORT, () => console.log(`Sift on bee: http://localhost:${PORT}${process.env.SIFT_SERVE_APP ? ' (serving the app too)' : ''}`));

// ---- hourly fetch ----
let running = false;
async function hourly() {
  if (running) return;
  running = true;
  try {
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
