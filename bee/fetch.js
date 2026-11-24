// Hourly fetch for Sift on bee: pulls new articles from every enabled source into the personal database, fills in
// missing summaries, saves reader text for new articles (the artifact can't load other websites), and drops old
// articles. The same rules as the Supabase version (supabase/functions/_shared/store.js), on the SQLite file.
//
//   BEE_DB=~/services/bee-database/data/bee.db node bee/fetch.js
//
// Suggested crontab line (bee):  17 * * * *  cd ~/sift && BEE_DB=... node bee/fetch.js >> ~/sift-fetch.log 2>&1
import { openBee } from './store.js';
import { previewSource, normaliseUrl, titleKey, domainOf, get, decodeEntities, htmlToText, truncate } from '../supabase/functions/_shared/fetcher.js';
import { sanitiseHtml, extractFor } from '../supabase/functions/_shared/reader.js';

const DAY = 86400000;
const READER_PER_RUN = Number(process.env.SIFT_READER_PER_RUN || 40);
const ENRICH_PER_RUN = 25;

const bee = openBee();
const iso = (d = new Date()) => new Date(d).toISOString();
const results = {};

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

// ---- articles ----
const sources = bee.rows('sources').filter((s) => s.enabled !== false);
const items = bee.rows('items');
const byUrl = new Map(items.map((i) => [i.url, i]));
const recentKeys = new Set(items.filter((i) => Date.parse(i.fetched_at) > Date.now() - 14 * DAY).map((i) => i.title_key));
let nextItemId = bee.nextId('items');
const added = [];

await pool(sources, 3, async (src) => {
  let n = 0;
  try {
    const found = await previewSource(src);
    const now = new Date();
    for (const i of found) {
      const url = normaliseUrl(i.url);
      const key = titleKey(i.title || '');
      if (!key) continue;
      const old = byUrl.get(url);
      if (old && i.community_score != null) {
        bee.patch('items', old.id, { community_score: i.community_score, comment_count: i.comment_count ?? null });
      }
      if (old || recentKeys.has(key)) continue;
      const item = {
        id: nextItemId++, source_id: src.id, topic_id: src.topic_id, url, title: i.title.trim(), title_key: key,
        summary: i.summary || '', image: i.image || null, domain: domainOf(url), comments_url: i.comments_url || null,
        community_score: i.community_score ?? null, comment_count: i.comment_count ?? null,
        published_at: iso(Math.min(i.published || Date.now(), Date.now())), fetched_at: iso(now),
        seen_at: null, reaction: 0, saved_at: null,
      };
      bee.insert('items', item);
      byUrl.set(url, item); recentKeys.add(key); added.push(item); n++;
      if (i.content_html) {
        const clean = sanitiseHtml(i.content_html, url);
        bee.insert('item_content', { item_id: item.id, status: 'ok', title: item.title, byline: null, site_name: null, html: clean,
          text_length: htmlToText(clean).length, lead_image: item.image, error: null, fetched_at: iso(now) });
      }
    }
    bee.patch('sources', src.id, { last_fetched: iso(now), last_error: null });
    results[src.name] = { added: n };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    bee.patch('sources', src.id, { last_fetched: iso(), last_error: message });
    results[src.name] = { added: n, error: message };
  }
});

// ---- summaries from the page's meta description ----
const needSummary = bee.rows('items')
  .filter((i) => i.summary === '' && !i.seen_at && !/news\.ycombinator\.com/.test(i.url))
  .sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at)).slice(0, ENRICH_PER_RUN);
await pool(needSummary, 4, async (row) => {
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
  bee.patch('items', row.id, row.image || !image ? { summary } : { summary, image }, { content: [row.title, summary.trim(), row.url].filter(Boolean).join('\n') });
});

// ---- reader text, newest unread first (YouTube plays in place; no text to save) ----
// Failed reads are retried after a day, as in the Supabase version.
const haveText = new Set(bee.rows('item_content')
  .filter((c) => c.status === 'ok' || Date.now() - Date.parse(c.fetched_at) < DAY).map((c) => c.item_id));
const needText = bee.rows('items')
  .filter((i) => !haveText.has(i.id) && (!i.seen_at || i.saved_at) && i.domain !== 'youtube.com')
  .sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at)).slice(0, READER_PER_RUN);
let readOk = 0;
await pool(needText, 4, async (item) => {
  let row;
  try {
    const a = await extractFor(item);
    row = { status: 'ok', title: a.title, byline: a.byline, site_name: a.site_name, html: a.html, text_length: a.text_length, lead_image: a.lead_image, error: null };
    readOk++;
  } catch (err) {
    row = { status: 'failed', title: null, byline: null, site_name: null, html: '', text_length: 0, lead_image: null, error: String(err?.message || err).slice(0, 300) };
  }
  bee.remove('item_content', item.id); // an old failure, if any
  bee.insert('item_content', { item_id: item.id, ...row, fetched_at: iso() });
});

// ---- housekeeping: drop old, unsaved articles (and their reader text) ----
const cutoffSeen = Date.now() - 30 * DAY;
const cutoffFetched = Date.now() - 60 * DAY;
const old = bee.rows('items').filter((i) => !i.saved_at
  && ((i.seen_at && Date.parse(i.seen_at) < cutoffSeen) || Date.parse(i.fetched_at) < cutoffFetched));
bee.transaction(() => { for (const i of old) { bee.remove('items', i.id); bee.remove('item_content', i.id); } });

let errors = 0;
for (const [name, r] of Object.entries(results)) {
  if (r.error) errors++;
  console.log(`${name.padEnd(28)} ${r.error ? `ERROR: ${r.error}` : `+${r.added}`}`);
}
console.log(`${iso()}  ${added.length} new, ${needSummary.length} summaries checked, reader text ${readOk}/${needText.length}, ${old.length} old removed`);
bee.close();
if (errors && errors === Object.keys(results).length) process.exitCode = 1;
