// An in-memory stand-in for the parts of Supabase that Sift uses, for the self-contained preview build
// (npm run preview). It answers supabase-js's HTTP calls (PostgREST subset, password sign-in, the sift-fetch
// function) the same way scripts/dev.js does, but from plain arrays in the page instead of a Postgres database,
// so app.js, lib/data.js and supabase-js run unchanged. Everything resets when the page reloads.

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ---- tables ----
const DEFAULTS = {
  topics: () => ({ color: '#6b7280', weight: 1, enabled: true, position: 0, kind: 'articles' }),
  sources: () => ({ config: {}, include: '', exclude: '', weight: 1, enabled: true, last_fetched: null, last_error: null }),
  items: () => ({ summary: '', image: null, domain: null, comments_url: null, community_score: null, comment_count: null,
    fetched_at: new Date().toISOString(), seen_at: null, reaction: 0, saved_at: null }),
  generators: () => ({ config: {}, weight: 1, enabled: true }),
  decks: () => ({ lang: '' }),
  cards: () => ({ note: '', position: 0, due: null, interval_days: 0, ease: 2.5, reps: 0, lapses: 0, introduced_at: null }),
  saved_cards: () => ({ topic_id: null, saved_at: new Date().toISOString() }),
  item_content: () => ({ fetched_at: new Date().toISOString() }),
  muted_domains: () => ({ created_at: new Date().toISOString() }),
  app_settings: () => ({}),
};
const KEY = { muted_domains: 'domain', app_settings: 'key', item_content: 'item_id' }; // tables without an identity id

/**
 * `onChange(op, table, row, patch?)` hears every insert, update and delete (cascades included) made through the
 * PostgREST layer. bee/server.js uses it to save changes to the personal database.
 */
