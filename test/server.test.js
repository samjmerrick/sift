// The whole path: the server on an in-memory database, a stand-in PocketBase, and a local feed to fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb } from '../server/db.js';
import { createApp } from '../server/index.js';
import { createAuth } from '../server/auth.js';
import { makeFetcher } from '../fetch/handlers.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  .replaceAll('RECENT_RFC', new Date(Date.now() - 3600e3).toUTCString()).replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());
let feed, feedBase, db, handle, cookie;
const API = 'https://apps.test/sift';
const USERS = {
  owner: { email: 'Owner@example.com', verified: true },
  stranger: { email: 'other@example.com', verified: true },
  squatter: { email: 'owner@example.com', verified: false },
};
const pocketbase = async (_url, { headers }) => (USERS[headers.Authorization]
  ? Response.json({ record: USERS[headers.Authorization] }) : new Response('no', { status: 401 }));
const auth = createAuth({ secret: 'test-secret', emails: ['owner@example.com'], pbUrl: 'http://pb', fetchImpl: pocketbase });

const call = (path, init = {}, as = cookie) => handle(new Request(`${API}${path}`, { ...init, headers: { ...(as ? { cookie: as } : {}), ...init.headers } }));
const signIn = (token) => call('/session', { method: 'POST', body: JSON.stringify({ token }) }, null);
const rpc = async (path, method, body) => (await call(path, { method, body: body && JSON.stringify(body) })).json();

before(async () => {
  feed = createServer((req, res) => { try { res.writeHead(200, { 'Content-Type': 'application/xml' }).end(fixture(req.url.slice(1))); } catch { res.writeHead(404).end(); } });
  await new Promise((r) => feed.listen(0, r));
  feedBase = `http://127.0.0.1:${feed.address().port}`;
  db = openDb();
  handle = createApp({ db, auth, fetcher: makeFetcher(db) });
  cookie = (await signIn('owner')).headers.get('set-cookie').split(';')[0];
});
after(() => feed.close());

test('only verified, listed addresses get a session', async () => {
  assert.equal((await signIn('nobody')).status, 401);
  assert.equal((await signIn('stranger')).status, 403);
  assert.equal((await signIn('squatter')).status, 403);
  const ok = await signIn('owner');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /Path=\/sift\/;.*HttpOnly; Secure/);
});

test('the page and the API need the cookie; other files do not', async () => {
  const out = await call('/', {}, null);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/sift/login.html');
  assert.equal((await call('/rest/v1/topics', {}, null)).status, 401);
  assert.equal((await call('/rest/v1/topics', {}, `${cookie}x`)).status, 401);
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.equal((await call('/login.html', {}, null)).status, 200);
  assert.equal((await call('/style.css', {}, null)).status, 200);
  assert.equal((await call('/..%2fpackage.json', {}, null)).status, 404);
  assert.match(await (await call('/config.js')).text(), /bee: true/);
  assert.match((await call('/logout', { method: 'POST' })).headers.get('set-cookie'), /Max-Age=0/);
});

test('writes from another origin are refused', async () => {
  const post = (origin) => call('/rest/v1/topics', { method: 'POST', body: '{"name":"News"}', headers: { origin, host: 'apps.test' } });
  assert.equal((await post('https://evil.test')).status, 403);
  assert.equal((await post('https://apps.test')).status, 201);
});

test('preview and fetch a source then see the items in the feed', async () => {
  await call('/rest/v1/sources', { method: 'POST', body: JSON.stringify({ topic_id: 1, kind: 'rss', name: 'Local feed', config: { url: `${feedBase}/rss.xml` } }) });
  const items = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'preview', source: { kind: 'rss', config: { url: `${feedBase}/rss.xml` } } });
  assert.ok(items.length > 0 && items[0].title);
  const fetched = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_source', id: 1 });
  assert.ok(fetched.added > 0, JSON.stringify(fetched));
  const state = await rpc('/rest/v1/rpc/feed_state', 'POST', { p_day_start: new Date().toISOString() });
  assert.equal(state.items.length, fetched.added);
  assert.equal(state.sources[0].last_error, null);
  assert.ok(state.sources[0].last_fetched);
  // Fetching again adds nothing new.
  const again = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_source', id: 1 });
  assert.equal(again.added, 0);
});

test('fetch_all reports per source', async () => {
  const all = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_all' });
  assert.deepEqual(Object.keys(all), ['Local feed']);
});

test('reading an article: fetched once, then served from the database', async () => {
  const item = (await rpc('/rest/v1/items?select=id,url&limit=1', 'GET'))[0];
  assert.ok(item);
  await db.prepare('UPDATE items SET url = ? WHERE id = ?').bind(`${feedBase}/article.html`, item.id).run();
  const article = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'read', id: item.id });
  assert.equal(article.status, 'ok');
  assert.ok(article.html.length > 100);
  const cached = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'read', id: item.id });
  assert.equal(cached.html, article.html);
});

test('/sift redirects to /sift/ so relative links work', async () => {
  const res = await handle(new Request('https://apps.test/sift?x=1'));
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/sift/?x=1');
});
