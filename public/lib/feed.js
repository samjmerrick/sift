// Builds feed pages in the browser from the state returned by the `feed_state` database function.
import { GENERATOR_KINDS } from './generators.js';

const HOUR = 3600000;
const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

/** Normalise raw feed_state JSON: timestamps → epoch ms, deck keys → numbers. */
export function normaliseState(raw) {
  const decks = {};
  for (const [id, d] of Object.entries(raw.decks || {})) {
    const cards = (list) => list.map((c) => ({ ...c, due: ms(c.due), introduced_at: ms(c.introduced_at) }));
    decks[Number(id)] = { name: d.name, introduced_today: d.introduced_today, due: cards(d.due), new: cards(d.new), sample: cards(d.sample || []) };
  }
  return {
    topics: raw.topics || [],
    sources: raw.sources || [],
    generators: raw.generators || [],
    items: (raw.items || []).map((i) => ({ ...i, published_at: ms(i.published_at), saved_at: ms(i.saved_at) })),
    affinity: raw.affinity || [],
    decks,
  };
}

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
function affinities(rows) {
  const bySource = new Map();
  const byDomain = new Map();
  for (const r of rows) {
    const add = (m, k) => { const v = m.get(k) || [0, 0]; v[0] += Number(r.up); v[1] += Number(r.down); m.set(k, v); };
    add(bySource, r.source_id);
    if (r.domain) add(byDomain, r.domain);
  }
  const score = (m, k) => { const v = m.get(k); return v ? Math.min(2, Math.max(0.4, (v[0] + 1) / (v[1] + 1))) : 1; };
  return { source: (id) => score(bySource, id), domain: (d) => score(byDomain, d) };
}

export function rankItems(state, topicId, exclude, now = Date.now()) {
  const aff = affinities(state.affinity);
  const sources = new Map(state.sources.map((s) => [s.id, s]));
  return state.items
    .filter((r) => r.topic_id === topicId && !exclude.has(r.id) && sources.get(r.source_id)?.enabled)
    .map((r) => {
      const src = sources.get(r.source_id);
      const community = r.community_score != null ? 1 + Math.log10(1 + r.community_score) / 3 : 1.4;
      const ageH = Math.max(0, (now - r.published_at) / HOUR);
      const recency = 1 / (1 + ageH / 48);
      return { ...r, source_name: src.name, rank: src.weight * community * recency * aff.source(r.source_id) * aff.domain(r.domain) };
    })
    .sort((a, b) => b.rank - a.rank);
}

export function articleCard(r) {
  return {
    key: `item:${r.id}`, kind: 'article', item_id: r.id, topic_id: r.topic_id, source_id: r.source_id,
    title: r.title, summary: (r.summary || '').trim(), url: r.url, domain: r.domain, image: r.image,
    source: r.source_name, comments_url: r.comments_url, score: r.community_score, comments: r.comment_count,
    published_at: r.published_at, reaction: r.reaction, saved: !!r.saved_at,
  };
}

/**
 * Build the next page of the feed.
 * opts: { n, topicIds (filter: array of topic ids; empty = all) or topicId, excludeItems: Set|array, recentKeys: Set|array, recentTopics: number[] }
 */
export function buildFeed(state, opts = {}) {
  const n = Math.min(Number(opts.n) || 10, 30);
  let topics = state.topics.filter((t) => t.enabled);
  const only = new Set((opts.topicIds ?? (opts.topicId ? [opts.topicId] : [])).map(Number));
  if (only.size) topics = topics.filter((t) => only.has(t.id));
  const excludeItems = new Set(opts.excludeItems || []);
  const excludeKeys = new Set(opts.recentKeys || []);
  const recentTopics = [...(opts.recentTopics || [])];
  const gens = state.generators.filter((g) => g.enabled && GENERATOR_KINDS[g.kind]);
  const ranked = new Map();
  const curated = (t) => {
    if (!ranked.has(t.id)) ranked.set(t.id, rankItems(state, t.id, excludeItems));
    return ranked.get(t.id);
  };
  const exhausted = new Set();
  const out = [];

  while (out.length < n) {
    let pool = topics.filter((t) => !exhausted.has(t.id));
    if (!pool.length) break;
    // Avoid three cards in a row from the same topic.
    const [a, b] = recentTopics.slice(-2);
    if (pool.length > 1 && a != null && a === b) pool = pool.filter((t) => t.id !== a);
    const topic = weightedPick(pool, (t) => t.weight);

    const articles = curated(topic);
    const topicGens = gens.filter((g) => g.topic_id === topic.id);
    let card = null;
    if (articles.length && (!topicGens.length || Math.random() < topic.curated_ratio)) card = articleCard(articles.shift());
    if (!card) card = generate(state, topicGens, excludeKeys, topic);
    if (!card && articles.length) card = articleCard(articles.shift());
    if (!card) { exhausted.add(topic.id); continue; }

    if (card.item_id) excludeItems.add(card.item_id);
    excludeKeys.add(card.key);
    recentTopics.push(topic.id);
    out.push(card);
  }
  return out;
}

export function generateOne(state, g, excludeKeys = new Set()) {
  return GENERATOR_KINDS[g.kind]?.generate(g.config || {}, { decks: state.decks, excludeKeys, generatorId: g.id }) ?? null;
}

function generate(state, gens, excludeKeys, topic) {
  const remaining = [...gens];
  while (remaining.length) {
    const g = weightedPick(remaining, (x) => x.weight);
    remaining.splice(remaining.indexOf(g), 1);
    // Random generators may collide with recently shown cards; retry a few times.
    for (let attempt = 0; attempt < 6; attempt++) {
      let card;
      try {
        card = generateOne(state, g, excludeKeys);
      } catch (err) {
        console.error(`card type ${g.id} (${g.kind}) failed:`, err);
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
