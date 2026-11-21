import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { freshDb, sqlData } from './db.js';
import { installPack, validatePack } from '../public/lib/packs.js';
import { rankWeights } from '../public/lib/balance.js';

const dir = new URL('../public/starters/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const packs = index.map((f) => [f, JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);

test('index.json lists every pack file', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  assert.deepEqual([...index].sort(), files);
});

for (const [file, pack] of packs) {
  test(`${file} is a valid pack`, () => assert.deepEqual(validatePack(pack), []));
}

test('validatePack reports mistakes', () => {
  assert.ok(validatePack({ name: 'x', topics: [{ name: 't', kind: 'articles', sources: [{ kind: 'nope', name: 's' }] }] })[0].includes('unknown source kind'));
  assert.ok(validatePack({ name: 'x', topics: [{ name: 't', kind: 'cards', cards: [{ kind: 'flashcards', name: 'c', config: { deck: 'missing' } }] }] })[0].includes('deck'));
  assert.ok(validatePack({ topics: [] }).length >= 2);
});

test('validatePack requires a valid topic kind and keeps sources and cards apart', () => {
  const src = { kind: 'rss', name: 's', config: { url: 'https://x.test/feed' } };
  const card = { kind: 'prompts', name: 'c', config: { lines: ['a'] } };
  const errs = (topic) => validatePack({ name: 'x', topics: [{ name: 't', ...topic }] });
  assert.ok(errs({ sources: [src] })[0].includes('kind must be'), 'kind is required');
  assert.ok(errs({ kind: 'both', sources: [src] })[0].includes('kind must be'), 'kind must be valid');
  assert.ok(errs({ kind: 'articles', sources: [src], cards: [card] }).some((e) => e.includes('cannot have cards')));
  assert.ok(errs({ kind: 'cards', sources: [src], cards: [card] }).some((e) => e.includes('cannot have sources')));
  assert.deepEqual(errs({ kind: 'articles', sources: [src] }), []);
  assert.deepEqual(errs({ kind: 'cards', cards: [card] }), []);
});

const sql = await freshDb();
after(() => sql.end());

const data = sqlData(sql);

test('a fresh database has no content', async () => {
  const [r] = await sql`select (select count(*) from topics)::int t, (select count(*) from sources)::int s, (select count(*) from cards)::int c`;
  assert.deepEqual(r, { t: 0, s: 0, c: 0 });
});

test('every pack installs into the real schema, and installing twice adds nothing', async () => {
  for (const [, pack] of packs) {
    const first = await installPack(data, pack);
    assert.equal(first.topics, pack.topics.length);
    assert.deepEqual(await installPack(data, pack), { topics: 0, sources: 0, cards: 0, decks: 0 });
  }
  const [{ n }] = await sql`select count(*)::int n from topics`;
  assert.equal(n, packs.reduce((s, [, p]) => s + p.topics.length, 0));
});

test('flashcard card types point at the installed deck', async () => {
  const [fc] = await sql`select g.config, d.id from generators g join decks d on d.name = 'Russian core vocabulary' where g.kind = 'flashcards'`;
  assert.equal(Number(fc.config.deck_id), Number(fc.id));
  const [{ n }] = await sql`select count(*)::int n from cards where deck_id = ${fc.id}`;
  assert.equal(n, 90);
  const [p] = await sql`select config from generators where kind = 'prompts' limit 1`;
  assert.equal(typeof p.config.lines, 'string');
});

test('installing a pack sets each topic kind, with cards only on card topics and sources only on article topics', async () => {
  const rows = await sql`select t.name, t.kind, (select count(*)::int from sources s where s.topic_id = t.id) s, (select count(*)::int from generators g where g.topic_id = t.id) g from topics t`;
  for (const r of rows) assert.ok(r.kind === 'articles' ? r.g === 0 : r.s === 0, `${r.name} keeps its kind`);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName['Guitar'].kind, 'articles');
  assert.equal(byName['Guitar practice'].kind, 'cards');
  assert.equal(byName['Sight reading'].kind, 'cards');
  const order = (await sql`select name from topics order by position`).map((r) => r.name);
  assert.equal(order.indexOf('Guitar practice'), order.indexOf('Guitar') + 1, 'practice topic follows its articles topic');
});

test('installed topics are stacked in install order with falloff weights', async () => {
  const rows = await sql`select position, weight from topics order by position`;
  assert.deepEqual(rows.map((r) => r.position), rows.map((_, i) => i));
  assert.deepEqual(rows.map((r) => Math.round(r.weight * 1e4) / 1e4), rankWeights(rows.length, 0.8));
});
