import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asUser } from './db.js';

const sql = await freshDb();
after(() => sql.end());

test('a fresh install has no personal content', async () => {
  const [r] = await sql`select (select count(*) from topics)::int t, (select count(*) from sources)::int s,
    (select count(*) from cards)::int c, (select count(*) from generators)::int g, (select count(*) from decks)::int d`;
  assert.deepEqual(r, { t: 0, s: 0, c: 0, g: 0, d: 0 });
});

test('anonymous role cannot read or write anything', async () => {
  for (const q of ['select * from topics', 'select * from items', "insert into decks (name) values ('x')", 'select feed_state()']) {
    await assert.rejects(sql.begin(async (tx) => { await tx`set local role anon`; await tx.unsafe(q); }), /permission denied/, q);
  }
});

test('a signed-in account that is not the owner sees and changes nothing', async () => {
  const stranger = '00000000-0000-0000-0000-0000000000ff';
  await asUser(sql, async (tx) => {
    assert.equal((await tx`select * from topics`).length, 0);
    assert.equal((await tx`select * from source_stats`).length, 0);
    const [{ feed_state: state }] = await tx`select feed_state()`;
    assert.equal(state.topics.length, 0);
    assert.equal(state.items.length, 0);
    assert.equal((await tx`update topics set name = 'hacked' returning id`).length, 0);
  }, stranger);
  await assert.rejects(asUser(sql, (tx) => tx`insert into decks (name) values ('x')`, stranger), /row-level security/);
  const owners = await asUser(sql, (tx) => tx`select * from app_owner`, stranger).catch(() => []);
  assert.equal(owners.length, 0, 'owner table is not readable');
});

test('owner can use tables, views and feed_state', async () => {
  await asUser(sql, async (tx) => {
    const [deck] = await tx`insert into decks (name) values ('Test deck') returning id`;
    await tx`insert into cards (deck_id, front, back) values (${deck.id}, 'a', 'b')`;
    const [stats] = await tx`select * from deck_stats where id = ${deck.id}`;
    assert.equal(Number(stats.cards), 1);
    const [topic] = await tx`insert into topics (name) values ('T') returning id`;
    await tx`insert into sources (topic_id, kind, name, config) values (${topic.id}, 'rss', 'S', '{"url":"https://example.com/feed"}')`;
    const [{ feed_state: state }] = await tx`select feed_state()`;
    assert.equal(state.topics.length, 1);
    assert.ok(state.decks[deck.id].new.length === 1);
    const sources = await tx`select * from source_stats`;
    assert.equal(sources.length, 1);
  });
});

test('domain_stats counts items per domain and flags muted ones, including muted domains with no items', async () => {
  await asUser(sql, async (tx) => {
    const [topic] = await tx`insert into topics (name) values ('Domains') returning id`;
    const [src] = await tx`insert into sources (topic_id, kind, name, config) values (${topic.id}, 'rss', 'D', '{"url":"https://example.com/d"}') returning id`;
    const add = (n, domain, extra = {}) => tx`insert into items (source_id, topic_id, url, title, title_key, domain, published_at, seen_at, reaction)
      values (${src.id}, ${topic.id}, ${`https://${domain}/${n}`}, ${`t${n}`}, ${`t${n}`}, ${domain}, now() - ${`${n} hours`}::interval, ${extra.seen ? new Date() : null}, ${extra.reaction ?? 0})`;
    await add(1, 'a.example'); await add(2, 'a.example', { seen: true, reaction: 1 }); await add(3, 'a.example', { reaction: -1 });
    await add(4, 'b.example'); await add(5, 'c.example');
    await tx`insert into items (source_id, topic_id, url, title, title_key, published_at) values (${src.id}, ${topic.id}, 'https://nodomain/1', 'nd', 'nd', now())`;
    await tx`insert into muted_domains (domain) values ('b.example'), ('ghost.example')`;
    const rows = Object.fromEntries((await tx`select * from domain_stats order by total desc, domain`).map((r) => [r.domain, r]));
    assert.deepEqual(Object.keys(rows).sort(), ['a.example', 'b.example', 'c.example', 'ghost.example']);
    const a = rows['a.example'];
    assert.deepEqual([a.total, a.unread, a.up, a.down, a.muted].map(Number), [3, 2, 1, 1, 0]);
    assert.ok(a.last_published, 'last published is set');
    assert.equal(rows['b.example'].muted, true);
    assert.equal(rows['c.example'].muted, false);
    assert.deepEqual([rows['ghost.example'].total, rows['ghost.example'].unread].map(Number), [0, 0]);
    assert.equal(rows['ghost.example'].last_published, null);
    assert.equal(rows['ghost.example'].muted, true);
  });
});

