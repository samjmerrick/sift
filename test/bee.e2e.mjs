// End-to-end check of Sift on bee: bee/import-supabase.js, bee/server.js and the real app (public/) in Chromium,
// against a real, throwaway bee-database. A small proxy plays the part of the tunnel (/sift → Sift, the rest →
// bee-database). Not part of `npm test` (needs Chromium and a running bee-database):
//
//   docker run -d --rm --name sift-test-db -p 127.0.0.1:18871:8000 -e MCP_PASSWORD=test-password \
//     -e MCP_API_TOKEN=test-token -e PUBLIC_URL=http://127.0.0.1:18870 -e SSO_PATHS=/nibble,/sift bee-database-mcp-db
//   npm run preview && node test/bee.e2e.mjs
//   docker stop sift-test-db
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDbClient } from '../bee/dbclient.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'sift-bee-'));
const BEE_PORT = Number(process.env.BEE_PORT) || 18871;
const PROXY_PORT = Number(process.env.PROXY_PORT) || 18870;
const SIFT_PORT = PROXY_PORT + 2;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const DB_URL = `http://127.0.0.1:${BEE_PORT}`;
const env = { ...process.env, DB_URL, DB_TOKEN: process.env.BEE_TOKEN || 'test-token', NODE_NO_WARNINGS: '1' };

const db = createDbClient({ url: `${DB_URL}/mcp/db`, token: env.DB_TOKEN });
const rows = async (collection, filter) => {
  const page = await db.call('list_records', { project: 'sift', collection, include_metadata: true, limit: 200, ...(filter ? { metadata_equals: filter } : {}) });
  return { total: page.total, rows: page.results.map((r) => r.metadata), records: page.results };
};
const count = async (collection, filter) => (await rows(collection, filter)).total;
const where = async (collection, test) => (await rows(collection)).rows.filter(test).length;
const row = async (collection, filter) => (await rows(collection, filter)).rows[0] || null;
const until = async (fn, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 150))) if (await fn()) return true; return false; };
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); };
const run = async (script, args = []) => (await promisify(execFile)('node', [join(root, script), ...args], { env, encoding: 'utf8', timeout: 240000 })).stdout;

