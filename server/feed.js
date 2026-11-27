// feed_state() for D1: one SQL statement that builds the whole JSON document in the database, so the Worker passes
// the text through without parsing it (the free plan allows only 10 ms of CPU per request).

const obj = (alias, cols, { bools = [], jsons = [], skip = [] } = {}) =>
  `json_object(${cols.filter((c) => !skip.includes(c)).map((c) => {
    const ref = `${alias}."${c}"`;
    if (bools.includes(c)) return `'${c}', json(CASE WHEN ${ref} IS NULL THEN 'null' WHEN ${ref} THEN 'true' ELSE 'false' END)`;
    if (jsons.includes(c)) return `'${c}', json(${ref})`;
    return `'${c}', ${ref}`;
  }).join(', ')})`;

const TOPIC = ['id', 'name', 'color', 'weight', 'enabled', 'position', 'kind'];
const SOURCE = ['id', 'topic_id', 'kind', 'name', 'config', 'include', 'exclude', 'weight', 'enabled', 'last_fetched', 'last_error'];
const GENERATOR = ['id', 'topic_id', 'kind', 'name', 'config', 'weight', 'enabled'];
const ITEM = ['id', 'source_id', 'topic_id', 'url', 'title', 'title_key', 'summary', 'image', 'domain', 'comments_url', 'community_score',
  'comment_count', 'published_at', 'fetched_at', 'seen_at', 'reaction', 'saved_at'];
const CARD = ['id', 'deck_id', 'front', 'back', 'note', 'position', 'due', 'interval_days', 'ease', 'reps', 'lapses', 'introduced_at'];

const agg = (alias, cols, opts, from) => `json((SELECT COALESCE(json_group_array(json(j)), '[]') FROM (SELECT ${obj(alias, cols, opts)} AS j ${from})))`;

const DECK = `json_object(
  'name', d.name, 'lang', d.lang,
  'introduced_today', (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.introduced_at >= ?1),
  'due', ${agg('c', CARD, {}, `FROM cards c WHERE c.deck_id = d.id AND c.due IS NOT NULL AND c.due <= ?2 ORDER BY c.due LIMIT 60`)},
  'new', ${agg('c', CARD, {}, `FROM cards c WHERE c.deck_id = d.id AND c.due IS NULL ORDER BY c.position LIMIT 40`)},
  'sample', CASE WHEN EXISTS (SELECT 1 FROM generators g WHERE g.enabled AND g.kind = 'notes' AND json_extract(g.config, '$.deck_id') = d.id)
    THEN ${agg('c', CARD, {}, `FROM cards c WHERE c.deck_id = d.id ORDER BY random() LIMIT 30`)} ELSE json('[]') END)`;

export const FEED_STATE_SQL = `SELECT json_object(
  'topics', ${agg('t', TOPIC, { bools: ['enabled'] }, 'FROM topics t ORDER BY t.position, t.id')},
  'sources', ${agg('s', SOURCE, { bools: ['enabled'], jsons: ['config'] }, 'FROM sources s ORDER BY s.id')},
  'generators', ${agg('g', GENERATOR, { bools: ['enabled'], jsons: ['config'] }, 'FROM generators g WHERE g.enabled ORDER BY g.id')},
  'items', ${agg('i', ITEM, { skip: ['title_key', 'fetched_at'] }, `FROM items i JOIN sources s ON s.id = i.source_id
      WHERE i.seen_at IS NULL AND s.enabled AND NOT EXISTS (SELECT 1 FROM muted_domains m WHERE m.domain = i.domain)
      ORDER BY i.published_at DESC LIMIT 1000`)},
  'affinity', json((SELECT COALESCE(json_group_array(json(j)), '[]') FROM (SELECT json_object('source_id', source_id, 'domain', domain,
      'up', SUM(reaction = 1), 'down', SUM(reaction = -1)) AS j FROM items WHERE reaction <> 0 GROUP BY source_id, domain))),
  'decks', json((SELECT COALESCE(json_group_object(CAST(d.id AS TEXT), json(${DECK})), '{}') FROM decks d))
) AS state`;

/** The feed state as JSON text. `dayStart` is an ISO timestamp. */
export async function feedState(db, dayStart) {
  const start = new Date(dayStart);
  const from = Number.isNaN(start.getTime()) ? new Date(new Date().setUTCHours(0, 0, 0, 0)) : start;
  const horizon = new Date(Date.now() + 12 * 3600000);
  const row = await db.prepare(FEED_STATE_SQL).bind(from.toISOString(), horizon.toISOString()).first();
  return row.state;
}
