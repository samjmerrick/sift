import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOffline, memoryBackend, missingArticles } from '../public/lib/offline.js';

const row = (id) => ({ id, title: `Article ${id}`, url: `https://example.com/${id}`, saved_at: id });
const read = (id) => ({ status: 'ok', html: `<p>Text of ${id}</p>`, text_length: 12 });

test('stores, reads back and removes an article copy', async () => {
  const off = createOffline(memoryBackend());
  assert.equal(await off.article(1), null);
  await off.saveArticle(1, row(1), read(1));
  const got = await off.article(1);
  assert.deepEqual(got.card, row(1));
  assert.deepEqual(got.read, read(1));
  assert.deepEqual(await off.articleIds(), [1]);
  await off.removeArticle(1);
  assert.equal(await off.article(1), null);
  assert.deepEqual(await off.articleIds(), []);
});

test('storing the Saved list drops copies of articles that are no longer saved', async () => {
  const off = createOffline(memoryBackend());
  for (const id of [1, 2, 3]) await off.saveArticle(id, row(id), read(id));
  await off.setMeta({ topics: [{ id: 9 }], decks: [] });
  await off.setSavedList({ items: [row(1), row(3)], cards: [{ id: 5, payload: {} }] });
  assert.deepEqual((await off.articleIds()).sort(), [1, 3]);
  const list = await off.savedList();
  assert.deepEqual(list.items.map((i) => i.id), [1, 3]);
  assert.equal(list.cards.length, 1);
  assert.deepEqual((await off.meta()).topics, [{ id: 9 }], 'meta is not an article and survives pruning');
});

test('clear removes everything', async () => {
  const off = createOffline(memoryBackend());
  await off.saveArticle(1, row(1), read(1));
  await off.setSavedList({ items: [row(1)], cards: [] });
  await off.setMeta({ topics: [], decks: [] });
  await off.clear();
  assert.equal(await off.article(1), null);
  assert.equal(await off.savedList(), null);
  assert.equal(await off.meta(), null);
});

test('a broken storage backend never throws', async () => {
  const boom = async () => { throw new Error('quota'); };
  const off = createOffline({ get: boom, set: boom, del: boom, keys: boom });
  assert.equal(await off.article(1), null);
  assert.deepEqual(await off.articleIds(), []);
  assert.equal(await off.savedList(), null);
  await off.saveArticle(1, row(1), read(1));
  await off.setSavedList({ items: [], cards: [] });
  await off.clear();
});

test('missingArticles lists saved items without a stored copy', () => {
  assert.deepEqual(missingArticles([row(1), row(2), row(3)], [2]).map((r) => r.id), [1, 3]);
});
