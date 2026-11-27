// A PostgREST-compatible subset over D1: the calls Sift's supabase-js client makes (select with filters, order,
// limit and offset; insert; update; delete; the read-only views). Every table, column and operator is whitelisted,
// and values are always bound parameters. Rows come back typed the way Postgres returned them (booleans, JSON).

const COLUMNS = {
  topics: ['id', 'name', 'color', 'weight', 'enabled', 'position', 'kind'],
  sources: ['id', 'topic_id', 'kind', 'name', 'config', 'include', 'exclude', 'weight', 'enabled', 'last_fetched', 'last_error'],
  items: ['id', 'source_id', 'topic_id', 'url', 'title', 'title_key', 'summary', 'image', 'domain', 'comments_url', 'community_score',
    'comment_count', 'published_at', 'fetched_at', 'seen_at', 'reaction', 'saved_at'],
  generators: ['id', 'topic_id', 'kind', 'name', 'config', 'weight', 'enabled'],
  decks: ['id', 'name', 'lang'],
  cards: ['id', 'deck_id', 'front', 'back', 'note', 'position', 'due', 'interval_days', 'ease', 'reps', 'lapses', 'introduced_at'],
  saved_cards: ['id', 'topic_id', 'payload', 'saved_at'],
  muted_domains: ['domain', 'created_at'],
  app_settings: ['key', 'value'],
  item_content: ['item_id', 'status', 'title', 'byline', 'site_name', 'html', 'text_length', 'lead_image', 'error', 'fetched_at'],
};
const WRITABLE = new Set(['topics', 'sources', 'items', 'generators', 'decks', 'cards', 'saved_cards', 'muted_domains', 'app_settings']);
const VIEWS = {
  source_stats: [...COLUMNS.sources, 'item_count', 'unseen_count'],
  deck_stats: ['id', 'name', 'cards', 'studied', 'due_now', 'lang'],
  saved_items: [...COLUMNS.items, 'source_name'],
  domain_stats: ['domain', 'total', 'unread', 'up', 'down', 'last_published', 'muted'],
};
const BOOL = { topics: ['enabled'], sources: ['enabled'], source_stats: ['enabled'], generators: ['enabled'], domain_stats: ['muted'] };
const JSONC = { sources: ['config'], source_stats: ['config'], generators: ['config'], saved_cards: ['payload'], app_settings: ['value'] };
const REQUIRED = { topics: ['name'], sources: ['topic_id', 'kind', 'name'], items: ['source_id', 'topic_id', 'url', 'title', 'published_at'], generators: ['topic_id', 'kind', 'name'],
  decks: ['name'], cards: ['deck_id', 'front', 'back'], saved_cards: ['payload'], muted_domains: ['domain'], app_settings: ['key', 'value'] };
const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (message, code = 'PGRST100') => new HttpError(400, message, code);

const cols = (name) => COLUMNS[name] ?? VIEWS[name];
const ident = (name, allowed) => {
  if (!allowed.includes(name)) throw bad(`column "${name}" does not exist`, '42703');
  return `"${name}"`;
};

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

function parseFilters(params, allowed) {
  const where = [], args = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    const m = /^(not\.)?(eq|neq|in|is|gt|gte|lt|lte)\.(.*)$/.exec(v);
    if (!m) throw bad(`unsupported filter ${k}=${v}`);
    const [, neg, op, arg] = m;
    const col = ident(k, allowed);
    let sql;
    if (op === 'is') {
      sql = arg === 'null' ? `${col} IS NULL` : arg === 'true' ? `${col} = 1` : arg === 'false' ? `${col} = 0` : null;
      if (!sql) throw bad(`unsupported filter ${k}=${v}`);
    } else if (op === 'in') {
      const list = arg.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
      sql = `${col} IN (SELECT value FROM json_each(?))`; // one parameter, however long the list
      args.push(JSON.stringify(list.map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x))));
    } else {
      const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      sql = `${col} ${sym} ?`;
      args.push(/^-?\d+(\.\d+)?$/.test(arg) ? Number(arg) : arg === 'true' ? 1 : arg === 'false' ? 0 : arg);
    }
    where.push(neg ? `NOT COALESCE(${sql}, 0)` : sql);
  }
  return { where: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
}