export function createDb({ onChange } = {}) {
  const t = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, []]));
  const seq = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, 0]));
  const err = (message, code) => Object.assign(new Error(message), { code, status: 409 });

  function insert(table, row) {
    if (!t[table]) throw Object.assign(new Error(`relation "${table}" does not exist`), { status: 404 });
    const r = { ...DEFAULTS[table](), ...row };
    if (KEY[table]) {
      if (t[table].some((x) => x[KEY[table]] === r[KEY[table]])) throw err(`duplicate key value violates unique constraint "${table}_pkey"`, '23505');
    } else {
      r.id = ++seq[table];
    }
    if (table === 'items') {
      if (t.items.some((x) => x.url === r.url)) throw err('duplicate key value violates unique constraint "items_url_key"', '23505');
      r.title_key ||= String(r.title).toLowerCase();
    }
    t[table].push(r);
    onChange?.('insert', table, r);
    return r;
  }

  /** Load existing rows (e.g. from the personal database) without reporting them as changes. */
  function load(table, rows) {
    // Fields missing from stored rows (a null removed by a JSON merge patch, a column added later) get defaults.
    t[table].push(...rows.map((r) => ({ ...DEFAULTS[table](), ...r })));
    if (!KEY[table]) seq[table] = Math.max(seq[table], ...t[table].map((r) => Number(r.id) || 0));
  }
  const changed = (op, table, row, patch) => onChange?.(op, table, row, patch);

  // ON DELETE CASCADE / SET NULL, as in the migrations.
  function remove(table, rows) {
    const gone = new Set(rows);
    t[table] = t[table].filter((r) => !gone.has(r));
    for (const r of rows) onChange?.('delete', table, r);
    const ids = new Set(rows.map((r) => r.id));
    const cascade = (child, col) => remove(child, t[child].filter((r) => ids.has(r[col])));
    if (table === 'topics') {
      cascade('sources', 'topic_id'); cascade('items', 'topic_id'); cascade('generators', 'topic_id');
      for (const c of t.saved_cards) if (ids.has(c.topic_id)) c.topic_id = null;
    }
    if (table === 'sources') cascade('items', 'source_id');
    if (table === 'items') cascade('item_content', 'item_id');
    if (table === 'decks') cascade('cards', 'deck_id');
  }

  // ---- views ----
  const views = {
    source_stats: () => t.sources.map((s) => {
      const items = t.items.filter((i) => i.source_id === s.id);
      return { ...s, item_count: items.length, unseen_count: items.filter((i) => !i.seen_at).length };
    }),
    deck_stats: () => t.decks.map((d) => {
      const cards = t.cards.filter((c) => c.deck_id === d.id);
      return { id: d.id, name: d.name, cards: cards.length, studied: cards.filter((c) => c.due).length,
        due_now: cards.filter((c) => c.due && Date.parse(c.due) <= Date.now()).length, lang: d.lang };
    }),
    saved_items: () => t.items.filter((i) => i.saved_at).map((i) => ({ ...i, source_name: t.sources.find((s) => s.id === i.source_id)?.name })),
    domain_stats: () => {
      const domains = new Set([...t.items.map((i) => i.domain).filter(Boolean), ...t.muted_domains.map((m) => m.domain)]);
      return [...domains].map((domain) => {
        const items = t.items.filter((i) => i.domain === domain);
        const last = Math.max(...items.map((i) => Date.parse(i.published_at)));
        return { domain, total: items.length, unread: items.filter((i) => !i.seen_at).length,
          up: items.filter((i) => i.reaction === 1).length, down: items.filter((i) => i.reaction === -1).length,
          last_published: items.length ? iso(last) : null, muted: t.muted_domains.some((m) => m.domain === domain) };
      });
    },
  };

  function feedState({ p_day_start }) {
    const dayStart = Date.parse(p_day_start);
    const muted = new Set(t.muted_domains.map((m) => m.domain));
    const enabledSrc = new Set(t.sources.filter((s) => s.enabled).map((s) => s.id));
    const strip = ({ title_key, fetched_at, ...rest }) => rest;
    const affinity = new Map();
    for (const i of t.items.filter((x) => x.reaction !== 0)) {
      const k = `${i.source_id}|${i.domain}`;
      const a = affinity.get(k) || { source_id: i.source_id, domain: i.domain, up: 0, down: 0 };
      a[i.reaction === 1 ? 'up' : 'down']++;
      affinity.set(k, a);
    }
    const shuffle = (list) => list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return {
      topics: [...t.topics].sort((a, b) => a.position - b.position || a.id - b.id),
      sources: t.sources,
      generators: t.generators.filter((g) => g.enabled),
      items: t.items.filter((i) => !i.seen_at && enabledSrc.has(i.source_id) && !muted.has(i.domain))
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, 1000).map(strip),
      affinity: [...affinity.values()],
      decks: Object.fromEntries(t.decks.map((d) => {
        const cards = t.cards.filter((c) => c.deck_id === d.id);
        const isNotes = t.generators.some((g) => g.enabled && g.kind === 'notes' && String(g.config?.deck_id) === String(d.id));
        return [d.id, {
          name: d.name, lang: d.lang,
          introduced_today: cards.filter((c) => c.introduced_at && Date.parse(c.introduced_at) >= dayStart).length,
          due: cards.filter((c) => c.due && Date.parse(c.due) <= Date.now() + 12 * 3600000).sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).slice(0, 60),
          new: cards.filter((c) => !c.due).sort((a, b) => a.position - b.position).slice(0, 40),
          sample: isNotes ? shuffle(cards).slice(0, 30) : [],
        }];
      })),
    };
  }

  return { tables: t, insert, load, changed, remove, views, feedState };
}

