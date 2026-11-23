// Offline copies of what you saved, kept on this device so the Saved tab and the reader work without a network.
// Stored: the readable text of each saved article (plus its card data), the last Saved list, and the topic list
// (for names and colours). Everything else still comes from Supabase.

const ARTICLE = 'article:';

/**
 * @param backend  {get(key), set(key, value), del(key), keys()} — all async. `idbBackend()` in the browser.
 */
export function createOffline(backend) {
  // Storage failing (private mode, quota) must never break the app: reads come back empty, writes are dropped.
  const safe = (fn, fallback) => async (...args) => { try { return await fn(...args); } catch { return fallback; } };
  return {
    /** The stored copy of a saved article: { card, read } (read = the reader's `read` result), or null. */
    article: safe(async (id) => (await backend.get(ARTICLE + id)) ?? null, null),
    saveArticle: safe(async (id, card, read) => { await backend.set(ARTICLE + id, { card, read, at: Date.now() }); }),
    removeArticle: safe(async (id) => { await backend.del(ARTICLE + id); }),
    /** Ids of the articles that have a stored copy. */
    articleIds: safe(async () => (await backend.keys()).filter((k) => String(k).startsWith(ARTICLE)).map((k) => Number(String(k).slice(ARTICLE.length))), []),

    /** The last Saved list loaded from the server ({ items, cards, at }), or null. */
    savedList: safe(async () => (await backend.get('saved')) ?? null, null),
    /** Store the Saved list and drop article copies that are no longer saved. */
    setSavedList: safe(async ({ items, cards }) => {
      await backend.set('saved', { items, cards, at: Date.now() });
      const keep = new Set(items.map((i) => i.id));
      for (const k of await backend.keys()) {
        if (String(k).startsWith(ARTICLE) && !keep.has(Number(String(k).slice(ARTICLE.length)))) await backend.del(k);
      }
    }),

    meta: safe(async () => (await backend.get('meta')) ?? null, null),
    setMeta: safe(async (m) => { await backend.set('meta', m); }),

    clear: safe(async () => { for (const k of await backend.keys()) await backend.del(k); }),
  };
}

/** Saved articles that have no stored copy yet (saved before this existed, or on another device). */
export function missingArticles(items, storedIds) {
  const have = new Set(storedIds);
  return items.filter((i) => !have.has(i.id));
}

export function memoryBackend() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

/** A one-store IndexedDB key/value backend (article text is too big for localStorage). */
export function idbBackend(name = 'sift-offline') {
  let dbp = null;
  const db = () => (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
  const run = async (mode, fn) => {
    const tx = (await db()).transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    del: (k) => run('readwrite', (s) => s.delete(k)),
    keys: () => run('readonly', (s) => s.getAllKeys()),
  };
}