// The tunnel.
const proxy = createServer((req, res) => {
  const port = /^\/sift(\/|\?|$)/.test(req.url) ? SIFT_PORT : BEE_PORT;
  const up = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(PROXY_PORT);

const servers = [];
async function startSift(extra) {
  const server = spawn('node', [join(root, 'bee/server.js')], {
    env: { ...env, PUBLIC_URL: BASE, SIFT_FETCH_MINUTES: '0', SIFT_REFRESH_SECONDS: '0', ...extra }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  servers.push(server);
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Sift on bee')) resolve(); }));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) errors.push(m.text()); });
let feed;
try {
  // 1. Import: the preview build's sample tables stand in for a Supabase export.
  const seeder = await browser.newPage();
  await seeder.goto(`file://${root}dist/sift-preview.local.html`);
  await seeder.waitForFunction(() => window.SIFT_PREVIEW?.db?.tables?.items?.length > 0);
  const seed = await seeder.evaluate(() => window.SIFT_PREVIEW.db.tables);
  writeFileSync(join(dir, 'seed.json'), JSON.stringify(seed));
  await seeder.close();
  await run('bee/import-supabase.js', ['--json', join(dir, 'seed.json')]);
  ok(await count('items') === seed.items.length && await count('topics') === seed.topics.length, `import copies every row (${seed.items.length} items)`);
  ok(/topics\s+0 added/.test(await run('bee/import-supabase.js', ['--json', join(dir, 'seed.json')])), 'import is safe to run twice');
  const topicsAtStart = await count('topics');

  // A local feed for "add source" / "fetch now".
  const atom = readFileSync(join(root, 'test/fixtures/atom.xml'), 'utf8').replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());
  feed = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'application/xml' }).end(atom)).listen(0);
  const feedUrl = `http://127.0.0.1:${feed.address().port}/feed.xml`;

  await startSift({ PORT: String(SIFT_PORT) });

  // 2. Access control, and sign-in at the database.
  ok((await fetch(`${BASE}/sift/rest/v1/topics`)).status === 401, 'the API refuses calls without a session');
  const out = await fetch(`${BASE}/sift/`, { redirect: 'manual' });
  ok(out.status === 303 && out.headers.get('location') === '/auth/web/login?next=/sift/', 'a signed-out visitor is sent to the database sign-in');
  ok((await fetch(`${BASE}/sift`, { redirect: 'manual' })).headers.get('location') === '/sift/', '/sift goes to /sift/');
  ok((await fetch(`${BASE}/sift/..%2fbee%2fserver.js`)).status !== 200, 'only public/ is served');

  await page.goto(`${BASE}/sift/`);
  const password = page.locator('input[type=password]');
  if (!(await password.isVisible())) await page.locator('summary').click();
  await password.fill(process.env.BEE_PASSWORD || 'test-password');
  await password.press('Enter');
  await page.waitForSelector('.card h3', { timeout: 20000 });
  ok(page.url().startsWith(`${BASE}/sift/`), `signing in comes back to the feed (first card: "${(await page.locator('.card h3').first().textContent()).trim().slice(0, 50)}")`);
  const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

  // 3. The app writes through to the database.
  const liked = () => where('items', (i) => i.reaction === 1);
  const before = await liked();
  await page.locator('button[aria-label="More like this"][aria-pressed="false"]').first().click();
  ok(await until(async () => await liked() === before + 1), 'a thumbs-up is saved to the database');
  const seen = () => where('items', (i) => i.seen_at);
  const seenBefore = await seen();
  await page.mouse.wheel(0, 4000);
  ok(await until(async () => await seen() > seenBefore), 'scrolling past cards marks them seen in the database');

  const call = (path, { method = 'GET', body, headers = {}, auth = cookie, origin = BASE } = {}) => fetch(`${BASE}/sift${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Cookie: auth, Origin: origin, ...headers },
  });
  ok((await call('/rest/v1/topics', { method: 'POST', body: { name: 'x' }, origin: 'https://evil.example' })).status === 403, 'a write from another origin is refused');

  // 4. Add a topic and a source, preview and fetch it, rename, then delete with its articles.
  const [topic] = await (await call('/rest/v1/topics?select=*', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { name: 'Bee test', color: '#335577', position: 99, kind: 'articles' } })).json();
  ok((await row('topics', { name: 'Bee test' }))?.id === topic.id, 'a new topic is stored with its id');
  const [src] = await (await call('/rest/v1/sources?select=*', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { topic_id: topic.id, kind: 'rss', name: 'Local feed', config: { url: feedUrl } } })).json();
  const preview = await (await call('/functions/v1/sift-fetch', { method: 'POST', body: { action: 'preview', source: src } })).json();
  ok(Array.isArray(preview) && preview.length > 0, `source preview runs the fetcher (${preview.length} items)`);
  const fetched = await (await call('/functions/v1/sift-fetch', { method: 'POST', body: { action: 'fetch_source', id: src.id } })).json();
  ok(fetched.added > 0 && await count('items', { source_id: src.id }) === fetched.added, `fetch now adds articles to the database (+${fetched.added})`);
  const again = await (await call('/functions/v1/sift-fetch', { method: 'POST', body: { action: 'fetch_source', id: src.id } })).json();
  ok(again.added === 0, 'fetching again de-duplicates');
  const listed = await (await call(`/rest/v1/items?select=id,title&source_id=eq.${src.id}`)).json();
  ok(listed.length === fetched.added, 'fetched articles are visible through the API straight away');
  const read = await (await call('/functions/v1/sift-fetch', { method: 'POST', body: { action: 'read', id: listed[0].id } })).json();
  ok(read.status && await count('item_content', { item_id: listed[0].id }) === 1, `reader text is fetched and cached (${read.status})`);
  await call(`/rest/v1/topics?id=eq.${topic.id}`, { method: 'PATCH', body: { name: 'Bee test renamed' } });
  const renamed = await row('topics', { id: topic.id });
  ok(renamed?.name === 'Bee test renamed' && renamed.color === '#335577', 'an update changes only the fields sent');
  await call(`/rest/v1/topics?id=eq.${topic.id}`, { method: 'DELETE' });
  ok(!(await row('topics', { id: topic.id })) && await count('items', { topic_id: topic.id }) === 0
    && await count('item_content', { item_id: listed[0].id }) === 0, 'deleting a topic removes its sources, articles and reader text');
  ok(await count('topics') === topicsAtStart, 'topic count is back where it started');

  // 5. A change made outside Sift (Claude through the connector) shows up on the next request.
  const outside = await db.call('store', { project: 'sift', collection: 'muted_domains', title: 'outside.example', content: 'outside.example', metadata: { domain: 'outside.example' } });
  ok((await (await call('/rest/v1/muted_domains?select=*')).json()).some((m) => m.domain === 'outside.example'), 'writes from outside Sift are picked up');
  await db.call('delete', { id: outside.id });
  ok(!(await (await call('/rest/v1/muted_domains?select=*')).json()).some((m) => m.domain === 'outside.example'), 'and so are deletes');

  // 6. A viewer of sift can read but not change; someone with no role gets nothing. (A stand-in for whoami.)
  let roles = { sift: 'viewer' };
  const who = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ email: 'v@example.com', admin: false, roles }))).listen(0);
  const VIEW_PORT = SIFT_PORT + 1;
  await startSift({ PORT: String(VIEW_PORT), DB_URL: `http://127.0.0.1:${who.address().port}`, DB_MCP_URL: `${DB_URL}/mcp/db` });
  const view = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${VIEW_PORT}/sift${path}`, { method, headers: { Cookie: 'a=b', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  ok((await view('/rest/v1/topics')).status === 200 && (await view('/rest/v1/rpc/feed_state', 'POST', { p_day_start: new Date().toISOString() })).status === 200, 'a viewer can read the feed');
  ok((await view('/rest/v1/topics', 'POST', { name: 'nope' })).status === 403 && (await view('/functions/v1/sift-fetch', 'POST', { action: 'fetch_all' })).status === 403, 'a viewer cannot change or fetch');
  roles = { nibble: 'editor' };
  ok((await view('/')).status === 403 && (await view('/rest/v1/topics')).status === 401, 'someone with no role in sift is refused');
  who.close();

  // 7. Reload, Settings, the command-line fetch, and sign out.
  await page.reload();
  await page.waitForSelector('.card h3', { timeout: 20000 });
  await page.goto(`${BASE}/sift/#/settings`);
  await page.waitForSelector('.row', { timeout: 10000 });
  await page.screenshot({ path: join(dir, 'settings.png') });
  ok(true, 'the app stays signed in after a reload and Settings opens');
  let log;
  // It exits 1 when every source fails, as here without internet; the summary line still prints.
  try { log = await run('bee/fetch.js'); } catch (e) { log = String(e.stdout); }
  log = log.trim().split('\n').pop();
  ok(/new, \d+ summaries checked/.test(log), `bee/fetch.js runs (${log})`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('input[type=password]', { state: 'attached', timeout: 10000 });
  ok(page.url().includes('/auth/web/login') && (await call('/rest/v1/topics')).status === 401, 'sign out ends the session');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nbee e2e passed (${dir})`);
} finally {
  for (const s of servers) s.kill();
  feed?.close(); proxy.close(); await browser.close(); await db.close();
}
