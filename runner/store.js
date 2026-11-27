// The rows fetching needs, held in memory and kept in step with the Sift app on Cloudflare through its runner endpoints.
// Changes queue up locally and go over in batches on flush().
export function openRemote({ url, token }) {
  const base = url.replace(/\/$/, '');
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  let data = { sources: [], items: [] };
  let pending = [];
  let maxId = 0;
  const store = {
    call,
    /** Fetch the current sources and a light copy of every item (enough to spot duplicates and missing summaries). */
    async load() {
      data = await call('/_bee/snapshot');
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
        const ops = pending.slice(0, 40);
        await call('/_bee/apply', { method: 'POST', body: JSON.stringify({ ops }) });
        pending = pending.slice(ops.length);
      }
    },
  };
  return store;
}
