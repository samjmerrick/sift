import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeed, normaliseState, generateOne } from '../public/lib/feed.js';
import { GENERATOR_KINDS, scheduleReview, applyReviewToDeck } from '../public/lib/generators.js';
import { freshDb, asUser } from './db.js';

const sql = await freshDb({ packs: ['ai', 'russian', 'guitar', 'piano'] });
after(() => sql.end());
const loadState = () => asUser(sql, async (tx) => normaliseState((await tx`select feed_state() s`)[0].s));

test('every seeded card type produces cards', async () => {
  const state = await loadState();
  for (const g of state.generators) {
    for (let i = 0; i < 50; i++) {
      const c = generateOne(state, g);
      assert.ok(c && c.key && c.kind, `${g.kind} produced a card`);
    }
  }
});

test('feed is endless, interleaves topics, and serves every article once', async () => {
  const [ai] = await sql`select id from topics where name = 'AI'`;
  const [src] = await sql`select id from sources where topic_id = ${ai.id} limit 1`;
  for (let i = 0; i < 5; i++) {
    await sql`insert into items (source_id, topic_id, url, title, title_key, published_at, community_score)
      values (${src.id}, ${ai.id}, ${`https://x.test/${i}`}, ${`Post ${i}`}, ${`post ${i}`}, ${new Date(Date.now() - i * 3600e3)}, ${100 * i})`;
  }
  const state = await loadState();
  assert.equal(state.items.length, 5);
  const seen = new Set();
  let recentTopics = [];
  let recentKeys = [];
  for (let page = 0; page < 10; page++) {
    const cards = buildFeed(state, { n: 12, excludeItems: seen, recentKeys, recentTopics });
    assert.equal(cards.length, 12);
    for (const c of cards) {
      if (c.item_id) { assert.ok(!seen.has(c.item_id), 'no repeated articles'); seen.add(c.item_id); }
    }
    recentKeys = recentKeys.concat(cards.map((c) => c.key)).slice(-60);
    recentTopics = cards.map((c) => c.topic_id).slice(-2);
    for (let i = 2; i < cards.length; i++) {
      assert.ok(!(cards[i].topic_id === cards[i - 1].topic_id && cards[i].topic_id === cards[i - 2].topic_id), 'topics interleave');
    }
  }
  assert.equal(seen.size, 5, 'all articles eventually served');
});

test('seen articles and disabled sources are excluded; reactions shift ranking', async () => {
  await sql`update items set seen_at = now() where title = 'Post 0'`;
  let state = await loadState();
  assert.ok(!state.items.some((i) => i.title === 'Post 0'));
  await sql`update items set reaction = -1 where title = 'Post 1'`;
  state = await loadState();
  assert.equal(state.affinity.length, 1);
  assert.equal(Number(state.affinity[0].down), 1);
});

test('topic filter returns only that topic', async () => {
  const state = await loadState();
  const ru = state.topics.find((t) => t.name === 'Russian').id;
  const cards = buildFeed(state, { n: 10, topicId: ru });
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => c.topic_id === ru));
});

