// In-app reader: extracts the readable article from a page, sanitises it with a strict allowlist, and caches it
// in item_content. Runtime-agnostic (Node 20+ and Deno): linkedom + @mozilla/readability + fetch.
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { get, htmlToText, decodeEntities } from './fetcher.js';

const MIN_TEXT = 400;
const RETRY_FAILED_AFTER_MS = 24 * 3600e3;

const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup', 'small', 'mark', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd']);
const DROP = new Set(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'svg', 'canvas', 'video', 'audio', 'nav', 'aside', 'footer', 'template', 'head', 'title', 'link', 'meta']);
const VOID = new Set(['br', 'hr', 'img']);

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

function absolute(u, base) {
  if (!u) return null;
  try {
    const url = new URL(String(u).trim(), base || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pickImageSrc(el, base) {
  const direct = el.getAttribute('src');
  if (direct && !/^data:/i.test(direct.trim())) return absolute(direct, base);
  const lazy = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original');
  if (lazy) return absolute(lazy, base);
  const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
  if (srcset) {
    // Take the last (usually largest) candidate.
    const cands = srcset.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
    if (cands.length) return absolute(cands[cands.length - 1], base);
  }
  return null;
}

function walk(node, base) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += escText(child.nodeValue || ''); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.localName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) { out += walk(child, base); continue; }
    if (tag === 'a') {
      const href = absolute(child.getAttribute('href'), base);
      const inner = walk(child, base);
      out += href ? `<a href="${escAttr(href)}">${inner}</a>` : inner;
      continue;
    }
    if (tag === 'img') {
      const src = pickImageSrc(child, base);
      if (!src) continue;
      const alt = child.getAttribute('alt');
      out += `<img src="${escAttr(src)}"${alt ? ` alt="${escAttr(alt)}"` : ''}>`;
      continue;
    }
    const name = tag === 'h1' ? 'h2' : tag;
    if (VOID.has(tag)) { out += `<${name}>`; continue; }
    let attrs = '';
    if (tag === 'td' || tag === 'th') {
      for (const a of ['colspan', 'rowspan']) {
        const v = child.getAttribute(a);
        if (v && /^\d{1,3}$/.test(v.trim())) attrs += ` ${a}="${v.trim()}"`;
      }
    }
    out += `<${name}${attrs}>${walk(child, base)}</${name}>`;
  }
  return out;
}

/** Strict allowlist sanitiser: returns safe HTML with absolute http(s) links and images only. */
export function sanitiseHtml(html, baseUrl) {
  const { document } = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`);
  const out = walk(document.body, baseUrl);
  // Remove empty paragraphs (also those holding only whitespace or <br>).
  return out.replace(/<p>(?:\s|&nbsp;|<br>)*<\/p>/g, '').trim();
}

const metaContent = (document, selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';

/** Extract the main article from a page. Throws when too little text is found. */
export function extractArticle(html, url) {
  const { document } = parseHTML(html);
  const lead = absolute(decodeEntities(metaContent(document, 'meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]')), url);
  const siteMeta = metaContent(document, 'meta[property="og:site_name"]');
  const article = new Readability(document, { charThreshold: 200 }).parse();
  if (!article?.content) throw new Error("Couldn't find the article text on this page");
  const clean = sanitiseHtml(article.content, url);
  const text_length = htmlToText(clean).length;
  if (text_length < MIN_TEXT) throw new Error("Couldn't find the article text on this page");
  let host = null;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  return {
    title: article.title || null,
    byline: article.byline ? article.byline.trim() : null,
    site_name: article.siteName || siteMeta || host,
    html: clean,
    text_length,
    lead_image: lead,
  };
}

const hnId = (url) => {
  try {
    const u = new URL(url);
    return u.hostname === 'news.ycombinator.com' && u.pathname === '/item' && /^\d+$/.test(u.searchParams.get('id') || '') ? u.searchParams.get('id') : null;
  } catch { return null; }
};

/** Extract one item's readable text (an HN text post or the linked page). Throws when there is none. */
export async function extractFor(item) {
  const id = hnId(item.url);
  if (id) {
    const data = JSON.parse(await get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 12000 }));
    const clean = sanitiseHtml(data?.text || '', item.url);
    const text_length = htmlToText(clean).length;
    if (!text_length) throw new Error('This Hacker News post has no text of its own');
    return { title: item.title || data.title || null, byline: data.by || null, site_name: 'Hacker News', html: clean, text_length, lead_image: null };
  }
  const page = await get(item.url, { timeout: 12000, accept: 'text/html' });
  return extractArticle(page, item.url);
}

/** Extract and cache one item's content. Returns the item_content row. */
export async function readItem(sql, item) {
  let row;
  try {
    const a = await extractFor(item);
    row = { status: 'ok', title: a.title, byline: a.byline, site_name: a.site_name, html: a.html, text_length: a.text_length, lead_image: a.lead_image, error: null };
  } catch (err) {
    row = { status: 'failed', title: null, byline: null, site_name: null, html: '', text_length: 0, lead_image: null, error: String(err?.message || err).slice(0, 300) };
  }
  const [saved] = await sql`
    insert into item_content (item_id, status, title, byline, site_name, html, text_length, lead_image, error, fetched_at)
    values (${item.id}, ${row.status}, ${row.title}, ${row.byline}, ${row.site_name}, ${row.html}, ${row.text_length}, ${row.lead_image}, ${row.error}, now())
    on conflict (item_id) do update set status = excluded.status, title = excluded.title, byline = excluded.byline,
      site_name = excluded.site_name, html = excluded.html, text_length = excluded.text_length,
      lead_image = excluded.lead_image, error = excluded.error, fetched_at = excluded.fetched_at
    returning *`;
  return saved;
}

/** Cached content for an item (retrying failures after 24 hours), fetching it on first request. */
export async function getContent(sql, itemId) {
  const [item] = await sql`select id, url, summary, comments_url, title from items where id = ${itemId}`;
  if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });
  let [row] = await sql`select * from item_content where item_id = ${itemId}`;
  if (!row || (row.status === 'failed' && Date.now() - new Date(row.fetched_at).getTime() > RETRY_FAILED_AFTER_MS)) {
    row = await readItem(sql, item);
  }
  const { status, title, byline, site_name, html, text_length, lead_image, error } = row;
  return { status, title: title ?? item.title ?? null, byline, site_name, html, text_length, lead_image, error, url: item.url };
}
