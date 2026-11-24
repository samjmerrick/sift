// The artifact's link to the personal database (bee-database), through the viewer's "Personal database"
// connector (the artifact `mcp` capability: calls run with the viewer's own sign-in, no tokens in the page).
//
// Reads: everything except reader text is loaded once at startup with query_sql, and kept in the in-memory
// backend (preview/mock-backend.js), which answers the app's supabase-js calls. Reader text is looked up when an
// article is opened.
// Writes: every insert, update and delete the backend makes is queued here and saved as one record call each
// (store / update / delete), in order per row, a few at a time.
import { PROJECT, TABLES, KEYS, rowKey, toRecord } from '../bee/records.js';

export const SERVER = 'Personal database';
const PAGE = 500; // query_sql's row limit
const PARALLEL = 4;

export function createSync({ onStatus = () => {} } = {}) {
  let mcp = null;
  const ids = new Map(); // `${table}:${key}` -> record id
  const chains = new Map(); // `${table}:${key}` -> promise of that row's last queued write
  const latest = new Map(); // `${table}:${key}` -> newest row snapshot for a queued update not yet sent
  const lastN = {}; // table -> highest record number seen
  let pending = 0;
  let failed = []; // { label, run }
  let lastError = null;

  const status = () => onStatus({ pending, failed: failed.length, error: lastError });
  const call = async (tool, input) => {
    const r = await mcp.callTool(SERVER, tool, input, { cache: false });
    return r?.payload ?? r?.structuredContent ?? r;
  };

  // A small semaphore so a big delete (a topic with hundreds of articles) doesn't fire hundreds of calls at once.
  let active = 0;
  const waiting = [];
  const slot = () => (active < PARALLEL ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function connect() {
    try { mcp = await window.claude?.use?.('mcp'); } catch { mcp = null; }
    if (!mcp) throw Object.assign(new Error('This view cannot use connectors.'), { code: 'no_mcp' });
  }

  async function query(sql, params) {
    const p = await call('query_sql', { sql, params });
    const cols = p.columns || [];
    return (p.rows || []).map((r) => (Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r));
  }
  const parse = (m) => (typeof m === 'string' ? JSON.parse(m || '{}') : m || {});

  /** All rows of one table, oldest first. */
  async function loadTable(table, onPage) {
    const rows = [];
    let after = 0;
    for (;;) {
      const page = await query(
        'SELECT n, id, metadata FROM records WHERE project = ? AND collection = ? AND n > ? ORDER BY n LIMIT ' + PAGE,
        [PROJECT, table, after]);
      for (const r of page) {
        const row = parse(r.metadata);
        ids.set(`${table}:${rowKey(table, row)}`, r.id);
        rows.push(row);
      }
      onPage?.(rows.length);
      if (page.length) lastN[table] = page[page.length - 1].n;
      if (page.length < PAGE) return rows;
      after = page[page.length - 1].n;
    }
  }

  /** Every table the app reads up front (reader text is fetched per article). */
  async function loadAll(onProgress) {
    const out = {};
    for (const table of TABLES) {
      if (table === 'item_content') continue;
      out[table] = await loadTable(table, (n) => onProgress?.(table, n));
    }
    return out;
  }

  /** Reader text for one article, or null when bee hasn't fetched it. */
  async function readerText(itemId) {
    const [r] = await query(
      "SELECT id, metadata FROM records WHERE project = ? AND collection = 'item_content' AND json_extract(metadata, '$.item_id') = ? ORDER BY n DESC LIMIT 1",
      [PROJECT, Number(itemId)]);
    if (!r) return null;
    const row = parse(r.metadata);
    ids.set(`item_content:${rowKey('item_content', row)}`, r.id);
    return row;
  }

  // ---- writes ----
  function enqueue(key, label, run) {
    pending++; status();
    const go = async () => {
      await slot();
      try { await run(); lastError = null; } catch (e) {
        lastError = e?.code || e?.message || String(e);
        failed.push({ label, run });
        console.warn('Sift: could not save', label, e);
      } finally { release(); pending--; status(); }
    };
    const next = (chains.get(key) || Promise.resolve()).then(go);
    chains.set(key, next);
    next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  }

  const storeRow = async (table, key, row) => {
    const p = await call('store', toRecord(table, row));
    const id = p?.id || p?.record?.id;
    if (!id) throw new Error('The database did not return a record id');
    ids.set(key, id);
  };

  function onChange(op, table, row, patch) {
    if (!TABLES.includes(table)) return;
    const key = `${table}:${rowKey(table, row)}`;
    const snap = JSON.parse(JSON.stringify(row));
    if (op === 'insert') {
      enqueue(key, `add ${table}`, () => storeRow(table, key, snap));
    } else if (op === 'update') {
      // Only the changed fields are sent (merged into the record), so a change made on bee meanwhile, such as a
      // new summary, isn't overwritten. Quick successive updates to one row go out as one call.
      const q = latest.get(key);
      latest.set(key, { row: snap, patch: { ...(q?.patch || {}), ...(patch || snap) } });
      if (q) return;
      enqueue(key, `change ${table}`, async () => {
        const u = latest.get(key);
        latest.delete(key);
        if (!u) return; // deleted before this update went out
        const id = ids.get(key);
        if (!id) return storeRow(table, key, u.row);
        const { title, content } = toRecord(table, u.row);
        await call('update', { id, title, content, metadata: u.patch });
      });
    } else if (op === 'delete') {
      latest.delete(key);
      enqueue(key, `delete ${table}`, async () => {
        const id = ids.get(key);
        if (!id) return;
        await call('delete', { id });
        ids.delete(key);
      });
    }
  }

  /** Rows added on bee since the last load (new articles from the hourly fetch). */
  async function loadNew(table) {
    const rows = [];
    for (;;) {
      const page = await query(
        'SELECT n, id, metadata FROM records WHERE project = ? AND collection = ? AND n > ? ORDER BY n LIMIT ' + PAGE,
        [PROJECT, table, lastN[table] || 0]);
      for (const r of page) {
        const row = parse(r.metadata);
        const key = `${table}:${rowKey(table, row)}`;
        if (!ids.has(key)) rows.push(row);
        ids.set(key, r.id);
      }
      if (page.length) lastN[table] = page[page.length - 1].n;
      if (page.length < PAGE) return rows;
    }
  }

  /** Re-send failed saves (only from a tap: a failed save may in fact have gone through). */
  function retry() {
    const list = failed;
    failed = [];
    lastError = null;
    for (const f of list) enqueue(`retry:${Math.random()}`, f.label, f.run);
    status();
  }

  return { connect, loadAll, loadNew, readerText, onChange, retry, get pending() { return pending; }, KEYS };
}