test('spaced repetition: daily new limit, scheduling, relearn — persisted round trip', async () => {
  const state = await loadState();
  const deckId = Number(Object.keys(state.decks)[0]);
  const deck = state.decks[deckId];
  const gen = GENERATOR_KINDS.flashcards;
  const cfg = { deck_id: deckId, new_per_day: 2 };
  const ctx = { decks: state.decks, excludeKeys: new Set() };
  const review = async (cardId, grade) => {
    const card = [...deck.due, ...deck.new].find((c) => c.id === cardId);
    const u = scheduleReview(card, grade);
    await sql`update cards set due = ${new Date(u.due)}, interval_days = ${u.interval_days}, ease = ${u.ease}, reps = ${u.reps},
      lapses = ${u.lapses}, introduced_at = ${new Date(u.introduced_at)} where id = ${cardId}`;
    applyReviewToDeck(deck, card, u);
    return u;
  };
  const a = gen.generate(cfg, ctx);
  assert.equal(a.status, 'new');
  const ua = await review(a.card_id, 'good');
  assert.ok(ua.due > Date.now() + 23 * 3600e3);
  const b = gen.generate(cfg, ctx);
  assert.notEqual(b.card_id, a.card_id);
  await review(b.card_id, 'again');
  assert.equal(gen.generate(cfg, ctx), null, 'limit reached and nothing due yet');

  // Reload from the database: the limit and the 10-minute relearn survive.
  const fresh = await loadState();
  assert.equal(fresh.decks[deckId].introduced_today, 2);
  const relearn = fresh.decks[deckId].due.find((c) => c.id === b.card_id);
  assert.ok(relearn, 'again-card is in the upcoming queue');
  relearn.due = Date.now() - 1; // pretend 10 minutes passed
  const c = gen.generate(cfg, { decks: fresh.decks, excludeKeys: new Set() });
  assert.equal(c.card_id, b.card_id);
  assert.equal(c.status, 'relearn');
});

test('topicIds filters to several topics at once', async () => {
  const state = await loadState();
  const ids = state.topics.filter((t) => ['Russian', 'Guitar'].includes(t.name)).map((t) => t.id);
  const cards = buildFeed(state, { n: 30, topicIds: ids });
  assert.equal(cards.length, 30);
  assert.ok(cards.every((c) => ids.includes(c.topic_id)));
  assert.ok(new Set(cards.map((c) => c.topic_id)).size === 2, 'both selected topics appear');
});

test('notes cards rotate through the sample and skip shown keys', () => {
  const gen = GENERATOR_KINDS.notes;
  const sample = [1, 2, 3].map((id) => ({ id, front: `T${id}`, back: `B${id}`, note: id === 2 ? 'extra' : '' }));
  const decks = { 7: { name: 'Concepts', due: [], new: [], sample } };
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const c = gen.generate({ deck_id: 7 }, { decks, excludeKeys: seen });
    assert.equal(c.kind, 'note');
    assert.ok(!seen.has(c.key), 'does not repeat an excluded card');
    assert.deepEqual([c.deck, c.title, c.body], ['Concepts', `T${c.key.slice(5)}`, `B${c.key.slice(5)}`]);
    seen.add(c.key);
  }
  assert.equal(gen.generate({ deck_id: 7 }, { decks, excludeKeys: seen }), null, 'nothing left once all are excluded');
  assert.equal(gen.generate({ deck_id: 99 }, { decks, excludeKeys: new Set() }), null, 'missing deck gives null');
  const fallback = { 8: { name: 'N', due: [], new: [sample[0]], sample: [] } };
  assert.equal(gen.generate({ deck_id: 8 }, { decks: fallback, excludeKeys: new Set() }).key, 'note:1', 'falls back to new cards');
});

test('feed_state includes a card sample only for decks used by an enabled notes card type', async () => {
  const [a] = await sql`insert into decks (name) values ('Notes deck') returning id`;
  const [b] = await sql`insert into decks (name) values ('Plain deck') returning id`;
  for (const d of [a, b]) await sql`insert into cards ${sql(Array.from({ length: 35 }, (_, i) => ({ deck_id: d.id, front: `f${i}`, back: `b${i}`, position: i })))}`;
  const [t] = await sql`select id from topics limit 1`;
  const [g] = await sql`insert into generators (topic_id, kind, name, config) values (${t.id}, 'notes', 'Notes', ${sql.json({ deck_id: a.id })}) returning id`;
  let state = await loadState();
  assert.equal(state.decks[a.id].sample.length, 30, 'sample is capped at 30');
  assert.equal(state.decks[b.id].sample.length, 0);
  await sql`update generators set enabled = false where id = ${g.id}`;
  state = await loadState();
  assert.equal(state.decks[a.id].sample.length, 0, 'disabled notes card type needs no sample');
  await sql`delete from generators where id = ${g.id}`;
  await sql`delete from decks where id in ${sql([a.id, b.id])}`;
});
