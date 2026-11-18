import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, parseCsv, importCards } from './db.js';
import { buildFeed } from './feed.js';
import { fetchAll, fetchSource, previewSource, SOURCE_KINDS } from './fetcher.js';
import { GENERATOR_KINDS, reviewCard } from './generators.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.SIFT_PASSWORD || '';
const FETCH_MINUTES = Number(process.env.FETCH_INTERVAL_MINUTES) || 60;
const db = openDb();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// ---------- auth (single user, optional) ----------
const token = PASSWORD ? createHmac('sha256', PASSWORD).update('sift-session').digest('hex') : '';
function authed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)sift=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!m && timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
}

// ---------- tiny router ----------
const routes = [];
const route = (method, path, fn) => routes.push({ method, re: new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const json = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const cfgOut = (r) => ({ ...r, config: json(r.config) });
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v) => (v === undefined || v === null ? 1 : v ? 1 : 0); // new rows default to enabled

function crud(table, cols, { list, after } = {}) {
  route('GET', `/api/${table}`, () => (list ? list() : db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).map(cfgOut));
  route('POST', `/api/${table}`, ({ body }) => {
    const vals = cols.map(([c, conv]) => conv(body[c]));
    const r = db.prepare(`INSERT INTO ${table} (${cols.map((c) => c[0]).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid);
    after?.(row);
    return cfgOut(row);
  });
  route('PUT', `/api/${table}/:id`, ({ body, params }) => {
    const present = cols.filter(([c]) => c in body);
    if (present.length) {
      db.prepare(`UPDATE ${table} SET ${present.map(([c]) => `${c} = ?`).join(',')} WHERE id = ?`)
        .run(...present.map(([c, conv]) => conv(body[c])), num(params.id));
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(num(params.id));
    if (!row) throw new HttpError(404, 'Not found');
    return cfgOut(row);
  });
  route('DELETE', `/api/${table}/:id`, ({ params }) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(num(params.id));
    return { ok: true };
  });
}

const str = (v) => String(v ?? '').trim();
const cfgIn = (v) => JSON.stringify(typeof v === 'string' ? json(v) : v || {});

route('POST', '/api/login', ({ req, body, res }) => {
  if (!PASSWORD) return { ok: true };
  if (str(body.password) !== PASSWORD) throw new HttpError(401, 'Wrong password');
  const https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sift=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${https ? '; Secure' : ''}`);
  return { ok: true };
});

route('GET', '/api/meta', () => ({
  source_kinds: SOURCE_KINDS,
  generator_kinds: Object.fromEntries(Object.entries(GENERATOR_KINDS).map(([k, v]) => [k, { label: v.label, description: v.description, fields: v.fields }])),
  topics: db.prepare('SELECT * FROM topics ORDER BY position, id').all(),
  decks: db.prepare('SELECT d.*, COUNT(c.id) cards FROM decks d LEFT JOIN cards c ON c.deck_id = d.id GROUP BY d.id ORDER BY d.id').all(),
}));

route('POST', '/api/feed', ({ body }) => buildFeed(db, {
  n: body.n, topicId: body.topic_id, excludeItems: body.exclude_items, recentKeys: body.recent_keys, recentTopics: body.recent_topics,
}));

route('POST', '/api/seen', ({ body }) => {
  const st = db.prepare('UPDATE items SET seen_at = COALESCE(seen_at, ?) WHERE id = ?');
  for (const id of body.ids || []) st.run(Date.now(), num(id));
  return { ok: true };
});
route('POST', '/api/items/:id/react', ({ body, params }) => {
  db.prepare('UPDATE items SET reaction = ? WHERE id = ?').run(Math.sign(num(body.reaction)), num(params.id));
  return { ok: true };
});
route('POST', '/api/items/:id/save', ({ body, params }) => {
  db.prepare('UPDATE items SET saved_at = ? WHERE id = ?').run(body.saved ? Date.now() : null, num(params.id));
  return { ok: true };
});
// 👍/👎 on a generated card nudges that generator's share of the feed.
route('POST', '/api/generators/:id/react', ({ body, params }) => {
  const factor = num(body.reaction) > 0 ? 1.1 : num(body.reaction) < 0 ? 0.85 : 1;
  db.prepare('UPDATE generators SET weight = MIN(10, MAX(0.1, weight * ?)) WHERE id = ?').run(factor, num(params.id));
  return db.prepare('SELECT weight FROM generators WHERE id = ?').get(num(params.id));
});
route('POST', '/api/cards/:id/review', ({ body, params }) => {
  if (!['again', 'good', 'easy'].includes(body.grade)) throw new HttpError(400, 'grade must be again|good|easy');
  return reviewCard(db, num(params.id), body.grade);
});

route('GET', '/api/saved', () => ({
  items: db.prepare(`SELECT i.*, s.name source_name FROM items i JOIN sources s ON s.id = i.source_id
    WHERE saved_at IS NOT NULL ORDER BY saved_at DESC`).all(),
  cards: db.prepare('SELECT * FROM saved_cards ORDER BY saved_at DESC').all().map((c) => ({ ...c, payload: json(c.payload) })),
}));
route('POST', '/api/saved-cards', ({ body }) => {
  const r = db.prepare('INSERT INTO saved_cards (topic_id, payload, saved_at) VALUES (?, ?, ?)').run(num(body.topic_id) || null, JSON.stringify(body.payload || {}), Date.now());
  return { id: Number(r.lastInsertRowid) };
});
route('DELETE', '/api/saved-cards/:id', ({ params }) => {
  db.prepare('DELETE FROM saved_cards WHERE id = ?').run(num(params.id));
  return { ok: true };
});

const nextTopicPosition = (v) => (v == null ? db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM topics').get().p : num(v));
crud('topics', [['name', str], ['color', str], ['weight', (v) => num(v, 1)], ['curated_ratio', (v) => Math.min(1, Math.max(0, num(v, 0.6)))], ['enabled', bool], ['position', nextTopicPosition]],
  { list: () => db.prepare('SELECT * FROM topics ORDER BY position, id').all() });
crud('sources', [['topic_id', num], ['kind', str], ['name', str], ['config', cfgIn], ['include', str], ['exclude', str], ['weight', (v) => num(v, 1)], ['enabled', bool]],
  { list: () => db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id) item_count,
      (SELECT COUNT(*) FROM items i WHERE i.source_id = s.id AND i.seen_at IS NULL) unseen_count FROM sources s ORDER BY topic_id, id`).all(),
    after: (row) => { fetchSource(db, row).catch(() => {}); } });
crud('generators', [['topic_id', num], ['kind', str], ['name', str], ['config', cfgIn], ['weight', (v) => num(v, 1)], ['enabled', bool]],
  { list: () => db.prepare('SELECT * FROM generators ORDER BY topic_id, id').all() });
crud('decks', [['name', str]], {
  list: () => db.prepare(`SELECT d.*, COUNT(c.id) cards, SUM(c.due IS NOT NULL) studied, SUM(c.due <= ${Date.now()}) due_now
    FROM decks d LEFT JOIN cards c ON c.deck_id = d.id GROUP BY d.id ORDER BY d.id`).all(),
});
route('POST', '/api/decks/:id/import', ({ body, params }) => {
  const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(num(params.id));
  if (!deck) throw new HttpError(404, 'Deck not found');
  const rows = parseCsv(String(body.csv || ''));
  if (!rows.length) throw new HttpError(400, 'No rows found. Use: front, back, note (comma or tab separated), one card per line.');
  return { imported: importCards(db, deck.id, rows) };
});
route('GET', '/api/decks/:id/cards', ({ params }) =>
  db.prepare('SELECT id, front, back, note, due, reps, interval_days FROM cards WHERE deck_id = ? ORDER BY position').all(num(params.id)));
route('DELETE', '/api/cards/:id', ({ params }) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(num(params.id));
  return { ok: true };
});

route('POST', '/api/sources/preview', async ({ body }) => (await previewSource(body)).slice(0, 15));
route('POST', '/api/sources/:id/fetch', async ({ params }) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(num(params.id));
  if (!src) throw new HttpError(404, 'Not found');
  return fetchSource(db, src);
});
route('POST', '/api/fetch', async () => fetchAll(db));
route('GET', '/api/generators/:id/sample', ({ params }) => {
  const g = db.prepare('SELECT * FROM generators WHERE id = ?').get(num(params.id));
  if (!g) throw new HttpError(404, 'Not found');
  const card = GENERATOR_KINDS[g.kind]?.generate(json(g.config), { db, excludeKeys: new Set(), generatorId: g.id });
  return card ? { ...card, topic_id: g.topic_id, generator_id: g.id, generator: g.name } : null;
});

// ---------- server ----------
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  return chunks.length ? json(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    // SPA fallback
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(await readFile(join(PUBLIC, 'index.html')));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  try {
    if (url.pathname !== '/api/login' && !authed(req)) throw new HttpError(401, 'Login required');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.fn({ req, res, body, params: m.groups || {}, query: url.searchParams });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out ?? null));
      return;
    }
    throw new HttpError(404, 'No such endpoint');
  } catch (err) {
    if (!err.status) console.error(err);
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Sift listening on http://localhost:${PORT}${PASSWORD ? '' : '  (no SIFT_PASSWORD set: anyone who can reach this port can use it)'}`);
});

const tick = () => fetchAll(db).then((r) => {
  const summary = Object.entries(r).map(([k, v]) => `${k}: ${v.error ? `ERR ${v.error}` : `+${v.added}`}`).join(' | ');
  console.log(`[fetch ${new Date().toISOString()}] ${summary}`);
}).catch((e) => console.error('fetch failed', e));
if (!process.env.SIFT_NO_FETCH) {
  setTimeout(tick, 3000);
  setInterval(tick, FETCH_MINUTES * 60000);
}
