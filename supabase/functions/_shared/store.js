// Persists fetched articles to Postgres. Used by the hourly GitHub Action (Node) and the Edge Function (Deno).
// `sql` is a client from the `postgres` package.
import { previewSource, normaliseUrl, titleKey, domainOf, get, decodeEntities, htmlToText, truncate } from './fetcher.js';

const DAY = 86400000;

export async function fetchSource(sql, src) {
  let added = 0;
  try {
    const items = await previewSource(src);
    const now = new Date();
    for (const i of items) {
      const url = normaliseUrl(i.url);
      const key = titleKey(i.title || '');
      if (!key) continue;
      if (i.community_score != null) {
        await sql`update items set community_score = ${i.community_score}, comment_count = ${i.comment_count ?? null} where url = ${url}`;
      }
      const [dup] = await sql`select 1 from items where title_key = ${key} and fetched_at > ${new Date(Date.now() - 14 * DAY)} limit 1`;
      if (dup) continue;
      const published = new Date(Math.min(i.published || Date.now(), Date.now()));
      const r = await sql`
        insert into items (source_id, topic_id, url, title, title_key, summary, image, domain, comments_url,
                           community_score, comment_count, published_at, fetched_at)
        values (${src.id}, ${src.topic_id}, ${url}, ${i.title.trim()}, ${key}, ${i.summary || ''}, ${i.image || null},
                ${domainOf(url)}, ${i.comments_url || null}, ${i.community_score ?? null}, ${i.comment_count ?? null},
                ${published}, ${now})
        on conflict (url) do nothing`;
      added += r.count;
    }
    await sql`update sources set last_fetched = ${now}, last_error = null where id = ${src.id}`;
    return { added };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    await sql`update sources set last_fetched = now(), last_error = ${message} where id = ${src.id}`;
    return { added, error: message };
  }
}

/** Fill in missing summaries from the page's meta description (capped per run). */
export async function enrichSummaries(sql, limit = 25) {
  const rows = await sql`
    select id, url from items
    where summary = '' and seen_at is null and url not like '%news.ycombinator.com%'
    order by fetched_at desc limit ${limit}`;
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const row = rows[i++];
      let summary = ' ';
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
      } catch {
        // leave a single space so we don't retry this page forever
      }
      await sql`update items set summary = ${summary}, image = coalesce(image, ${image}) where id = ${row.id}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

export async function fetchAll(sql, { enrich = true } = {}) {
  const sources = await sql`select * from sources where enabled order by id`;
  const results = {};
  let idx = 0;
  const worker = async () => {
    while (idx < sources.length) {
      const s = sources[idx++];
      results[s.name] = await fetchSource(sql, s);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (enrich) await enrichSummaries(sql);
  // Housekeeping: drop old, unsaved items.
  await sql`delete from items where saved_at is null
    and ((seen_at is not null and seen_at < now() - interval '30 days') or fetched_at < now() - interval '60 days')`;
  return results;
}
