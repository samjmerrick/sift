// The whole path: the app's Worker (on a local D1), the runner's store and handlers, and a local feed to fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import worker from '../server/index.js';
import { localD1 } from './d1shim.js';
import { openRemote } from '../runner/store.js';
import { makeHandlers } from '../runner/handlers.js';
import { claim, finish } from '../server/jobs.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  .replaceAll('RECENT_RFC', new Date(Date.now() - 3600e3).toUTCString()).replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());
let feed, feedBase, db, env, realFetch, role = 'editor', handlers, store;
const TOKEN = 'runner-secret';
const API = 'https://apps.test/sift';

before(async () => {
  feed = createServer((req, res) => { try { res.writeHead(200, { 'Content-Type': 'application/xml' }).end(fixture(req.url.slice(1))); } catch { res.writeHead(404).end(); } });
  await new Promise((r) => feed.listen(0, r));
  feedBase = `http://127.0.0.1:${feed.address().port}`;
  db = localD1();
  env = {
    DB: db,
    BEE: { identify: async () => (role ? { email: 'sam@example.com', role } : null), secret: async (_app, name) => (name === 'RUNNER_TOKEN' ? TOKEN : null) },
    ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; return p === '/' ? new Response('<!doctype html><script>boot()</script>', { headers: { 'content-type': 'text/html' } }) : new Response('asset ' + p); } },
  };
  // Calls to the app go straight to the Worker; everything else (the local feed) goes to the network.
  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const req = new Request(input, init);
    return req.url.startsWith('https://apps.test/') ? worker.fetch(req, env, {}) : realFetch(input, init);
  };
  store = openRemote({ url: API, token: TOKEN });
  handlers = makeHandlers(store);
});
after(() => { globalThis.fetch = realFetch; feed.close(); });

const app = (path, init = {}) => worker.fetch(new Request(`https://apps.test/sift${path}`, init), env, {});
const rpc = async (path, method, body) => (await app(path, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json' } })).json();
/** Serve one queued job with the runner's handlers while the app waits on it. */
const serveOne = async () => { const job = await claim(db, 5000); const result = await handlers[job.kind](job.input); await finish(db, job.id, { result }); return job; };

test('the page needs a sign-in and a role; assets pass through', async () => {
  role = null;
  assert.equal((await app('/')).status, 401);
  role = 'viewer';
  const page = await app('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.equal(await (await app('/style.css')).text(), 'asset /style.css');
  assert.match(await (await app('/config.js')).text(), /bee: true/);
});

test('viewers read, only editors write', async () => {
  role = 'viewer';
  assert.equal((await app('/rest/v1/topics')).status, 200);
  assert.equal((await app('/rest/v1/topics', { method: 'POST', body: '{"name":"x"}' })).status, 403);
  assert.equal((await app('/rest/v1/rpc/feed_state', { method: 'POST', body: '{}' })).status, 200);
  role = 'editor';
  const r = await app('/rest/v1/topics', { method: 'POST', body: '{"name":"News"}', headers: { origin: 'https://evil.test' } });
  assert.equal(r.status, 403);
  assert.equal((await app('/rest/v1/topics', { method: 'POST', body: '{"name":"News"}', headers: { origin: 'https://apps.test' } })).status, 201);
});

test('the runner endpoints need the token and skip the sign-in', async () => {
  role = null;
  assert.equal((await app('/_bee/snapshot')).status, 401);
  assert.equal((await app('/_bee/snapshot', { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await app('/_bee/snapshot', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  role = 'editor';
});

test('preview and fetch a source through a job, then see the items in the feed', async () => {
  await app('/rest/v1/sources', { method: 'POST', body: JSON.stringify({ topic_id: 1, kind: 'rss', name: 'Local feed', config: { url: `${feedBase}/rss.xml` } }) });
  const preview = Promise.all([serveOne(), rpc('/functions/v1/sift-fetch', 'POST', { action: 'preview', source: { kind: 'rss', config: { url: `${feedBase}/rss.xml` } } })]);
  const [, items] = await preview;
  assert.ok(items.length > 0 && items[0].title);
  const [, fetched] = await Promise.all([serveOne(), rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_source', id: 1 })]);
  assert.ok(fetched.added > 0, JSON.stringify(fetched));
  const state = await rpc('/rest/v1/rpc/feed_state', 'POST', { p_day_start: new Date().toISOString() });
  assert.equal(state.items.length, fetched.added);
  assert.equal(state.sources[0].last_error, null);
  assert.ok(state.sources[0].last_fetched);
  // Fetching again adds nothing new.
  const [, again] = await Promise.all([serveOne(), rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_source', id: 1 })]);
  assert.equal(again.added, 0);
});

test('fetch_all reports per source', async () => {
  const [, all] = await Promise.all([serveOne(), rpc('/functions/v1/sift-fetch', 'POST', { action: 'fetch_all' })]);
  assert.deepEqual(Object.keys(all), ['Local feed']);
});

test('reading an article: fetched once, then served from the database', async () => {
  const item = (await rpc('/rest/v1/items?select=id,url&limit=1', 'GET'))[0];
  assert.ok(item);
  await db.prepare('UPDATE items SET url = ? WHERE id = ?').bind(`${feedBase}/article.html`, item.id).run();
  role = 'viewer';
  const [, article] = await Promise.all([serveOne(), rpc('/functions/v1/sift-fetch', 'POST', { action: 'read', id: item.id })]);
  assert.equal(article.status, 'ok');
  assert.ok(article.html.length > 100);
  const cached = await rpc('/functions/v1/sift-fetch', 'POST', { action: 'read', id: item.id }); // no job needed
  assert.equal(cached.html, article.html);
  assert.equal((await app('/functions/v1/sift-fetch', { method: 'POST', body: '{"action":"fetch_all"}' })).status, 403);
  role = 'editor';
});

test('/sift redirects to /sift/ so relative links work', async () => {
  const res = await worker.fetch(new Request('https://apps.test/sift?x=1', { redirect: 'manual' }), env, {});
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), 'https://apps.test/sift/?x=1');
});
