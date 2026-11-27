// The D1 build against the in-memory mock backend (the oracle for what the app expects): same data in, same answers out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1 } from './d1shim.js';
import { createDb } from './mock-backend.js';
import { rest, applyOps, HttpError } from '../server/rest.js';
import { feedState } from '../server/feed.js';
import { runJob, claim, finish } from '../server/jobs.js';

const H = (o = {}) => new Headers(o);
const q = (s) => new URLSearchParams(s);
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const HOUR = 3600000;

async function seeded() {
  const d1 = localD1();
  const mock = createDb();
  const both = async (table, row) => { mock.insert(table, structuredClone(row)); await rest(d1, 'POST', table, q(''), H(), row); };
  await both('topics', { name: 'News', position: 2 });
  await both('topics', { name: 'Russian', position: 1, kind: 'cards', color: '#ff0000' });
  await both('sources', { topic_id: 1, kind: 'rss', name: 'Feed A', config: { url: 'https://a.example/rss' } });
  await both('sources', { topic_id: 1, kind: 'hn', name: 'HN', config: { min_score: 10 }, enabled: false });
  const item = (i, over = {}) => ({ source_id: 1, topic_id: 1, url: `https://a.example/${i}`, title: `Story ${i}`, title_key: `story ${i}`, summary: `s${i}`,
    domain: 'a.example', published_at: iso(now - i * HOUR), fetched_at: iso(now - i * HOUR), ...over });
  for (let i = 1; i <= 6; i++) await both('items', item(i));
  await both('items', item(7, { source_id: 2, domain: 'hn.example' }));
  await both('items', item(8, { domain: 'muted.example' }));
  await both('items', item(9, { seen_at: iso(now), reaction: 1 }));
  await both('items', item(10, { reaction: -1, saved_at: iso(now) }));
  await both('muted_domains', { domain: 'muted.example' });
  await both('decks', { name: 'Words', lang: 'ru' });
  await both('generators', { topic_id: 2, kind: 'notes', name: 'Notes', config: { deck_id: 1 } });
  await both('generators', { topic_id: 2, kind: 'cards', name: 'Cards', config: { deck_id: 1 }, enabled: false });
  for (let i = 1; i <= 5; i++) await both('cards', { deck_id: 1, front: `f${i}`, back: `b${i}`, position: i,
    due: i <= 3 ? iso(now + (i - 2) * 5 * HOUR) : null, introduced_at: i <= 2 ? iso(now - HOUR) : null });
  await both('app_settings', { key: 'theme', value: { dark: true } });
  return { d1, mock };
}

const call = async (d1, method, path, query = '', body, headers = {}) => {
  const r = await rest(d1, method, path, q(query), H(headers), body);
  return JSON.parse(JSON.stringify(r.body ?? null));
};

test('feed_state matches the mock backend', async () => {
  const { d1, mock } = await seeded();
  const dayStart = iso(new Date(now).setUTCHours(0, 0, 0, 0));
  const got = JSON.parse(await feedState(d1, dayStart));
  const want = JSON.parse(JSON.stringify(mock.feedState({ p_day_start: dayStart })));
  const norm = (s) => { for (const d of Object.values(s.decks)) d.sample.sort((a, b) => a.id - b.id); return s; };
  // Ids and column order don't matter to the app; compare as sets of rows with defaults filled the same.
  assert.deepEqual(got.topics, want.topics);
  assert.deepEqual(got.generators, want.generators);
  assert.deepEqual(got.sources, want.sources.map((s) => ({ ...s })));
  assert.deepEqual(got.items.map((i) => i.id), want.items.map((i) => i.id));
  assert.deepEqual(got.items[0], want.items[0]);
  assert.deepEqual(got.affinity.sort((a, b) => a.source_id - b.source_id), want.affinity);
  assert.deepEqual(norm(got).decks, norm(want).decks);
  assert.equal(got.items.length, 7); // 10 minus seen, muted and the disabled source's
});

