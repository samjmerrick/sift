// The reader's client-side sanitiser, run under Node with linkedom as the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { sanitiseHtml, safeHttpUrl } from '../public/lib/sanitise.js';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
const parse = (html) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
const clean = (html) => {
  const box = document.createElement('div');
  box.appendChild(sanitiseHtml(html, { doc: document, parse }));
  return box;
};

test('removes script, style, iframe and other active content with their contents', () => {
  const box = clean('<p>a</p><script>alert(1)</script><style>p{display:none}</style><iframe src="https://evil.test"></iframe><object data="x"></object><form><input></form><svg onload="x()"><circle/></svg><p>b</p>');
  assert.equal(box.innerHTML, '<p>a</p><p>b</p>');
});

test('strips on* handlers, style, class and id attributes', () => {
  const box = clean('<p onclick="x()" style="color:red" class="c" id="i" data-x="1">hi</p><a href="https://example.com/" onmouseover="x()" style="a:b">l</a><img src="https://example.com/i.png" onerror="x()">');
  const p = box.querySelector('p');
  assert.deepEqual([...p.attributes].map((a) => a.name), []);
  assert.deepEqual([...box.querySelector('a').attributes].map((a) => a.name).sort(), ['href', 'rel', 'target']);
  assert.equal(box.querySelector('img').hasAttribute('onerror'), false);
});

test('only http(s) links and images survive', () => {
  const box = clean('<a href="javascript:alert(1)">x</a><a href=" JaVa\nScRiPt:alert(1)">y</a><a href="data:text/html,hi">z</a><a href="//evil.test/">p</a><a href="/relative">r</a><a href="https://ok.test/a?b=1#c">ok</a>'
    + '<img src="javascript:x"><img src="data:image/png;base64,AAAA"><img src="https://ok.test/i.png" alt="pic">');
  const hrefs = [...box.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, [null, null, null, null, null, 'https://ok.test/a?b=1#c']);
  assert.deepEqual([...box.querySelectorAll('img')].map((i) => i.getAttribute('src')), ['https://ok.test/i.png']);
  assert.equal(box.querySelector('img').getAttribute('alt'), 'pic');
});

test('external links open safely', () => {
  const a = clean('<a href="https://example.com">x</a>').querySelector('a');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.match(a.getAttribute('rel'), /noopener/);
});

test('allowed structure survives', () => {
  const html = '<h2>H</h2><p>one <strong>b</strong> <em>i</em> <code>c</code><br></p><ul><li>a</li></ul><ol start="3"><li>b</li></ol><blockquote><p>q</p></blockquote>'
    + '<pre><code>x = 1</code></pre><figure><img src="https://e.test/a.png" alt=""><figcaption>cap</figcaption></figure>'
    + '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><dl><dt>t</dt><dd>d</dd></dl>';
  const box = clean(html);
  for (const sel of ['h2', 'p strong', 'p em', 'p code', 'ul li', 'ol[start="3"] li', 'blockquote p', 'pre code', 'figure img', 'figure figcaption', 'table thead th[colspan="2"]', 'tbody td', 'dl dt', 'dl dd']) {
    assert.ok(box.querySelector(sel), `expected ${sel}`);
  }
});

test('unknown wrappers are unwrapped, h1 becomes h2, comments dropped', () => {
  const box = clean('<div><section><span>text</span><!-- c --><h1>Big</h1></section></div>');
  assert.equal(box.innerHTML, 'text<h2>Big</h2>');
});

test('text is escaped, not interpreted', () => {
  const box = clean('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(box.querySelector('script'), null);
  assert.equal(box.textContent, '<script>alert(1)</script>');
});

test('safeHttpUrl', () => {
  assert.equal(safeHttpUrl('https://a.test/x'), 'https://a.test/x');
  assert.equal(safeHttpUrl('  http://a.test '), 'http://a.test');
  assert.equal(safeHttpUrl('ftp://a.test'), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl('https://'), null);
});
