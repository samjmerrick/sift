// Local development server: serves the app plus a *minimal* stand-in for the Supabase APIs the app uses
// (PostgREST subset, password sign-in, the sift-fetch function), backed by a local Postgres with the real
// migrations and row level security. For UI work and end-to-end tests only — production uses real Supabase.
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/sift_dev npm run dev
//   (add RESET_DB=1 to wipe and re-apply migrations)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { previewSource } from '../supabase/functions/_shared/fetcher.js';
import { getContent } from '../supabase/functions/_shared/reader.js';
import { fetchSource, fetchAll } from '../supabase/functions/_shared/store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(root, 'public');
const PORT = Number(process.env.PORT) || 5173;
// Like PostgREST, return bigint columns as JSON numbers.
const bigintAsNumber = { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) };
const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sift_dev', { max: 5, onnotice: () => {}, types: { bigint: bigintAsNumber } });

if (process.env.RESET_DB) {
  await sql.unsafe('drop schema if exists private cascade; drop schema if exists public cascade; create schema public;');
  await sql.unsafe(readFileSync(join(root, 'test/supabase-stub.sql'), 'utf8'));
  for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await sql.unsafe(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
  console.log('Database reset and migrations applied.');
}
// The dev "user" owns this local database.
await sql`insert into app_owner (user_id) values ('00000000-0000-0000-0000-000000000001') on conflict do nothing`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw Object.assign(new Error(`bad identifier ${s}`), { status: 400 }); return `"${s}"`; };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const DEV_USER = '00000000-0000-0000-0000-000000000001';
const asUser = (fn) => sql.begin(async (tx) => {
  await tx`set local role authenticated`;
  await tx`select set_config('request.jwt.claim.sub', ${DEV_USER}, true)`;
  return fn(tx);
});

/** Translate PostgREST-style filters (?col=eq.1&id=in.(1,2)&seen_at=is.null) into SQL. */
function where(params, values) {
  const parts = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const col = ident(k);
    const [, neg, op, arg] = /^(not\.)?(eq|neq|in|is|gt|gte|lt|lte)\.(.*)$/.exec(v) || [];
    if (!op) throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { status: 400 });
    let clause;
    if (op === 'is') clause = `${col} is ${arg === 'null' ? 'null' : arg === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') { values.push(arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); clause = `${col}::text = any($${values.length}::text[])`; }
    else {
      values.push(arg);
      const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      clause = op === 'eq' || op === 'neq' ? `${col}::text ${cmp} $${values.length}` : `${col} ${cmp} $${values.length}`;
    }
    parts.push(neg ? `not (${clause})` : clause);
  }
  return parts.length ? ` where ${parts.join(' and ')}` : '';
}
const selectList = (s) => (!s || s === '*' ? '*' : s.split(',').map((c) => ident(c.trim())).join(', '));
function orderBy(s) {
  if (!s) return '';
  return ` order by ${s.split(',').map((part) => {
    const [c, ...mods] = part.split('.');
    return `${ident(c)} ${mods.includes('desc') ? 'desc' : 'asc'}${mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : ''}`;
  }).join(', ')}`;
}

async function rest(req, res, path, params, body) {
  const single = (req.headers.accept || '').includes('vnd.pgrst.object');
  const wantRows = (req.headers.prefer || '').includes('return=representation');
  const reply = (rows, status = 200) => {
    if (single) return rows.length === 1 ? send(res, status, rows[0]) : send(res, 406, { message: `expected 1 row, got ${rows.length}` });
    return send(res, status, rows);
  };
  if (path.startsWith('rpc/')) {
    const fn = ident(path.slice(4));
    const args = Object.keys(body || {});
    const rows = await asUser((tx) => tx.unsafe(`select ${fn}(${args.map((a, i) => `${ident(a)} => $${i + 1}`).join(', ')}) as r`, args.map((a) => body[a])));
    return send(res, 200, rows[0].r);
  }
  const table = ident(path);
  const values = [];
  if (req.method === 'GET') {
    const limit = params.get('limit') ? ` limit ${Number(params.get('limit'))}` : '';
    const rows = await asUser((tx) => tx.unsafe(`select ${selectList(params.get('select'))} from ${table}${where(params, values)}${orderBy(params.get('order'))}${limit}`, values));
    return reply(rows);
  }
  if (req.method === 'POST') {
    const list = Array.isArray(body) ? body : [body];
    const cols = [...new Set(list.flatMap(Object.keys))].map(ident);
    const rows = await asUser((tx) => tx.unsafe(
      `insert into ${table} (${cols.join(', ')}) select ${cols.join(', ')} from json_populate_recordset(null::${table}, $1::json) returning ${selectList(params.get('select'))}`,
      [list]));
    return wantRows ? reply(rows, 201) : send(res, 201);
  }
  if (req.method === 'PATCH') {
    const cols = Object.keys(body).map(ident);
    values.push(body);
    const rows = await asUser((tx) => tx.unsafe(
      `update ${table} set (${cols.join(', ')}) = (select ${cols.join(', ')} from json_populate_record(null::${table}, $1::json))${where(params, values)} returning *`, values));
    return wantRows ? reply(rows) : send(res, 204);
  }
  if (req.method === 'DELETE') {
    await asUser((tx) => tx.unsafe(`delete from ${table}${where(params, values)}`, values));
    return send(res, 204);
  }
  return send(res, 405, { message: 'method not allowed' });
}

const fakeSession = () => {
  const user = { id: DEV_USER, aud: 'authenticated', role: 'authenticated', email: 'dev@localhost' };
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', exp: now + 3600, email: user.email })}.dev`;
  return { access_token: jwt, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'dev-refresh', user };
};

async function functions(res, body) {
  if (body.action === 'preview') return send(res, 200, (await previewSource(body.source)).slice(0, 15).map(({ content_html, ...rest }) => rest));
  if (body.action === 'read') {
    const [item] = await sql`select id from items where id = ${Number(body.id)}`;
    if (!item) return send(res, 404, { error: 'Item not found' });
    return send(res, 200, await getContent(sql, item.id));
  }
  if (body.action === 'fetch_source') {
    const [src] = await sql`select * from sources where id = ${Number(body.id)}`;
    return send(res, 200, await fetchSource(sql, src));
  }
  if (body.action === 'fetch_all') return send(res, 200, await fetchAll(sql, { enrich: false }));
  return send(res, 400, { error: 'Unknown action' });
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    return res.end(`window.SIFT_CONFIG = { supabaseUrl: location.origin, supabaseKey: 'dev' };`);
  }
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    send(res, 404, { message: 'not found' });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
      return res.end();
    }
    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    }
    if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url.pathname.slice(9), url.searchParams, body);
    if (url.pathname === '/auth/v1/token') return send(res, 200, fakeSession());
    if (url.pathname === '/auth/v1/user') return send(res, 200, fakeSession().user);
    if (url.pathname === '/auth/v1/logout') return send(res, 204);
    if (url.pathname === '/functions/v1/sift-fetch') return await functions(res, body || {});
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status || 400, { message: err.message, code: err.code });
  }
}).listen(PORT, () => console.log(`Sift dev server: http://localhost:${PORT}  (any email/password signs in)`));