test('feed_state keeps its sample random but within the deck', async () => {
  const { d1 } = await seeded();
  const s = JSON.parse(await feedState(d1, iso(now)));
  assert.equal(s.decks['1'].sample.length, 5);
});

test('selects: filters, order, paging, columns, single object', async () => {
  const { d1 } = await seeded();
  assert.deepEqual((await call(d1, 'GET', 'items', 'select=id&source_id=eq.1&seen_at=is.null&order=published_at.desc&limit=2')).map((r) => r.id), [1, 2]);
  assert.deepEqual((await call(d1, 'GET', 'items', 'select=id&id=in.(3,4,5)&order=id.desc&offset=1')).map((r) => r.id), [4, 3]);
  assert.deepEqual((await call(d1, 'GET', 'items', 'select=id&reaction=neq.0&order=id')).map((r) => r.id), [9, 10]);
  assert.deepEqual((await call(d1, 'GET', 'items', 'select=id&saved_at=not.is.null')).map((r) => r.id), [10]);
  assert.deepEqual((await call(d1, 'GET', 'items', 'select=id&published_at=gte.' + encodeURIComponent(iso(now - 2.5 * HOUR)) + '&order=id')).map((r) => r.id), [1, 2]);
  const one = await call(d1, 'GET', 'topics', 'id=eq.2', undefined, { accept: 'application/vnd.pgrst.object+json' });
  assert.equal(one.name, 'Russian');
  assert.equal(one.enabled, true);
  const none = await rest(d1, 'GET', 'topics', q('id=eq.99'), H({ accept: 'application/vnd.pgrst.object+json' }));
  assert.equal(none.status, 406);
  const src = await call(d1, 'GET', 'sources', 'select=*&id=eq.1');
  assert.deepEqual(src[0].config, { url: 'https://a.example/rss' });
  assert.equal(src[0].enabled, true);
});

test('null ordering follows Postgres', async () => {
  const { d1 } = await seeded();
  const asc = await call(d1, 'GET', 'cards', 'select=id,due&order=due');
  assert.equal(asc.at(-1).due, null);
  const desc = await call(d1, 'GET', 'cards', 'select=id,due&order=due.desc');
  assert.equal(desc[0].due, null);
});

test('writes: insert with representation, update, delete, cascade, duplicates', async () => {
  const { d1 } = await seeded();
  const rep = { prefer: 'return=representation' };
  const made = await rest(d1, 'POST', 'topics', q('select=id'), H({ ...rep, accept: 'application/vnd.pgrst.object+json' }), { name: 'New' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body, { id: 3 });
  const upd = await call(d1, 'PATCH', 'items', 'id=in.(1,2)', { seen_at: iso(now) }, rep);
  assert.equal(upd.length, 2);
  await rest(d1, 'PATCH', 'generators', q('id=eq.1'), H(), { weight: 2.5, enabled: false });
  assert.equal((await call(d1, 'GET', 'generators', 'id=eq.1'))[0].enabled, false);
  await assert.rejects(rest(d1, 'POST', 'items', q(''), H(), { source_id: 1, topic_id: 1, url: 'https://a.example/1', title: 'dup', published_at: iso(now) }),
    (e) => e.status === 409 && e.code === '23505');
  await assert.rejects(rest(d1, 'POST', 'muted_domains', q(''), H(), { domain: 'MUTED.example ' }), (e) => e.code === '23505');
  await rest(d1, 'DELETE', 'sources', q('id=eq.1'), H());
  assert.equal((await call(d1, 'GET', 'items', 'select=id&source_id=eq.1')).length, 0); // cascade
  await rest(d1, 'DELETE', 'topics', q('id=eq.1'), H());
  assert.equal((await call(d1, 'GET', 'sources')).length, 0);
});

test('views', async () => {
  const { d1, mock } = await seeded();
  const stats = await call(d1, 'GET', 'source_stats', 'order=id');
  const want = JSON.parse(JSON.stringify(mock.views.source_stats()));
  assert.deepEqual(stats.map((s) => [s.id, s.item_count, s.unseen_count, s.enabled]), want.map((s) => [s.id, s.item_count, s.unseen_count, s.enabled]));
  const decks = await call(d1, 'GET', 'deck_stats');
  assert.deepEqual(decks.map((d) => [d.cards, d.studied, d.due_now, d.lang]), [[5, 3, 2, 'ru']]);
  const domains = await call(d1, 'GET', 'domain_stats', 'order=total.desc&order=domain');
  const dwant = JSON.parse(JSON.stringify(mock.views.domain_stats())).sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain));
  assert.deepEqual(domains, dwant);
  assert.deepEqual((await call(d1, 'GET', 'saved_items')).map((i) => [i.id, i.source_name]), [[10, 'Feed A']]);
  await assert.rejects(rest(d1, 'POST', 'source_stats', q(''), H(), {}), HttpError);
});