function parseOrder(order, allowed) {
  if (!order) return '';
  const parts = order.split(',').map((part) => {
    const [col, ...mods] = part.split('.');
    const desc = mods.includes('desc');
    const nullsFirst = mods.includes('nullsfirst') || (desc && !mods.includes('nullslast'));
    return `${ident(col, allowed)} ${desc ? 'DESC' : 'ASC'} NULLS ${nullsFirst ? 'FIRST' : 'LAST'}`;
  });
  return ' ORDER BY ' + parts.join(', ');
}

function selectList(select, allowed) {
  if (!select || select === '*') return '*';
  return select.split(',').map((c) => ident(c.trim(), allowed)).join(', ');
}

/** A row as Postgres would have returned it. */
function typed(name, row) {
  for (const c of BOOL[name] ?? []) if (c in row && row[c] !== null) row[c] = !!row[c];
  for (const c of JSONC[name] ?? []) if (c in row && typeof row[c] === 'string') { try { row[c] = JSON.parse(row[c]); } catch { /* leave */ } }
  return row;
}

/** A value ready to store in the column. */
function stored(name, col, v) {
  if (v === undefined) return null;
  if ((BOOL[name] ?? []).includes(col)) return v === null ? null : v ? 1 : 0;
  if ((JSONC[name] ?? []).includes(col)) return v === null ? null : JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function dbError(e) {
  const msg = String(e?.message ?? e);
  if (/UNIQUE constraint failed/i.test(msg)) return new HttpError(409, `duplicate key value violates unique constraint (${msg})`, '23505');
  if (/FOREIGN KEY constraint failed/i.test(msg)) return new HttpError(409, 'violates foreign key constraint', '23503');
  if (/CHECK constraint failed/i.test(msg)) return new HttpError(400, `violates check constraint (${msg})`, '23514');
  if (/NOT NULL constraint failed/i.test(msg)) return new HttpError(400, `null value violates not-null constraint (${msg})`, '23502');
  return e;
}

const withDefaults = (table, row) => {
  const r = { ...row };
  if (table === 'items') {
    r.fetched_at ??= nowIso();
    r.title_key ??= String(r.title ?? '').toLowerCase();
  }
  if (table === 'saved_cards') r.saved_at ??= nowIso();
  if (table === 'item_content') r.fetched_at ??= nowIso();
  if (table === 'muted_domains') { r.created_at ??= nowIso(); r.domain = String(r.domain ?? '').trim().toLowerCase(); }
  return r;
};

/**
 * Handle one /rest/v1/<name> request. `body` is the parsed JSON body (or undefined).
 * Returns { status, body } where body is JSON-able (or undefined for an empty response).
 */
export async function rest(db, method, name, params, headers, body) {
  const isView = name in VIEWS;
  const allowed = cols(name);
  if (!allowed) throw new HttpError(404, `relation "public.${name}" does not exist`, '42P01');
  const single = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
  const wantRows = (headers.get('prefer') ?? '').includes('return=representation');
  const reply = (rows, status = 200) => {
    rows = rows.map((r) => typed(name, r));
    if (single) return rows.length === 1 ? { status, body: rows[0] } : { status: 406, body: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})`, code: 'PGRST116' } };
    return { status, body: rows };
  };

  if (method === 'GET' || method === 'HEAD') {
    const { where, args } = parseFilters(params, allowed);
    const lim = params.get('limit') ? ` LIMIT ${Math.max(0, parseInt(params.get('limit'), 10) || 0)}` : params.get('offset') ? ' LIMIT -1' : '';
    const off = params.get('offset') ? ` OFFSET ${Math.max(0, parseInt(params.get('offset'), 10) || 0)}` : '';
    const sql = `SELECT ${selectList(params.get('select'), allowed)} FROM ${name}${where}${parseOrder(params.get('order'), allowed)}${lim}${off}`;
    return reply((await db.prepare(sql).bind(...args).all()).results);
  }
  if (isView || !WRITABLE.has(name)) throw bad(`cannot change "${name}"`, '42809');

  try {
    if (method === 'POST') {
      const list = (Array.isArray(body) ? body : [body]).filter((r) => r && typeof r === 'object');
      if (!list.length) return { status: 201, body: undefined };
      const stmts = list.map((raw) => {
        const row = withDefaults(name, raw);
        const keys = Object.keys(row);
        for (const k of keys) ident(k, allowed);
        for (const k of REQUIRED[name]) if (row[k] === undefined || row[k] === null) throw new HttpError(400, `null value in column "${k}" violates not-null constraint`, '23502');
        return db.prepare(`INSERT INTO ${name} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING ${selectList(params.get('select'), allowed)}`)
          .bind(...keys.map((k) => stored(name, k, row[k])));
      });
      const out = [];
      for (let i = 0; i < stmts.length; i += 100) for (const r of await db.batch(stmts.slice(i, i + 100))) out.push(...r.results);
      return wantRows ? reply(out, 201) : { status: 201, body: undefined };
    }
    if (method === 'PATCH') {
      const patch = body && typeof body === 'object' ? body : {};
      const keys = Object.keys(patch);
      if (!keys.length) return { status: 204, body: undefined };
      for (const k of keys) ident(k, allowed);
      const { where, args } = parseFilters(params, allowed);
      const sql = `UPDATE ${name} SET ${keys.map((k) => `"${k}" = ?`).join(', ')}${where} RETURNING ${selectList(params.get('select'), allowed)}`;
      const res = await db.prepare(sql).bind(...keys.map((k) => stored(name, k, patch[k])), ...args).all();
      return wantRows ? reply(res.results) : { status: 204, body: undefined };
    }
    if (method === 'DELETE') {
      const { where, args } = parseFilters(params, allowed);
      await db.prepare(`DELETE FROM ${name}${where}`).bind(...args).run();
      return { status: 204, body: undefined };
    }
  } catch (e) {
    throw e instanceof HttpError ? e : dbError(e);
  }
  throw new HttpError(405, 'method not allowed');
}

/**
 * Changes from the runner on bee, applied in one batch: [{op:'insert',table,row} | {op:'patch',table,id,patch} | {op:'remove',table,id}].
 * Only the tables fetching touches are allowed.
 */
const RUNNER = { sources: 'id', items: 'id', item_content: 'item_id' };

export async function applyOps(db, ops) {
  if (!Array.isArray(ops) || ops.length > 100) throw bad('ops must be a list of at most 100');
  const stmts = ops.map((o) => {
    const key = RUNNER[o?.table];
    if (!key) throw bad(`cannot change "${o?.table}"`);
    const allowed = COLUMNS[o.table];
    if (o.op === 'insert') {
      const row = withDefaults(o.table, o.row ?? {});
      const keys = Object.keys(row);
      for (const k of keys) ident(k, allowed);
      // ON CONFLICT DO NOTHING: the same article may be found twice (same URL), and a re-sent batch must not fail.
      return db.prepare(`INSERT INTO ${o.table} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`)
        .bind(...keys.map((k) => stored(o.table, k, row[k])));
    }
    if (o.op === 'patch') {
      const keys = Object.keys(o.patch ?? {});
      if (!keys.length) return db.prepare('SELECT 1');
      for (const k of keys) ident(k, allowed);
      return db.prepare(`UPDATE ${o.table} SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE "${key}" = ?`)
        .bind(...keys.map((k) => stored(o.table, k, o.patch[k])), o.id);
    }
    if (o.op === 'remove') return db.prepare(`DELETE FROM ${o.table} WHERE "${key}" = ?`).bind(o.id);
    throw bad(`unknown op ${o?.op}`);
  });
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
