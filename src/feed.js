import { GENERATOR_KINDS } from './generators.js';

const HOUR = 3600000;

function weightedPick(entries, weightOf) {
  const total = entries.reduce((s, e) => s + Math.max(0, weightOf(e)), 0);
  if (total <= 0) return entries[0];
  let r = Math.random() * total;
  for (const e of entries) {
    r -= Math.max(0, weightOf(e));
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

/** Personal affinity per source/domain from your 👍/👎 history: (up+1)/(down+1), clamped. */
function affinities(db) {
  const bySource = new Map();
  const byDomain = new Map();
  for (const r of db.prepare(`SELECT source_id, domain, SUM(reaction = 1) up, SUM(reaction = -1) down
      FROM items WHERE reaction != 0 GROUP BY source_id, domain`).all()) {
    const add = (m, k) => { const v = m.get(k) || [0, 0]; v[0] += r.up; v[1] += r.down; m.set(k, v); };
    add(bySource, r.source_id);
    if (r.domain) add(byDomain, r.domain);
  }
  const score = (m, k) => { const v = m.get(k); return v ? Math.min(2, Math.max(0.4, (v[0] + 1) / (v[1] + 1))) : 1; };
  return { source: (id) => score(bySource, id), domain: (d) => score(byDomain, d) };
}

export function rankItems(db, topicId, exclude, limit = 60) {
  const aff = affinities(db);
  const now = Date.now();
  const rows = db.prepare(`SELECT i.*, s.name source_name, s.weight source_weight, s.kind source_kind
      FROM items i JOIN sources s ON s.id = i.source_id
      WHERE i.topic_id = ? AND i.seen_at IS NULL AND s.enabled = 1 ORDER BY i.published_at DESC LIMIT 400`).all(topicId);
  return rows
    .filter((r) => !exclude.has(r.id))
    .map((r) => {
      const community = r.community_score != null ? 1 + Math.log10(1 + r.community_score) / 3 : 1.4;
      const ageH = Math.max(0, (now - r.published_at) / HOUR);
      const recency = 1 / (1 + ageH / 48);
      return { ...r, rank: r.source_weight * community * recency * aff.source(r.source_id) * aff.domain(r.domain) };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

function articleCard(r, topic) {
  return {
    key: `item:${r.id}`, kind: 'article', item_id: r.id, topic_id: topic.id,
    title: r.title, summary: (r.summary || '').trim(), url: r.url, domain: r.domain, image: r.image,
    source: r.source_name, comments_url: r.comments_url, score: r.community_score, comments: r.comment_count,
    published_at: r.published_at, reaction: r.reaction, saved: !!r.saved_at,
  };
}

/**
 * Build the next page of the feed.
 * opts: { n, topicId (filter), excludeItems: number[], recentKeys: string[], recentTopics: number[] }
 */
export function buildFeed(db, opts = {}) {
  const n = Math.min(Number(opts.n) || 10, 30);
  let topics = db.prepare('SELECT * FROM topics WHERE enabled = 1 ORDER BY position').all();
  if (opts.topicId) topics = topics.filter((t) => t.id === Number(opts.topicId));
  const excludeItems = new Set((opts.excludeItems || []).map(Number));
  const excludeKeys = new Set(opts.recentKeys || []);
  const recentTopics = [...(opts.recentTopics || [])].map(Number);
  const gens = db.prepare('SELECT * FROM generators WHERE enabled = 1').all();
  const ranked = new Map();
  const curated = (t) => {
    if (!ranked.has(t.id)) ranked.set(t.id, rankItems(db, t.id, excludeItems));
    return ranked.get(t.id);
  };
  const exhausted = new Set();
  const out = [];

  while (out.length < n) {
    let pool = topics.filter((t) => !exhausted.has(t.id));
    if (!pool.length) break;
    // Avoid three cards in a row from the same topic.
    const [a, b] = recentTopics.slice(-2);
    if (pool.length > 1 && a && a === b) pool = pool.filter((t) => t.id !== a) || pool;
    const topic = weightedPick(pool, (t) => t.weight);

    const articles = curated(topic);
    const topicGens = gens.filter((g) => g.topic_id === topic.id && GENERATOR_KINDS[g.kind]);
    let card = null;
    const preferArticle = articles.length && (!topicGens.length || Math.random() < topic.curated_ratio);
    if (preferArticle) card = articleCard(articles.shift(), topic);
    if (!card) card = generate(db, topicGens, excludeKeys, topic);
    if (!card && articles.length) card = articleCard(articles.shift(), topic);
    if (!card) { exhausted.add(topic.id); continue; }

    if (card.item_id) excludeItems.add(card.item_id);
    excludeKeys.add(card.key);
    recentTopics.push(topic.id);
    out.push(card);
  }
  return out;
}

function generate(db, gens, excludeKeys, topic) {
  const remaining = [...gens];
  while (remaining.length) {
    const g = weightedPick(remaining, (x) => x.weight);
    remaining.splice(remaining.indexOf(g), 1);
    const cfg = JSON.parse(g.config || '{}');
    // Random generators may collide with recently shown cards; retry a few times.
    for (let attempt = 0; attempt < 6; attempt++) {
      let card;
      try {
        card = GENERATOR_KINDS[g.kind].generate(cfg, { db, excludeKeys, generatorId: g.id });
      } catch (err) {
        console.error(`generator ${g.id} (${g.kind}) failed:`, err);
        break;
      }
      if (!card) break;
      if (!excludeKeys.has(card.key) || attempt === 5) {
        return { ...card, topic_id: topic.id, generator_id: g.id, generator: g.name };
      }
    }
  }
  return null;
}
