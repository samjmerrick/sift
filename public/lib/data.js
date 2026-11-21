// All reads/writes go straight to Supabase (Postgres + row level security). No custom server.
import { normaliseState } from './feed.js';
import { parseCsv } from './csv.js';

export function createData(client) {
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message || String(error));
    return data;
  };
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const ms = (v) => (v == null ? null : Date.parse(v));

  return {
    client,

    // ---- auth ----
    async session() { return check(await client.auth.getSession()).session; },
    async signIn(email, password) { return check(await client.auth.signInWithPassword({ email, password })); },
    async signOut() { await client.auth.signOut(); },

    // ---- feed ----
    async feedState() {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      return normaliseState(check(await client.rpc('feed_state', { p_day_start: dayStart.toISOString() })));
    },
    async markSeen(ids) {
      if (ids.length) check(await client.from('items').update({ seen_at: new Date().toISOString() }).in('id', ids).is('seen_at', null));
    },
    async reactItem(id, reaction) { check(await client.from('items').update({ reaction }).eq('id', id)); },
    async saveItem(id, saved) { check(await client.from('items').update({ saved_at: saved ? new Date().toISOString() : null }).eq('id', id)); },
    async setGeneratorWeight(id, weight) { check(await client.from('generators').update({ weight }).eq('id', id)); },
    async updateCard(id, u) {
      check(await client.from('cards').update({
        due: iso(u.due), interval_days: u.interval_days, ease: u.ease, reps: u.reps, lapses: u.lapses, introduced_at: iso(u.introduced_at),
      }).eq('id', id));
    },

    // ---- hiding things ----
    async mutedDomains() { return check(await client.from('muted_domains').select('*').order('domain')); },
    async muteDomain(domain) {
      const { error } = await client.from('muted_domains').insert({ domain: String(domain).trim().toLowerCase() });
      if (error && error.code !== '23505') throw new Error(error.message || String(error)); // already muted is fine
    },
    async unmuteDomain(domain) { check(await client.from('muted_domains').delete().eq('domain', String(domain).trim().toLowerCase())); },

    // ---- reader ----
    /** One item plus its source name (for the reader when it isn't in the feed, e.g. after a reload or from Saved). */
    async item(id) {
      const [row] = check(await client.from('items').select('*').eq('id', id));
      if (!row) return null;
      const [src] = check(await client.from('sources').select('name').eq('id', row.source_id));
      return { ...row, source_name: src?.name || '', published_at: ms(row.published_at), saved_at: ms(row.saved_at) };
    },

    // ---- saved ----
    async saved() {
      const [items, cards] = await Promise.all([
        client.from('saved_items').select('*').order('saved_at', { ascending: false }).then(check),
        client.from('saved_cards').select('*').order('saved_at', { ascending: false }).then(check),
      ]);
      return {
        items: items.map((i) => ({ ...i, published_at: ms(i.published_at), saved_at: ms(i.saved_at) })),
        cards: cards.map((c) => ({ ...c, saved_at: ms(c.saved_at) })),
      };
    },
    async saveCard(topicId, payload) {
      return check(await client.from('saved_cards').insert({ topic_id: topicId, payload }).select('id').single()).id;
    },
    async deleteSavedCard(id) { check(await client.from('saved_cards').delete().eq('id', id)); },

    // ---- settings ----
    async topics() { return check(await client.from('topics').select('*').order('position').order('id')); },
    async sourceStats() {
      return check(await client.from('source_stats').select('*').order('topic_id').order('id'))
        .map((s) => ({ ...s, last_fetched: ms(s.last_fetched) }));
    },
    async domainStats() {
      return check(await client.from('domain_stats').select('*').order('total', { ascending: false }).order('domain'))
        .map((d) => ({ ...d, last_published: ms(d.last_published) }));
    },
    async generators() { return check(await client.from('generators').select('*').order('topic_id').order('id')); },
    async deckStats() { return check(await client.from('deck_stats').select('*').order('id')); },
    async deckCards(deckId) {
      return check(await client.from('cards').select('id, front, back, note, due, reps, interval_days').eq('deck_id', deckId).order('position'))
        .map((c) => ({ ...c, due: ms(c.due) }));
    },
    /** App-wide setting from `app_settings` (the fallback when the key has never been saved). */
    async setting(key, fallback) {
      const [row] = check(await client.from('app_settings').select('value').eq('key', key));
      return row ? row.value : fallback;
    },
    async setSetting(key, value) {
      const [row] = check(await client.from('app_settings').select('key').eq('key', key));
      if (row) check(await client.from('app_settings').update({ value }).eq('key', key));
      else check(await client.from('app_settings').insert({ key, value }));
    },
    async insert(table, row) { return check(await client.from(table).insert(row).select().single()); },
    async update(table, id, patch) { check(await client.from(table).update(patch).eq('id', id)); },
    async remove(table, id) { check(await client.from(table).delete().eq('id', id)); },
    // Bulk variants: one request per 200 ids keeps the `in.(…)` URL comfortably short.
    async updateMany(table, ids, patch) {
      for (let i = 0; i < ids.length; i += 200) check(await client.from(table).update(patch).in('id', ids.slice(i, i + 200)));
    },
    async removeMany(table, ids) {
      for (let i = 0; i < ids.length; i += 200) check(await client.from(table).delete().in('id', ids.slice(i, i + 200)));
    },
    async nextTopicPosition() {
      const rows = check(await client.from('topics').select('position').order('position', { ascending: false }).limit(1));
      return (rows[0]?.position ?? 0) + 1;
    },
    async importCards(deckId, csv) {
      const rows = parseCsv(csv);
      if (!rows.length) throw new Error('No rows found. Use: front, back, note (comma or tab separated), one card per line.');
      return this.addCards(deckId, rows);
    },
    /** Append [front, back, note?] rows to a deck. */
    async addCards(deckId, rows) {
      const last = check(await client.from('cards').select('position').eq('deck_id', deckId).order('position', { ascending: false }).limit(1));
      const start = last[0]?.position ?? 0;
      const cards = rows.map(([front, back, note = ''], i) => ({ deck_id: deckId, front, back, note, position: start + i + 1 }));
      for (let i = 0; i < cards.length; i += 500) check(await client.from('cards').insert(cards.slice(i, i + 500)));
      return cards.length;
    },

    // ---- Edge Function (fetching happens server-side) ----
    async fetcher(action, payload = {}) {
      const { data, error } = await client.functions.invoke('sift-fetch', { body: { action, ...payload } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context?.json())?.error || msg; } catch { /* keep message */ }
        throw new Error(msg);
      }
      return data;
    },
  };
}
