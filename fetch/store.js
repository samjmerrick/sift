// The rows fetching needs, held in memory while it works. Changes queue up and are written in batches on flush().
import { applyOps } from '../server/rest.js';

const SNAPSHOT = {
  // A light copy of every item: enough to spot duplicates, missing summaries and old rows.
  items: `SELECT id, source_id, topic_id, url, title, title_key, CASE WHEN summary = '' THEN '' ELSE substr(summary, 1, 1) END AS summary,
    image, fetched_at, seen_at, saved_at FROM items`,
  sources: 'SELECT * FROM sources',
};

export function openStore(db) {
  let data = { sources: [], items: [] };
  let pending = [];
  let maxId = 0;
  return {
    async load() {
      const [items, sources] = await Promise.all([db.prepare(SNAPSHOT.items).all(), db.prepare(SNAPSHOT.sources).all()]);
      data = {
        items: items.results,
        sources: sources.results.map((s) => ({ ...s, config: JSON.parse(s.config), enabled: !!s.enabled })),
      };
      maxId = data.items.reduce((m, i) => Math.max(m, i.id), 0);
      pending = [];
    },
    rows: (table) => data[table] ?? [],
    nextId(table) { return table === 'items' ? maxId + 1 : 1; },
    insert(table, row) {
      if (table === 'items') maxId = Math.max(maxId, row.id);
      data[table]?.push({ ...row });
      pending.push({ op: 'insert', table, row });
    },
    patch(table, id, patch) {
      const local = data[table]?.find((r) => r.id === id);
      if (local) Object.assign(local, patch);
      pending.push({ op: 'patch', table, id, patch });
    },
    remove(table, id) {
      if (data[table]) data[table] = data[table].filter((r) => r.id !== id);
      pending.push({ op: 'remove', table, id });
    },
    async flush() {
      while (pending.length) {
        const ops = pending.splice(0, 100);
        await applyOps(db, ops);
      }
    },
    content: (itemId) => db.prepare('SELECT * FROM item_content WHERE item_id = ?').bind(itemId).first(),
  };
}
