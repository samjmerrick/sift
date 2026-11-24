// End-to-end check of Sift on bee: bee/import-supabase.js, bee/server.js and the real app (public/) in Chromium,
// on a throwaway copy of the personal database's schema. Not part of `npm test` (needs Chromium):
//
//   npm run preview && node test/bee.e2e.mjs
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally, as for test/e2e.cjs
const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'sift-bee-'));
const dbPath = join(dir, 'bee.db');
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(readFileSync(join(root, 'test/fixtures/bee-schema.sql'), 'utf8'));
const count = (collection, where = '1') => sqlite.prepare(`SELECT count(*) AS n FROM records WHERE project='sift' AND collection=? AND ${where}`).get(collection).n;
const row = (collection, field, value) => {
  const r = sqlite.prepare(`SELECT metadata FROM records WHERE project='sift' AND collection=? AND json_extract(metadata, '$.' || ?) = ?`).get(collection, field, value);
  return r ? JSON.parse(r.metadata) : null;
};
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) if (fn()) return true; return false; };
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. Import: the preview build's sample tables stand in for a Supabase export.
await page.goto(`file://${root}dist/sift-preview.local.html`);
await page.waitForFunction(() => window.SIFT_PREVIEW?.db?.tables?.items?.length > 0);
writeFileSync(join(dir, 'seed.json'), JSON.stringify(await page.evaluate(() => window.SIFT_PREVIEW.db.tables)));
const env = { ...process.env, BEE_DB: dbPath, NODE_NO_WARNINGS: '1' };
const imp = () => execFileSync('node', [join(root, 'bee/import-supabase.js'), '--json', join(dir, 'seed.json')], { env, encoding: 'utf8' });
imp();
ok(/topics\s+0 added/.test(imp()), 'import is safe to run twice');
const topicsAtStart = count('topics');

// A local feed for "add source" / "fetch now".
const atom = readFileSync(join(root, 'test/fixtures/atom.xml'), 'utf8').replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());
const feed = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'application/xml' }).end(atom)).listen(0);
const feedUrl = `http://127.0.0.1:${feed.address().port}/feed.xml`;

// 2. The server.
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn('node', [join(root, 'bee/server.js')], {
  env: { ...env, PORT: String(PORT), SIFT_PASSWORD: 'correct horse', SIFT_EMAIL: 'sam@example.com', SIFT_FETCH_MINUTES: '0', SIFT_SERVE_APP: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('Sift on bee')) resolve(); }));