test('unknown tables, columns and filters are refused', async () => {
  const { d1 } = await seeded();
  await assert.rejects(rest(d1, 'GET', 'sqlite_master', q(''), H()), (e) => e.status === 404);
  await assert.rejects(rest(d1, 'GET', 'items', q('select=id;drop'), H()), (e) => e.status === 400);
  await assert.rejects(rest(d1, 'GET', 'items', q('nope=eq.1'), H()), (e) => e.status === 400);
  await assert.rejects(rest(d1, 'GET', 'items', q('id=like.*a*'), H()), (e) => e.status === 400);
  await assert.rejects(rest(d1, 'PATCH', 'jobs', q(''), H(), { status: 'done' }), (e) => e.status === 404);
});

test('runner ops: insert (ignoring duplicates), patch, remove', async () => {
  const { d1 } = await seeded();
  const row = { id: 50, source_id: 1, topic_id: 1, url: 'https://a.example/new', title: 'New', title_key: 'new', published_at: iso(now) };
  assert.equal(await applyOps(d1, [{ op: 'insert', table: 'items', row }, { op: 'insert', table: 'items', row },
    { op: 'insert', table: 'item_content', row: { item_id: 50, status: 'ok', html: '<p>x</p>', text_length: 1 } },
    { op: 'patch', table: 'sources', id: 1, patch: { last_fetched: iso(now), last_error: null } }]), 4);
  assert.equal((await call(d1, 'GET', 'items', 'id=eq.50')).length, 1);
  assert.equal((await d1.prepare('SELECT html FROM item_content WHERE item_id = 50').first()).html, '<p>x</p>');
  await applyOps(d1, [{ op: 'remove', table: 'item_content', id: 50 }, { op: 'remove', table: 'items', id: 50 }]);
  assert.equal((await call(d1, 'GET', 'items', 'id=eq.50')).length, 0);
  await assert.rejects(applyOps(d1, [{ op: 'insert', table: 'topics', row: { name: 'x' } }]), HttpError);
});

test('jobs: queue, claim, finish', async () => {
  const d1 = localD1();
  const waiting = runJob(d1, 'read', { item: { id: 1 } }, { waitMs: 5000 });
  const job = await claim(d1, 3000);
  assert.equal(job.kind, 'read');
  assert.deepEqual(job.input, { item: { id: 1 } });
  assert.equal(await claim(d1, 100), null);
  await finish(d1, job.id, { result: { status: 'ok' } });
  assert.deepEqual(await waiting, { ok: true, result: { status: 'ok' } });
  const failing = runJob(d1, 'fetch_all', {}, { waitMs: 5000 });
  const j2 = await claim(d1, 3000);
  await finish(d1, j2.id, { error: 'boom' });
  assert.deepEqual(await failing, { ok: false, error: 'boom' });
  assert.equal((await runJob(d1, 'x', {}, { waitMs: 500 })).timedOut, true);
});
