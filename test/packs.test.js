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
  assert.ok(validatePack({ name: 'x', topics: [{ name: 't', sources: [{ kind: 'nope', name: 's' }] }] })[0].includes('unknown source kind'));
  assert.ok(validatePack({ name: 'x', topics: [{ name: 't', cards: [{ kind: 'flashcards', name: 'c', config: { deck: 'missing' } }] }] })[0].includes('deck'));
  assert.ok(validatePack({ topics: [] }).length >= 2);
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

test('installed topics are stacked in install order with falloff weights', async () => {
  const rows = await sql`select position, weight from topics order by position`;
  assert.deepEqual(rows.map((r) => r.position), rows.map((_, i) => i));
  assert.deepEqual(rows.map((r) => Math.round(r.weight * 1e4) / 1e4), rankWeights(rows.length, 0.8));
});
