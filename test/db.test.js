import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asUser } from './db.js';

const sql = await freshDb();
after(() => sql.end());

test('seed data is present', async () => {
  const [r] = await sql`select (select count(*) from topics)::int t, (select count(*) from sources)::int s,
    (select count(*) from cards)::int c, (select count(*) from generators)::int g`;
  assert.deepEqual(r, { t: 4, s: 21, c: 90, g: 9 });
  const [fc] = await sql`select config from generators where kind = 'flashcards'`;
  const [deck] = await sql`select id from decks`;
  assert.equal(Number(fc.config.deck_id), Number(deck.id));
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
    const [{ feed_state: state }] = await tx`select feed_state()`;
    assert.equal(state.topics.length, 4);
    assert.ok(state.decks[deck.id].new.length === 1);
    const sources = await tx`select * from source_stats`;
    assert.equal(sources.length, 21);
  });
});