try {
  const call = (path, { method = 'GET', body, token, headers = {} } = {}) => fetch(BASE + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });

  // 3. Sign-in and access control.
  ok((await call('/rest/v1/topics')).status === 401, 'the API refuses calls without a session');
  ok((await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'sam@example.com', password: 'wrong' } })).status === 400, 'a wrong password is refused');
  ok((await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'other@example.com', password: 'correct horse' } })).status === 400, 'another email is refused');
  const s = await (await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'Sam@example.com', password: 'correct horse' } })).json();
  ok(s.access_token && s.refresh_token, 'the right email and password sign in');
  const r2 = await (await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })).json();
  ok(r2.access_token, 'a refresh token gives a new session');
  ok((await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.access_token } })).status === 400, 'an access token is not a refresh token');
  const pre = await call('/rest/v1/topics', { method: 'OPTIONS', headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Headers': 'authorization,apikey' } });
  ok(pre.status === 204 && pre.headers.get('access-control-allow-headers').includes('apikey'), 'CORS preflight is answered');
  const T = s.access_token;

  // 4. The real app, signed in through its own login screen.
  await page.goto(BASE);
  await page.fill('input[type=email]', 'sam@example.com');
  await page.fill('input[type=password]', 'correct horse');
  await page.click('button[type=submit], .login .btn.primary');
  await page.waitForSelector('.card h3', { timeout: 15000 });
  ok(true, `the feed loads (first card: "${(await page.locator('.card h3').first().textContent()).trim().slice(0, 50)}")`);
  const before = count('items', "json_extract(metadata,'$.reaction') = 1");
  await page.locator('button[aria-label="More like this"][aria-pressed="false"]').first().click();
  ok(await until(() => count('items', "json_extract(metadata,'$.reaction') = 1") === before + 1), 'a thumbs-up is saved to the personal database');
  await page.mouse.wheel(0, 4000);
  ok(await until(() => count('items', "json_extract(metadata,'$.seen_at') IS NOT NULL") > 0), 'scrolling past cards marks them seen in the database');

  // 5. Add a topic and a source, preview and fetch it, rename, then delete with its articles.
  const [topic] = await (await call('/rest/v1/topics?select=*', { method: 'POST', token: T, headers: { Prefer: 'return=representation' }, body: { name: 'Bee test', color: '#335577', position: 99, kind: 'articles' } })).json();
  ok(row('topics', 'name', 'Bee test')?.id === topic.id, 'a new topic is stored with its id');
  const [src] = await (await call('/rest/v1/sources?select=*', { method: 'POST', token: T, headers: { Prefer: 'return=representation' }, body: { topic_id: topic.id, kind: 'rss', name: 'Local feed', config: { url: feedUrl } } })).json();
  const preview = await (await call('/functions/v1/sift-fetch', { method: 'POST', token: T, body: { action: 'preview', source: src } })).json();
  ok(Array.isArray(preview) && preview.length > 0, `source preview runs the fetcher (${preview.length} items)`);
  const fetched = await (await call('/functions/v1/sift-fetch', { method: 'POST', token: T, body: { action: 'fetch_source', id: src.id } })).json();
  ok(fetched.added > 0 && count('items', `json_extract(metadata,'$.source_id') = ${src.id}`) === fetched.added, `fetch now adds articles to the database (+${fetched.added})`);
  const again = await (await call('/functions/v1/sift-fetch', { method: 'POST', token: T, body: { action: 'fetch_source', id: src.id } })).json();
  ok(again.added === 0, 'fetching again de-duplicates');
  const listed = await (await call(`/rest/v1/items?select=id,title&source_id=eq.${src.id}`, { token: T })).json();
  ok(listed.length === fetched.added, 'fetched articles are visible through the API straight away');
  const read = await (await call('/functions/v1/sift-fetch', { method: 'POST', token: T, body: { action: 'read', id: listed[0].id } })).json();
  ok(read.status && count('item_content', `json_extract(metadata,'$.item_id') = ${listed[0].id}`) === 1, `reader text is fetched and cached (${read.status})`);
  await call(`/rest/v1/topics?id=eq.${topic.id}`, { method: 'PATCH', token: T, body: { name: 'Bee test renamed' } });
  ok(row('topics', 'id', topic.id)?.name === 'Bee test renamed' && row('topics', 'id', topic.id)?.color === '#335577', 'an update changes only the fields sent');
  await call(`/rest/v1/topics?id=eq.${topic.id}`, { method: 'DELETE', token: T });
  ok(!row('topics', 'id', topic.id) && count('items', `json_extract(metadata,'$.topic_id') = ${topic.id}`) === 0
    && count('item_content', `json_extract(metadata,'$.item_id') = ${listed[0].id}`) === 0, 'deleting a topic removes its sources, articles and reader text');
  ok(count('topics') === topicsAtStart, 'topic count is back where it started');

  // 6. A change made outside the server (Claude through the connector) shows up on the next request.
  const t0 = new Date().toISOString();
  new DatabaseSync(dbPath).prepare('INSERT INTO records (id, project, collection, title, content, tags, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('outside-1', 'sift', 'muted_domains', 'outside.example', 'outside.example', '[]', JSON.stringify({ domain: 'outside.example' }), t0, t0);
  const muted = await (await call('/rest/v1/muted_domains?select=*', { token: T })).json();
  ok(muted.some((m) => m.domain === 'outside.example'), 'writes from outside the server are picked up');

  // 7. Reload: still signed in, Settings opens.
  await page.reload();
  await page.waitForSelector('.card h3', { timeout: 15000 });
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector('.row', { timeout: 10000 });
  await page.screenshot({ path: join(dir, 'settings.png') });
  ok(true, 'the app stays signed in after a reload and Settings opens');

  // 8. The command-line fetch runs against the same file.
  // (It exits 1 when every source fails, as here without internet; the summary line still prints.)
  let out;
  try { out = execFileSync('node', [join(root, 'bee/fetch.js')], { env, encoding: 'utf8', timeout: 240000 }); } catch (e) { out = String(e.stdout); }
  out = out.trim().split('\n').pop();
  ok(/new, \d+ summaries checked/.test(out), `bee/fetch.js runs (${out})`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nbee e2e passed (${dir})`);
} finally {
  server.kill(); feed.close(); await browser.close();
}
