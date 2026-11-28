// Sift as a bee app: the page at /sift/, the PostgREST-style API its supabase-js client calls, and sign-in.
// handle(request) takes and returns web Request/Response objects; server/main.js puts it on a port.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rest, HttpError } from './rest.js';
import { feedState } from './feed.js';

const PREFIX = '/sift';
const DAY = 86400000;
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (body, status = 200, headers = {}) => new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const raw = (text) => new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const redirect = (location, status = 302) => new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store' } });

export function createApp({ db, auth, fetcher, waitMs = 40_000 }) {
  /** Wait for slow work, but not for so long that the connection is dropped; it carries on in the background. */
  async function job(promise) {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, 'Still working in the background. Try again shortly.')), waitMs);
    });
    promise.catch((e) => console.error(e));
    try { return await Promise.race([promise, late]); }
    catch (e) { throw e instanceof HttpError ? e : new HttpError(502, String(e?.message || e).slice(0, 500)); }
    finally { clearTimeout(timer); }
  }

  async function functions(body) {
    switch (body.action) {
      case 'preview':
        if (!body.source || typeof body.source !== 'object') throw new HttpError(400, 'Missing source');
        return job(fetcher.preview({ source: body.source }));
      case 'read': {
        const item = await db.prepare('SELECT id, url, title, summary, image, domain FROM items WHERE id = ?').bind(Number(body.id)).first();
        if (!item) throw new HttpError(404, 'Item not found');
        let row = await db.prepare('SELECT * FROM item_content WHERE item_id = ?').bind(item.id).first();
        if (!row || (row.status === 'failed' && Date.now() - Date.parse(row.fetched_at) > DAY)) row = await job(fetcher.read({ item }));
        const { status, title, byline, site_name, html, text_length, lead_image, error } = row;
        return { status, title: title ?? item.title ?? null, byline, site_name, html, text_length, lead_image, error, url: item.url };
      }
      case 'fetch_source':
        if (!(await db.prepare('SELECT 1 AS x FROM sources WHERE id = ?').bind(Number(body.id)).first())) throw new HttpError(404, 'Source not found');
        return Object.values(await job(fetcher.fetch_source({ id: Number(body.id) })))[0];
      case 'fetch_all':
        return job(fetcher.fetch_all());
      default:
        throw new HttpError(400, 'Unknown action');
    }
  }

  async function api(request, path, search, body) {
    try {
      if (path === '/rest/v1/rpc/feed_state') return raw(await feedState(db, body?.p_day_start));
      if (path === '/functions/v1/sift-fetch') return json(await functions(body ?? {}));
      if (path.startsWith('/rest/v1/rpc/')) return json({ message: `function ${path.slice(13)} not found` }, 404);
      const r = await rest(db, request.method, path.slice('/rest/v1/'.length), new URLSearchParams(search), request.headers, body);
      return json(r.body, r.status);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      // supabase-js reads a function's message from `error`, and PostgREST's from `message`.
      return json(path.startsWith('/functions/') ? { error: e.message } : { message: e.message, code: e.code }, e.status);
    }
  }

  /** A file from public/, or null. */
  async function file(request, path) {
    const full = join(PUBLIC, normalize(path));
    if (!full.startsWith(PUBLIC.endsWith(sep) ? PUBLIC : PUBLIC + sep)) return null;
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return null;
    const body = await readFile(full);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 20)}"`;
    // Always revalidate: Cloudflare would otherwise keep sw.js and friends for hours after a deploy.
    const headers = { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
    if (extname(full) === '.html') {
      // Only the page's own scripts may run: files from this origin, plus the inline ones hashed here.
      const hashes = [...body.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
      headers['Content-Security-Policy'] = `script-src 'self' ${hashes.join(' ')}; object-src 'none'; base-uri 'none'`;
      headers['X-Frame-Options'] = 'DENY';
    }
    if (request.headers.get('if-none-match')?.includes(etag)) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : body, { headers });
  }

  return async function handle(request) {
    const url = new URL(request.url);
    // The page's links are relative, so it must be served at /sift/ (not /sift). Relative, to keep https behind the proxy.
    if (url.pathname === PREFIX) return redirect(`${PREFIX}/${url.search}`, 308);
    if (!url.pathname.startsWith(`${PREFIX}/`)) return json({ message: 'not found' }, 404);
    const path = url.pathname.slice(PREFIX.length);
    const method = request.method;
    const reading = method === 'GET' || method === 'HEAD';

    let body;
    if (!reading) {
      // Browsers send Origin on writes; another site must not be able to use the signed-in cookie.
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== (request.headers.get('host') ?? url.host)) return json({ message: 'Wrong origin' }, 403);
      const text = await request.text();
      if (text.length > 5_000_000) return json({ message: 'Too much data in one request' }, 413);
      // The sign-out call from the page has no JSON body.
      if (path !== '/logout') {
        try { body = text ? JSON.parse(text) : undefined; } catch { return json({ message: 'Body must be JSON', code: 'PGRST102' }, 400); }
      }
    }

    if (path === '/session' && method === 'POST') {
      const r = await auth.signIn(body?.token);
      return r.cookie ? json({ ok: true }, 200, { 'Set-Cookie': r.cookie }) : json({ message: r.error }, r.status);
    }
    if (path === '/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': auth.signedOut });
    if (path === '/config.js') {
      return new Response("window.SIFT_CONFIG = { supabaseUrl: location.origin + '/sift', supabaseKey: 'bee', bee: true };",
        { headers: { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' } });
    }
    if (path.startsWith('/rest/v1/') || path.startsWith('/functions/v1/')) {
      if (!auth.identify(request)) return json({ message: 'Sign in again' }, 401);
      return api(request, path, url.search, body);
    }
    if (!reading) return json({ message: 'method not allowed' }, 405);
    if ((path === '/' || path === '/index.html') && !auth.identify(request)) return redirect(`${PREFIX}/login.html`);
    return (await file(request, path === '/' ? 'index.html' : path.slice(1))) ?? json({ message: 'not found' }, 404);
  };
}
