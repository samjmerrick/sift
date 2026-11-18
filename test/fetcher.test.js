import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { fetchSource, previewSource, normaliseUrl, htmlToText, truncate, keywordRegex } from '../src/fetcher.js';

let server, base;
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  .replaceAll('RECENT_RFC', new Date(Date.now() - 3600e3).toUTCString())
  .replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());

before(async () => {
  server = createServer((req, res) => {
    try {
      const body = fixture(req.url.slice(1));
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('helpers', () => {
  assert.equal(normaliseUrl('http://www.example.com/a/?utm_source=x&id=2#top'), 'https://example.com/a?id=2');
  assert.equal(htmlToText('<p>Hello &amp; <b>world</b></p>'), 'Hello & world');
  assert.ok(truncate('word '.repeat(200), 50).length <= 51);
  const re = keywordRegex('AI, LLM');
  assert.ok(re.test('New LLM released'));
  assert.ok(!re.test('Said the villain'));
  assert.ok(keywordRegex('кошка').test('Моя кошка спит'));
});

test('atom feed: parse, age filter, entity handling', async () => {
  const items = await previewSource({ kind: 'rss', config: { url: `${base}/atom.xml`, max_age_days: 14 } });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Running a 7B model on a phone & why it matters');
  assert.equal(items[0].summary, 'Quantisation has gotten good enough that local inference is practical.');
});

test('rss feed: exclude keywords, image extraction, saving and dedupe', async () => {
  const db = openDb(':memory:');
  const topic = db.prepare('SELECT id FROM topics LIMIT 1').get().id;
  const id = db.prepare("INSERT INTO sources (topic_id, kind, name, config, exclude) VALUES (?, 'rss', 't', ?, 'sponsored')")
    .run(topic, JSON.stringify({ url: `${base}/rss.xml` })).lastInsertRowid;
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  assert.deepEqual(await fetchSource(db, src), { added: 1 });
  assert.deepEqual(await fetchSource(db, src), { added: 0 }, 'second fetch adds nothing');
  const row = db.prepare('SELECT * FROM items WHERE source_id = ?').get(id);
  assert.equal(row.image, 'https://guitar.example.org/img.jpg');
  assert.equal(row.domain, 'guitar.example.org');
});

test('fetch errors are recorded on the source', async () => {
  const db = openDb(':memory:');
  const id = db.prepare("INSERT INTO sources (topic_id, kind, name, config) VALUES (1, 'rss', 'bad', ?)").run(JSON.stringify({ url: `${base}/nope.xml` })).lastInsertRowid;
  const r = await fetchSource(db, db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
  assert.ok(r.error);
  assert.ok(db.prepare('SELECT last_error FROM sources WHERE id = ?').get(id).last_error);
});
