import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitiseHtml, extractArticle } from '../fetch/lib/reader.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  .replaceAll('RECENT_RFC', new Date(Date.now() - 3600e3).toUTCString());

let server, base;
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/article') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture('article.html'));
    if (req.url === '/short') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body><p>Too short.</p></body></html>');
    res.writeHead(500).end();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

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
