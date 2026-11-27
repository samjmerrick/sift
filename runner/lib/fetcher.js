// Fetches and filters articles from configured sources. Filtering is rules + community scores, not an LLM.
// Runtime-agnostic (Node 20+ and Deno): uses only fetch, TextDecoder and fast-xml-parser.
import { XMLParser } from 'fast-xml-parser';

const UA = 'Sift/0.1 (self-hosted feed reader)';
const DAY = 86400000;
const FULL_TEXT_MIN = 1500;

// ---------- text helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h\d|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
export function truncate(text, max = 420) {
  const t = text.replace(/\n+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:\-–—]$/, '') + '…';
}
export function normaliseUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\.|^old\.|^m\./, '');
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_src$|fbclid$|gclid$|mc_|source$)/i.test(k)) url.searchParams.delete(k);
    }
    url.protocol = 'https:';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return u;
  }
}
export const titleKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const kwList = (s) => String(s || '').split(',').map((k) => k.trim()).filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function keywordRegex(keywords) {
  const kws = kwList(keywords);
  if (!kws.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(${kws.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

// ---------- HTTP ----------
export async function get(url, { timeout = 15000, maxBytes = 3_000_000, accept } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) } });
    } catch (err) {
      const why = err.name === 'AbortError' ? 'timed out' : err.cause?.code || err.cause?.message || err.message;
      throw new Error(`Could not reach ${new URL(url).hostname}: ${why}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      text += decoder.decode(value, { stream: true });
      if (size > maxBytes) { await reader.cancel().catch(() => {}); break; }
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- parsers ----------
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true, removeNSPrefix: false });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? '' : typeof x === 'object' ? String(x['#text'] ?? '') : String(x));

export function parseFeed(body) {
  const doc = xml.parse(body);
  const out = [];
  if (doc.rss || doc['rdf:RDF']) {
    const items = doc.rss ? arr(doc.rss.channel?.item) : arr(doc['rdf:RDF'].item);
    for (const it of items) {
      const full = txt(it['content:encoded']);
      const html = full || txt(it.description);
      const img = arr(it['media:thumbnail'])[0]?.['@url'] || arr(it['media:content']).find((m) => /image/.test(m?.['@type'] || 'image'))?.['@url']
        || arr(it.enclosure).find((e) => /^image\//.test(e?.['@type'] || ''))?.['@url'] || firstImage(html);
      out.push({
        title: txt(it.title), url: txt(it.link) || txt(it.guid), html,
        published: Date.parse(txt(it.pubDate) || txt(it['dc:date'])) || null, image: img || null,
        comments_url: txt(it.comments) || null, full,
      });
    }
  } else if (doc.feed) {
    for (const e of arr(doc.feed.entry)) {
      const links = arr(e.link);
      const link = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') || links[0];
      const group = e['media:group'] || {};
      const full = txt(e.content);
      const html = full || txt(e.summary) || txt(group['media:description']);
      out.push({
        title: txt(e.title), url: link?.['@href'] || txt(e.id), html,
        published: Date.parse(txt(e.published) || txt(e.updated)) || null, full,
        image: arr(group['media:thumbnail'])[0]?.['@url'] || arr(e['media:thumbnail'])[0]?.['@url'] || firstImage(html) || null,
      });
    }
  } else {
    throw new Error('Not an RSS or Atom feed');
  }
  return out.filter((i) => i.title && i.url);
}
function firstImage(html) {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
  return m && /^https?:/.test(m[1]) ? decodeEntities(m[1]) : null;
}

// ---------- source fetchers: return normalised candidate items ----------
async function fetchRss(cfg) {
  if (!cfg.url) throw new Error('Feed URL is required');
  const items = parseFeed(await get(cfg.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }));
  const cutoff = Date.now() - (Number(cfg.max_age_days) || 14) * DAY;
  return items
    .filter((i) => !i.published || i.published >= cutoff)
    .filter((i) => !/youtube\.com\/shorts\//.test(i.url || '')) // YouTube Shorts aren't worth a card
    .slice(0, 40)
    .map((i) => {
      const summary = truncate(htmlToText(i.html));
      // Link aggregators (Lobsters etc.) put only a "Comments" link in the description: leave it empty so the page's own description is used.
      // Full-text feeds: keep the body (only when it is long enough to be an article) so it can be stored for the reader.
      const content_html = i.full && htmlToText(i.full).length >= FULL_TEXT_MIN ? i.full : null;
      return { title: htmlToText(i.title), url: i.url, summary: /^comments$/i.test(summary) ? '' : summary, image: i.image, published: i.published || Date.now(), comments_url: i.comments_url, content_html };
    });
}

async function fetchHn(cfg) {
  const since = Math.floor((Date.now() - (Number(cfg.days) || 3) * DAY) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=200&numericFilters=points>=${Number(cfg.min_points) || 100},created_at_i>${since}`;
  const data = JSON.parse(await get(url));
  return data.hits.map((h) => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    summary: truncate(htmlToText(h.story_text || '')),
    published: h.created_at_i * 1000,
    community_score: h.points,
    comment_count: h.num_comments,
    comments_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

const FETCHERS = { rss: fetchRss, hn: fetchHn };

/** Fetch + filter a source definition without saving. */
export async function previewSource(src) {
  const cfg = typeof src.config === 'string' ? JSON.parse(src.config || '{}') : src.config || {};
  const fetcher = FETCHERS[src.kind];
  if (!fetcher) throw new Error(`Unknown source kind: ${src.kind}`);
  const items = await fetcher(cfg);
  const inc = keywordRegex(src.include);
  const exc = keywordRegex(src.exclude);
  return items.filter((i) => {
    const hay = `${i.title}\n${i.summary || ''}`;
    if (inc && !inc.test(src.kind === 'hn' ? i.title : hay)) return false;
    if (exc && exc.test(hay)) return false;
    return true;
  });
}

