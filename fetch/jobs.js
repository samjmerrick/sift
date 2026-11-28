// Fetching for Sift: the rules for pulling feeds, summaries and reader text, against a store (fetch/store.js).
import { previewSource, normaliseUrl, titleKey, domainOf, get, decodeEntities, htmlToText, truncate } from './lib/fetcher.js';
import { sanitiseHtml, extractFor } from './lib/reader.js';

const DAY = 86400000;
const iso = (d = new Date()) => new Date(d).toISOString();

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

/** Fetch the given sources (default: every enabled one). Returns { [source name]: { added, error? } }. */
export async function fetchSources(store, sources = store.rows('sources').filter((s) => s.enabled !== false)) {
  const items = store.rows('items');
  const byUrl = new Map(items.map((i) => [i.url, i]));
  const recentKeys = new Set(items.filter((i) => Date.parse(i.fetched_at) > Date.now() - 14 * DAY).map((i) => i.title_key));
  let nextId = store.nextId('items');
  const results = {};
  await pool(sources, 3, async (src) => {
    let added = 0;
    try {
      const found = await previewSource(src);
      const now = new Date();
      for (const i of found) {
        const url = normaliseUrl(i.url);
        const key = titleKey(i.title || '');
        if (!key) continue;
        const old = byUrl.get(url);
        if (old && i.community_score != null) store.patch('items', old.id, { community_score: i.community_score, comment_count: i.comment_count ?? null });
        if (old || recentKeys.has(key)) continue;
        const item = {
          id: nextId++, source_id: src.id, topic_id: src.topic_id, url, title: i.title.trim(), title_key: key,
          summary: i.summary || '', image: i.image || null, domain: domainOf(url), comments_url: i.comments_url || null,
          community_score: i.community_score ?? null, comment_count: i.comment_count ?? null,
          published_at: iso(Math.min(i.published || Date.now(), Date.now())), fetched_at: iso(now),
          seen_at: null, reaction: 0, saved_at: null,
        };
        store.insert('items', item);
        byUrl.set(url, item); recentKeys.add(key); added++;
        if (i.content_html) {
          const clean = sanitiseHtml(i.content_html, url);
          store.insert('item_content', { item_id: item.id, status: 'ok', title: item.title, byline: null, site_name: null, html: clean,
            text_length: htmlToText(clean).length, lead_image: item.image, error: null, fetched_at: iso(now) });
        }
      }
      store.patch('sources', src.id, { last_fetched: iso(now), last_error: null });
      results[src.name] = { added };
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      store.patch('sources', src.id, { last_fetched: iso(), last_error: message });
      results[src.name] = { added, error: message };
    }
  });
  await store.flush();
  return results;
}

/** Fill in missing summaries from the page's meta description (capped per run). Returns how many were checked. */
export async function enrichSummaries(store, limit = 25) {
  const rows = store.rows('items')
    .filter((i) => i.summary === '' && !i.seen_at && !/news\.ycombinator\.com/.test(i.url))
    .sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at)).slice(0, limit);
  await pool(rows, 4, async (row) => {
    let summary = ' '; // a single space so a page without one isn't retried forever
    let image = null;
    try {
      const html = await get(row.url, { timeout: 8000, maxBytes: 400_000, accept: 'text/html' });
      const meta = (name) => {
        const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i').exec(html)?.[0];
        return tag ? decodeEntities(/content=["']([^"']*)["']/i.exec(tag)?.[1] || '') : '';
      };
      summary = truncate(htmlToText(meta('og:description') || meta('description') || meta('twitter:description'))) || ' ';
      const img = meta('og:image');
      image = /^https?:/.test(img) ? img : null;
    } catch { /* keep the space */ }
    store.patch('items', row.id, row.image || !image ? { summary } : { summary, image },
      { content: [row.title, summary.trim(), row.url].filter(Boolean).join('\n') });
  });
  return rows.length;
}

/** Extract and store one item's reader text. Returns the item_content row. */
export async function readItem(store, item) {
  let row;
  try {
    const a = await extractFor(item);
    row = { status: 'ok', title: a.title, byline: a.byline, site_name: a.site_name, html: a.html, text_length: a.text_length, lead_image: a.lead_image, error: null };
  } catch (err) {
    row = { status: 'failed', title: null, byline: null, site_name: null, html: '', text_length: 0, lead_image: null, error: String(err?.message || err).slice(0, 300) };
  }
  const full = { item_id: item.id, ...row, fetched_at: iso() };
  store.remove('item_content', item.id); // an old failure, if any
  store.insert('item_content', full);
  await store.flush();
  return full;
}

/** Cached reader text for an item, fetching it on first request (failures are retried after a day). */
export async function getContent(store, item) {
  let row = await store.content(item.id);
  if (!row || (row.status === 'failed' && Date.now() - Date.parse(row.fetched_at) > DAY)) row = await readItem(store, item);
  const { status, title, byline, site_name, html, text_length, lead_image, error } = row;
  return { status, title: title ?? item.title ?? null, byline, site_name, html, text_length, lead_image, error, url: item.url };
}

/** Drop old, unsaved articles and their reader text. Returns how many went. */
export function prune(store) {
  const cutoffSeen = Date.now() - 30 * DAY;
  const cutoffFetched = Date.now() - 60 * DAY;
  const old = store.rows('items').filter((i) => !i.saved_at
    && ((i.seen_at && Date.parse(i.seen_at) < cutoffSeen) || Date.parse(i.fetched_at) < cutoffFetched));
  for (const i of old) { store.remove('items', i.id); store.remove('item_content', i.id); }
  return old.length;
}

/** The timed job: every source, then summaries, then housekeeping. */
export async function fetchAll(store) {
  const results = await fetchSources(store);
  const summaries = await enrichSummaries(store);
  const removed = prune(store);
  await store.flush();
  return { results, summaries, removed };
}
