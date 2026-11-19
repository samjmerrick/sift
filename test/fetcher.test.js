import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { previewSource, normaliseUrl, htmlToText, truncate, keywordRegex } from '../supabase/functions/_shared/fetcher.js';
import { fetchSource, fetchAll } from '../supabase/functions/_shared/store.js';
import { freshDb } from './db.js';

let server, base, sql;
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
  sql = await freshDb({ packs: ['ai', 'russian'] });
});
after(async () => { server.close(); await sql.end(); });

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

test('rss feed: exclude keywords, image extraction, saving and dedupe (Postgres)', async () => {
  const [topic] = await sql`select id from topics limit 1`;
  const [src] = await sql`insert into sources (topic_id, kind, name, config, exclude)
    values (${topic.id}, 'rss', 't', ${sql.json({ url: `${base}/rss.xml` })}, 'sponsored') returning *`;
  assert.deepEqual(await fetchSource(sql, src), { added: 1 });
  assert.deepEqual(await fetchSource(sql, src), { added: 0 }, 'second fetch adds nothing');
  const [row] = await sql`select * from items where source_id = ${src.id}`;
  assert.equal(row.image, 'https://guitar.example.org/img.jpg');
  assert.equal(row.domain, 'guitar.example.org');
  assert.equal(row.title, 'Three exercises for cleaner chord changes');
  const [s] = await sql`select last_fetched, last_error from sources where id = ${src.id}`;
  assert.ok(s.last_fetched && s.last_error === null);
});

test('fetch errors are recorded on the source; fetchAll continues past them', async () => {
  await sql`update sources set enabled = false`;
  const [topic] = await sql`select id from topics limit 1`;
  await sql`insert into sources (topic_id, kind, name, config) values (${topic.id}, 'rss', 'bad', ${sql.json({ url: `${base}/nope.xml` })})`;
  await sql`insert into sources (topic_id, kind, name, config) values (${topic.id}, 'rss', 'good', ${sql.json({ url: `${base}/atom.xml` })})`;
  const results = await fetchAll(sql, { enrich: false });
  assert.match(results.bad.error, /HTTP 404/);
  assert.equal(results.good.added, 1);
  const [bad] = await sql`select last_error from sources where name = 'bad'`;
  assert.match(bad.last_error, /404/);
});
