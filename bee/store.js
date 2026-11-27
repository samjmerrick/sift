// Sift's rows in bee-database, read and written through its MCP endpoint (bee/dbclient.js).
//
// Every table except item_content is mirrored in memory, so reads are immediate. Writes change the mirror at once
// and are sent to the database in order; `await flush()` waits for them and reports any that failed. Reader text
// (item_content) is large, so it is only fetched when asked for. Writes made by anything else (Claude through the
// connector, bee/fetch.js) are picked up by `refresh()`.
import { createDbClient } from './dbclient.js';
import { PROJECT, TABLES, rowKey, toRecord, PROJECT_INFO } from './records.js';

const MIRRORED = TABLES.filter((t) => t !== 'item_content');
const PAGE = 200; // the most list_records returns

export async function openBee(db = createDbClient()) {
  const mirror = new Map(MIRRORED.map((t) => [t, new Map()])); // table -> key -> { ids: [record id], row }
  let signature = {}; // collection -> "count last_updated"
  let queue = Promise.resolve();
  let pending = 0;
  let writes = 0;
  let failure = null;
  const touched = new Set();

  /** Define the project and its collections (idempotent; members and records are left alone). */
  async function ensureProject() {
    const projects = await db.call('list_projects');
    const list = Array.isArray(projects) ? projects : projects.projects || [];
    const exists = list.some((p) => (p.project || p.slug) === PROJECT);
    await db.call('project_set', { project: PROJECT, ...PROJECT_INFO.project, ...(exists ? { name: undefined } : {}) });
    for (const t of TABLES) await db.call('collection_set', { project: PROJECT, collection: t, description: PROJECT_INFO.collections[t] });
  }

  async function records(collection, filter) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await db.call('list_records', { project: PROJECT, collection, include_metadata: true, limit: PAGE, offset, ...filter });
      out.push(...page.results);
      if (offset + PAGE >= page.total || !page.results.length) return out;
    }
  }

  async function readSignature() {
    const overview = await db.call('list_collections', { project: PROJECT });
    return Object.fromEntries(Object.entries(overview.projects?.[PROJECT] || {}).map(([c, v]) => [c, `${v.count} ${v.last_updated}`]));
  }

  async function readTable(table) {
    const rows = new Map();
    // Oldest first, so that of two records with one key the newest wins.
    for (const r of (await records(table)).reverse()) {
      const key = rowKey(table, r.metadata);
      rows.set(key, { ids: [...(rows.get(key)?.ids || []), r.id], row: r.metadata });
    }
    return rows;
  }

  /**
   * Re-read the collections that changed (all of them when `all`). Returns true if the mirror changed.
   * Does nothing while writes are on their way, or if one starts while reading: the next call tries again.
   */
  async function refresh({ all = false } = {}) {
    if (pending) return false;
    const before = writes;
    const next = await readSignature();
    const changed = MIRRORED.filter((t) => all || next[t] !== signature[t]);
    const read = [];
    for (const t of changed) read.push([t, await readTable(t)]);
    if (writes !== before) return false;
    for (const [t, rows] of read) mirror.set(t, rows);
    signature = next;
    return read.length > 0;
  }

  function enqueue(table, job) {
    pending++;
    writes++;
    touched.add(table);
    queue = queue.then(job).catch((e) => { failure ||= e; console.error(`write to ${table} failed: ${e.message}`); }).finally(() => { pending--; });
  }

  /** Wait for the writes so far. Throws if one failed (after re-reading what the database really holds). */
  async function flush() {
    let q;
    do { q = queue; await q; } while (q !== queue);
    // Take the new signature of what we wrote, so our own writes don't count as someone else's.
    if (touched.size && !pending) {
      const mine = [...touched];
      touched.clear();
      const now = await readSignature();
      for (const t of mine) { if (now[t] === undefined) delete signature[t]; else signature[t] = now[t]; }
    }
    if (failure) {
      const e = failure;
      failure = null;
      await refresh({ all: true });
      throw e;
    }
  }

  const store = (table, entry, row) => enqueue(table, async () => {
    const { title, content, tags } = toRecord(table, row);
    const rec = await db.call('store', { project: PROJECT, collection: table, title, content, tags, metadata: row });
    entry?.ids.push(rec.id);
  });
  const contentRecords = (itemId) => db.call('list_records', { project: PROJECT, collection: 'item_content', include_metadata: true,
    metadata_equals: { item_id: Number(itemId) }, limit: PAGE }).then((p) => p.results);

  await ensureProject();
  await refresh({ all: true });

  return {
    refresh,
    flush,
    /** All rows of a mirrored table, in id order. */
    rows: (table) => [...mirror.get(table).values()].map((e) => ({ ...e.row }))
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)),
    /** One row by its key, or null. */
    get(table, key) { const e = mirror.get(table).get(String(key)); return e ? { ...e.row } : null; },
    /** The stored reader text for an item, or null. */
    async content(itemId) {
      await flush();
      return (await contentRecords(itemId))[0]?.metadata || null;
    },
    /** Add a row (ignored if one with the same key is already there). Returns true if it was added. */
    insert(table, row) {
      const copy = JSON.parse(JSON.stringify(row));
      if (table === 'item_content') { store(table, null, copy); return true; }
      const key = rowKey(table, copy);
      if (mirror.get(table).has(key)) return false;
      const entry = { ids: [], row: copy };
      mirror.get(table).set(key, entry);
      store(table, entry, copy);
      return true;
    },
    /** Merge fields into a row (a null value removes the field). */
    patch(table, key, fields, { title = null, content = null } = {}) {
      const entry = mirror.get(table).get(String(key));
      if (!entry) return 0;
      const metadata = JSON.parse(JSON.stringify(fields));
      const row = { ...entry.row, ...metadata };
      for (const k of Object.keys(row)) if (row[k] === null) delete row[k];
      entry.row = row;
      enqueue(table, async () => {
        for (const id of entry.ids) {
          await db.call('update', { id, metadata, ...(title ? { title } : {}), ...(content ? { content } : {}) });
        }
      });
      return 1;
    },
    remove(table, key) {
      if (table === 'item_content') {
        enqueue(table, async () => { for (const r of await contentRecords(key)) await db.call('delete', { id: r.id }); });
        return 1;
      }
      const entry = mirror.get(table).get(String(key));
      if (!entry) return 0;
      mirror.get(table).delete(String(key));
      enqueue(table, async () => { for (const id of entry.ids) await db.call('delete', { id }); });
      return 1;
    },
    nextId: (table) => Math.max(0, ...[...mirror.get(table).values()].map((e) => Number(e.row.id) || 0)) + 1,
    counts: () => Object.fromEntries(Object.entries(signature).map(([c, s]) => [c, Number(s.split(' ')[0])])),
    async close() { try { await flush(); } finally { await db.close(); } },
  };
}

export { MIRRORED };