// ---- PostgREST over fetch ----
function parseFilters(params) {
  const tests = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const [, neg, op, arg] = /^(not\.)?(eq|neq|in|is|gt|gte|lt|lte)\.(.*)$/.exec(v) || [];
    if (!op) throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { status: 400 });
    const cmp = (a, b) => {
      if (a == null) return null;
      const na = Number(a); const nb = Number(b);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'string') return na - nb;
      const da = Date.parse(a); const db = Date.parse(b);
      if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    };
    let test;
    if (op === 'is') test = (r) => (arg === 'null' ? r[k] == null : r[k] === (arg === 'true'));
    else if (op === 'in') {
      const set = new Set(arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
      test = (r) => r[k] != null && set.has(String(r[k]));
    } else if (op === 'eq') test = (r) => r[k] != null && String(typeof r[k] === 'object' ? JSON.stringify(r[k]) : r[k]) === arg;
    else if (op === 'neq') test = (r) => r[k] != null && String(r[k]) !== arg;
    else {
      const ok = { gt: (c) => c > 0, gte: (c) => c >= 0, lt: (c) => c < 0, lte: (c) => c <= 0 }[op];
      test = (r) => { const c = cmp(r[k], arg); return c != null && ok(c); };
    }
    tests.push(neg ? (r) => !test(r) : test);
  }
  return (r) => tests.every((f) => f(r));
}
function sortRows(rows, order) {
  if (!order) return rows;
  const keys = order.split(',').map((part) => {
    const [col, ...mods] = part.split('.');
    const desc = mods.includes('desc');
    return { col, desc, nullsFirst: mods.includes('nullsfirst') || (desc && !mods.includes('nullslast')) };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc, nullsFirst } of keys) {
      const x = a[col]; const y = b[col];
      if (x == null && y == null) continue;
      if (x == null) return nullsFirst ? -1 : 1;
      if (y == null) return nullsFirst ? 1 : -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      if (c) return desc ? -c : c;
    }
    return 0;
  });
}
const pick = (select) => (row) => {
  if (!select || select === '*') return { ...row };
  return Object.fromEntries(select.split(',').map((c) => c.trim()).map((c) => [c, row[c] ?? null]));
};
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export const PREVIEW_USER = { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'preview@sift.local' };
export function fakeSession() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const exp = now + 30 * 86400;
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: PREVIEW_USER.id, role: 'authenticated', exp, email: PREVIEW_USER.email })}.preview`,
    token_type: 'bearer', expires_in: exp - now, expires_at: exp, refresh_token: 'preview-refresh', user: PREVIEW_USER,
  };
}

/**
 * A `fetch` for supabase-js (pass it as `global.fetch`). `functions` handles the sift-fetch Edge Function:
 * (body, db) => result. `latency` (ms) keeps loading states visible, as on a phone.
 */
export function createMockFetch(db, { functions, latency = 0 } = {}) {
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  function rest(method, path, params, headers, body) {
    const single = (headers.get('accept') || '').includes('vnd.pgrst.object');
    const wantRows = (headers.get('prefer') || '').includes('return=representation');
    const reply = (rows, status = 200) => {
      rows = clone(rows);
      if (single) return rows.length === 1 ? json(status, rows[0]) : json(406, { message: `JSON object requested, multiple (or no) rows returned (${rows.length})`, code: 'PGRST116' });
      return json(status, rows);
    };
    if (path.startsWith('rpc/')) {
      if (path === 'rpc/feed_state') return json(200, clone(db.feedState(body || {})));
      return json(404, { message: `function ${path.slice(4)} not found` });
    }
    const table = path;
    const where = parseFilters(params);
    const source = db.views[table] ? db.views[table]() : db.tables[table];
    if (!source) return json(404, { message: `relation "public.${table}" does not exist`, code: '42P01' });
    if (method === 'GET' || method === 'HEAD') {
      let rows = sortRows(source.filter(where), params.get('order'));
      if (params.get('offset')) rows = rows.slice(Number(params.get('offset')));
      if (params.get('limit')) rows = rows.slice(0, Number(params.get('limit')));
      return reply(rows.map(pick(params.get('select'))));
    }
    if (db.views[table]) return json(400, { message: `cannot change view "${table}"` });
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const rows = list.map((r) => db.insert(table, clone(r)));
      return wantRows ? reply(rows.map(pick(params.get('select'))), 201) : json(201);
    }
    if (method === 'PATCH') {
      const rows = source.filter(where);
      for (const r of rows) { Object.assign(r, clone(body)); db.changed?.('update', table, r, clone(body)); }
      return wantRows ? reply(rows.map(pick(params.get('select')))) : json(204);
    }
    if (method === 'DELETE') {
      db.remove(table, source.filter(where));
      return json(204);
    }
    return json(405, { message: 'method not allowed' });
  }

  return async function mockFetch(input, init = {}) {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = (init.method || req?.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || req?.headers || {});
    let raw = init.body ?? (req && method !== 'GET' ? await req.text() : undefined);
    let body;
    if (typeof raw === 'string' && raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    if (latency) await new Promise((r) => setTimeout(r, latency * (0.6 + Math.random() * 0.8)));
    try {
      if (url.pathname.startsWith('/rest/v1/')) return rest(method, url.pathname.slice(9), url.searchParams, headers, body);
      if (url.pathname === '/auth/v1/token') return json(200, fakeSession());
      if (url.pathname === '/auth/v1/user') return json(200, PREVIEW_USER);
      if (url.pathname === '/auth/v1/logout') return json(204);
      if (url.pathname === '/functions/v1/sift-fetch') {
        const out = await functions(body || {}, db);
        return out?.httpStatus ? json(out.httpStatus, { error: out.error }) : json(200, clone(out));
      }
      return json(404, { message: `preview backend has no ${url.pathname}` });
    } catch (e) {
      return json(e.status || 400, { message: e.message, code: e.code });
    }
  };
}

export { DAY, iso, KEY };