test('anonymous role cannot read domain_stats', async () => {
  await assert.rejects(sql.begin(async (tx) => { await tx`set local role anon`; await tx`select * from domain_stats`; }), /permission denied/);
});

test('app_settings: owner can read and write, a stranger and anon cannot', async () => {
  const stranger = '00000000-0000-0000-0000-0000000000ff';
  await asUser(sql, async (tx) => {
    await tx`insert into app_settings (key, value) values ('falloff', '0.8'::jsonb)`;
    await tx`update app_settings set value = '0.7'::jsonb where key = 'falloff'`;
    const [row] = await tx`select value from app_settings where key = 'falloff'`;
    assert.equal(row.value, 0.7);
  });
  await asUser(sql, async (tx) => {
    assert.equal((await tx`select * from app_settings`).length, 0, 'stranger sees nothing');
    assert.equal((await tx`update app_settings set value = '1'::jsonb returning key`).length, 0);
  }, stranger);
  await assert.rejects(asUser(sql, (tx) => tx`insert into app_settings (key, value) values ('x', '1'::jsonb)`, stranger), /row-level security/);
  await assert.rejects(sql.begin(async (tx) => { await tx`set local role anon`; await tx`select * from app_settings`; }), /permission denied/);
});

test('split_mixed_topics turns mixed topics into an articles topic plus a practice topic', async () => {
  const mk = async (name, position, { src = true, gen = true, enabled = true } = {}) => {
    const [t] = await sql`insert into topics (name, color, weight, enabled, position) values (${name}, '#123456', 1.5, ${enabled}, ${position}) returning id`;
    if (src) await sql`insert into sources (topic_id, kind, name, config) values (${t.id}, 'rss', ${`${name} feed`}, '{"url":"https://x.test/feed"}')`;
    if (gen) await sql`insert into generators (topic_id, kind, name, config) values (${t.id}, 'prompts', ${`${name} prompts`}, '{"lines":"a"}')`;
    return t.id;
  };
  const mixed = await mk('Chess', 0);
  const clash = await mk('Chess practice', 1, { gen: false });
  const cardsOnly = await mk('Drills', 2, { src: false });
  const articlesOnly = await mk('News', 3, { gen: false });
  await sql`insert into saved_cards (topic_id, payload) values (${mixed}, '{}')`;
  assert.equal((await sql`select private.split_mixed_topics() n`)[0].n, 1);
  const kinds = Object.fromEntries((await sql`select id, kind from topics`).map((r) => [r.id, r.kind]));
  assert.deepEqual([kinds[mixed], kinds[clash], kinds[cardsOnly], kinds[articlesOnly]], ['articles', 'articles', 'cards', 'articles']);
  const [made] = await sql`select * from topics where name = 'Chess practice 2'`;
  assert.deepEqual([made.kind, made.color, made.weight, made.enabled, made.position], ['cards', '#123456', 1.5, true, 1], 'name clash gets a number; placed right after the original');
  assert.equal((await sql`select count(*)::int n from generators where topic_id = ${made.id}`)[0].n, 1, 'card types moved');
  assert.equal((await sql`select count(*)::int n from generators where topic_id = ${mixed}`)[0].n, 0);
  assert.equal((await sql`select count(*)::int n from sources where topic_id = ${mixed}`)[0].n, 1, 'sources stay');
  assert.equal((await sql`select count(*)::int n from saved_cards where topic_id = ${made.id}`)[0].n, 1, 'saved cards moved');
  const pos = Object.fromEntries((await sql`select name, position from topics`).map((r) => [r.name, r.position]));
  assert.deepEqual([pos['Chess'], pos['Chess practice 2'], pos['Chess practice'], pos['Drills'], pos['News']], [0, 1, 2, 3, 4], 'later topics shift down');
  assert.equal((await sql`select private.split_mixed_topics() n`)[0].n, 0, 'idempotent');
});
