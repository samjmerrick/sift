import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { sanitiseHtml, extractArticle, readItem, getContent } from '../supabase/functions/_shared/reader.js';
import { fetchSource } from '../supabase/functions/_shared/store.js';
import { freshDb, asUser } from './db.js';

let server, base, sql, hits;
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  .replaceAll('RECENT_RFC', new Date(Date.now() - 3600e3).toUTCString());

before(async () => {
  server = createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/article') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture('article.html'));
    if (req.url === '/short') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><p>Too short.</p></body></html>');
    if (req.url === '/rss-full.xml') return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(fixture('rss-full.xml'));
    res.writeHead(500).end();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  hits = {};
  sql = await freshDb({ packs: ['ai'] });
});
after(async () => { server.close(); await sql.end(); });

async function addItem(url, extra = {}) {
  const [topic] = await sql`select id from topics limit 1`;
  const [src] = await sql`insert into sources (topic_id, kind, name, config) values (${topic.id}, 'rss', ${`s${Math.random()}`}, '{}') returning id`;
  const [item] = await sql`insert into items (source_id, topic_id, url, title, title_key, summary, domain, published_at)
    values (${src.id}, ${topic.id}, ${url}, 'T', ${`t${Math.random()}`}, '', ${extra.domain ?? 'example.org'}, now()) returning *`;
  return item;
}

test('sanitiser strips dangerous content and attributes', () => {
  const out = sanitiseHtml(`<p onclick="x()" style="color:red" class="a" id="b">Hi <script>alert(1)</script><style>p{}</style>
    <a href="javascript:alert(1)">bad</a> <iframe src="https://e.com"></iframe><form><input></form><b>ok</b></p>`, 'https://site.test/a/');
  assert.ok(out.startsWith('<p>Hi') && out.includes('bad') && out.includes('<b>ok</b>'));
  assert.ok(!/onclick|style|class|id=|script|iframe|javascript/.test(out));
});

test('sanitiser resolves links and images, unwraps unknown tags, demotes h1', () => {
  const out = sanitiseHtml(`<h1>Title</h1><div><span>kept <custom-tag>text</custom-tag></span></div>
    <a href="../x?a=1&b=2" target="_blank">rel</a><a href="mailto:a@b.c">mail</a>
    <img data-src="/pic.png" src="data:image/gif;base64,AAA" alt='say "hi"'><img src="ftp://x/y.png">
    <table><tr><td colspan="2" onclick="x">c</td></tr></table><p>&nbsp;</p><p></p>`, 'https://site.test/a/b');
  assert.ok(out.includes('<h2>Title</h2>'));
  assert.ok(out.includes('kept text'));
  assert.ok(!out.includes('<div') && !out.includes('custom-tag'));
  assert.ok(out.includes('<a href="https://site.test/x?a=1&amp;b=2">rel</a>'));
  assert.ok(!out.includes('mailto'));
  assert.ok(out.includes('<img src="https://site.test/pic.png" alt="say &quot;hi&quot;">'));
  assert.ok(!out.includes('ftp:'));
  assert.ok(out.includes('<td colspan="2">c</td>'));
  assert.ok(!out.includes('<p></p>'));
});

test('extractArticle returns the body, not the chrome', () => {
  const a = extractArticle(fixture('article.html'), `${base}/article`);
  assert.match(a.title, /practise well/i);
  assert.ok(a.html.includes('Paragraph 3.'));
  assert.ok(a.html.includes(`href="${base}/notes/2"`));
  assert.ok(a.html.includes(`src="${base}/img/diagram.png"`));
  assert.ok(!a.html.includes('Subscribe now') && !a.html.includes('gadgets') && !a.html.includes('injected') && !a.html.includes('never read'));
  assert.equal(a.lead_image, 'https://cdn.example.org/lead.jpg');
  assert.equal(a.site_name, 'Example Magazine');
  assert.ok(a.text_length > 1000);
});

test('extractArticle throws on short pages', () => {
  assert.throws(() => extractArticle('<html><body><p>Too short.</p></body></html>', `${base}/short`), /Couldn't find the article text/);
});

test('readItem caches; getContent does not refetch', async () => {
  const item = await addItem(`${base}/article`);
  const first = await getContent(sql, item.id);
  assert.equal(first.status, 'ok');
  assert.equal(first.url, item.url);
  assert.ok(first.html.includes('Paragraph 1.'));
  const second = await getContent(sql, item.id);
  assert.deepEqual(second, first);
  assert.equal(hits['/article'], 1);
  const [{ n }] = await sql`select count(*)::int as n from item_content where item_id = ${item.id}`;
  assert.equal(n, 1);
});

test('failed fetches are stored, and retried only after 24 hours', async () => {
  const item = await addItem(`${base}/broken`);
  const r = await getContent(sql, item.id);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /HTTP 500/);
  await getContent(sql, item.id);
  assert.equal(hits['/broken'], 1, 'recent failure is not retried');
  await sql`update item_content set fetched_at = now() - interval '25 hours' where item_id = ${item.id}`;
  await getContent(sql, item.id);
  assert.equal(hits['/broken'], 2);
  const short = await addItem(`${base}/short`);
  const row = await readItem(sql, short);
  assert.equal(row.status, 'failed');
  assert.ok(row.error.length <= 300);
});

test('getContent throws for a missing item', async () => {
  await assert.rejects(getContent(sql, 999999), /not found/i);
});

test('feed_state excludes items from muted domains', async () => {
  const keep = await addItem(`${base}/k1`, { domain: 'good.example' });
  const muted = await addItem(`${base}/k2`, { domain: 'bad.example' });
  const ids = async () => (await asUser(sql, (tx) => tx`select feed_state() as s`))[0].s.items.map((i) => Number(i.id));
  assert.ok((await ids()).includes(Number(muted.id)));
  await asUser(sql, (tx) => tx`insert into muted_domains (domain) values ('bad.example')`);
  const after = await ids();
  assert.ok(after.includes(Number(keep.id)));
  assert.ok(!after.includes(Number(muted.id)));
});

test('full-content RSS stores item_content at fetch time', async () => {
  const [topic] = await sql`select id from topics limit 1`;
  const [src] = await sql`insert into sources (topic_id, kind, name, config)
    values (${topic.id}, 'rss', 'full', ${sql.json({ url: `${base}/rss-full.xml` })}) returning *`;
  assert.deepEqual(await fetchSource(sql, src), { added: 1 });
  const [row] = await sql`select c.* from item_content c join items i on i.id = c.item_id where i.source_id = ${src.id}`;
  assert.equal(row.status, 'ok');
  assert.ok(row.text_length >= 1500);
  assert.ok(row.html.includes('Long form content'));
  assert.ok(row.html.includes('href="https://full.example.org/rel"'));
  assert.ok(!row.html.includes('alert'));
  await fetchSource(sql, src);
  const [{ n }] = await sql`select count(*)::int as n from item_content c join items i on i.id = c.item_id where i.source_id = ${src.id}`;
  assert.equal(n, 1);
});
