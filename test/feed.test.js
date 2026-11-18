import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { buildFeed } from '../src/feed.js';
import { GENERATOR_KINDS, reviewCard } from '../src/generators.js';

test('every seeded generator produces a card', () => {
  const db = openDb(':memory:');
  for (const g of db.prepare('SELECT * FROM generators').all()) {
    for (let i = 0; i < 50; i++) {
      const c = GENERATOR_KINDS[g.kind].generate(JSON.parse(g.config), { db, excludeKeys: new Set(), generatorId: g.id });
      assert.ok(c && c.key && c.kind, `${g.kind} produced a card`);
    }
  }
});

test('feed is endless with generated cards, interleaves topics, mixes in articles', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const ai = db.prepare("SELECT id FROM topics WHERE name = 'AI'").get().id;
  const src = db.prepare('SELECT id FROM sources WHERE topic_id = ?').get(ai).id;
  for (let i = 0; i < 5; i++) {
    db.prepare('INSERT INTO items (source_id, topic_id, url, title, title_key, published_at, fetched_at, community_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(src, ai, `https://x.test/${i}`, `Post ${i}`, `post ${i}`, now - i * 3600e3, now, 100 * i);
  }
  const seen = new Set();
  let recentTopics = [];
  let recentKeys = [];
  let articles = 0;
  for (let page = 0; page < 10; page++) {
    const cards = buildFeed(db, { n: 12, excludeItems: [...seen], recentKeys, recentTopics });
    assert.equal(cards.length, 12);
    for (const c of cards) {
      if (c.item_id) { assert.ok(!seen.has(c.item_id), 'no repeated articles'); seen.add(c.item_id); articles++; }
    }
    recentKeys = recentKeys.concat(cards.map((c) => c.key)).slice(-60);
    recentTopics = cards.map((c) => c.topic_id).slice(-2);
    // no run of 3+ same topic within a page
    for (let i = 2; i < cards.length; i++) {
      assert.ok(!(cards[i].topic_id === cards[i - 1].topic_id && cards[i].topic_id === cards[i - 2].topic_id), 'topics interleave');
    }
  }
  assert.equal(articles, 5, 'all articles eventually served');
});

test('topic filter returns only that topic', () => {
  const db = openDb(':memory:');
  const ru = db.prepare("SELECT id FROM topics WHERE name = 'Russian'").get().id;
  const cards = buildFeed(db, { n: 10, topicId: ru });
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => c.topic_id === ru));
});

test('spaced repetition: new card limit and scheduling', () => {
  const db = openDb(':memory:');
  const deck = db.prepare('SELECT id FROM decks').get().id;
  const gen = GENERATOR_KINDS.flashcards;
  const cfg = { deck_id: deck, new_per_day: 2 };
  const ctx = { db, excludeKeys: new Set() };
  const a = gen.generate(cfg, ctx);
  assert.equal(a.status, 'new');
  reviewCard(db, a.card_id, 'good');
  const b = gen.generate(cfg, ctx);
  reviewCard(db, b.card_id, 'again');
  // b is due in 10 minutes; daily new limit (2) reached → nothing to show now.
  assert.equal(gen.generate(cfg, ctx), null);
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(a.card_id);
  assert.equal(row.reps, 1);
  assert.ok(row.due > Date.now() + 23 * 3600e3);
  // Pretend 11 minutes pass: b comes back as a relearn.
  db.prepare('UPDATE cards SET due = ? WHERE id = ?').run(Date.now() - 1, b.card_id);
  const c = gen.generate(cfg, ctx);
  assert.equal(c.card_id, b.card_id);
  assert.equal(c.status, 'relearn');
});
