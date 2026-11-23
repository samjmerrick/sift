// Preview setup: an in-memory Supabase (mock-backend.js) filled with the real starter packs plus the sample
// articles in sample-data.js. app.js then runs unchanged against it, already signed in.
import { createDb, createMockFetch, fakeSession, DAY, iso } from './mock-backend.js';
import { ARTICLES, FRESH, SAVED_CARDS, STUDY, READ_FAILURE, PACKS } from './sample-data.js';
import { createData } from '../public/lib/data.js';
import { installPack } from '../public/lib/packs.js';
import STARTERS from './starters.gen.js'; // { 'ai.json': {...}, ... } written by scripts/build-preview.js

const URL_BASE = 'https://preview.sift.local';
const HOUR = 3600000;
const db = createDb();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
let videoN = 0;

function addArticle(src, a, now = Date.now()) {
  const youtube = /youtube\.com/.test(src.config?.url || '');
  const domain = youtube ? 'youtube.com' : a.domain || hostOf(src.config?.url) || 'example.com';
  const url = youtube ? `https://www.youtube.com/watch?v=preview${String(++videoN).padStart(4, '0')}` : `https://${domain}/${slug(a.title)}`;
  const item = db.insert('items', {
    source_id: src.id, topic_id: src.topic_id, url, title: a.title, summary: a.summary || '', domain,
    comments_url: src.kind === 'hn' ? `https://news.ycombinator.com/item?id=${4000000 + db.tables.items.length}` : null,
    community_score: a.score ?? null, comment_count: a.comments ?? null,
    published_at: iso(now - (a.ageH ?? 1) * HOUR),
  });
  const read = a.state && a.state !== 'unread';
  if (read) item.seen_at = iso(now - (a.ageH ?? 1) * HOUR * 0.5);
  if (a.state === 'up' || a.state === 'saved') item.reaction = 1;
  if (a.state === 'down') item.reaction = -1;
  if (a.state === 'saved') item.saved_at = iso(now - (a.ageH ?? 1) * HOUR * 0.4);
  if (!youtube) {
    db.insert('item_content', a.body
      ? { item_id: item.id, status: 'ok', title: a.title, byline: src.name, site_name: domain, html: a.body, text_length: a.body.replace(/<[^>]+>/g, '').length, lead_image: null, error: null }
      : { item_id: item.id, status: 'failed', html: '', text_length: 0, error: READ_FAILURE });
  }
  return item;
}

const fresh = Object.fromEntries(Object.entries(FRESH).map(([k, v]) => [k, [...v]]));
function fetchSource(src) {
  src.last_fetched = new Date().toISOString();
  const topic = db.tables.topics.find((t) => t.id === src.topic_id);
  const queue = fresh[topic?.name] || [];
  const i = queue.findIndex((a) => a.source === src.name);
  if (i < 0) return { added: 0 };
  const [a] = queue.splice(i, 1);
  addArticle(src, { ...a, ageH: 0.1 });
  return { added: 1 };
}

// The sift-fetch Edge Function.
function functions(body) {
  const { action } = body;
  if (action === 'read') {
    const item = db.tables.items.find((i) => i.id === Number(body.id));
    if (!item) return { httpStatus: 404, error: 'Item not found' };
    const row = db.tables.item_content.find((c) => c.item_id === item.id)
      || { status: 'failed', html: '', error: READ_FAILURE };
    const { status, title, byline, site_name, html, text_length, lead_image, error } = row;
    return { status, title: title ?? item.title, byline, site_name, html, text_length, lead_image, error, url: item.url };
  }
  if (action === 'fetch_source') {
    const src = db.tables.sources.find((s) => s.id === Number(body.id));
    return src ? fetchSource(src) : { httpStatus: 404, error: 'Source not found' };
  }
  if (action === 'fetch_all') {
    return Object.fromEntries(db.tables.sources.filter((s) => s.enabled).map((s) => [s.id, fetchSource(s)]));
  }
  if (action === 'preview') {
    const name = body.source?.name || 'this source';
    return Array.from({ length: 6 }, (_, i) => ({
      title: `Sample post ${i + 1} from ${name}`, url: `https://example.com/preview-${i + 1}`,
      published: Date.now() - (i * 7 + 2) * HOUR, community_score: body.source?.kind === 'hn' ? 300 - i * 40 : null,
    }));
  }
  return { httpStatus: 400, error: 'Unknown action' };
}

// supabase-js for seeding and for the app, both talking to the in-memory database.
const mockFetch = createMockFetch(db, { functions });
const appFetch = createMockFetch(db, { functions, latency: 180 });
const memoryStorage = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
const AUTH_KEY = 'sift-preview-auth';
const authStorage = memoryStorage({ [AUTH_KEY]: JSON.stringify(fakeSession()) });
const realCreate = window.supabase.createClient;
window.supabase.createClient = (url, key, options = {}) => realCreate(url, key, {
  ...options,
  global: { ...(options.global || {}), fetch: appFetch },
  auth: { ...(options.auth || {}), storage: authStorage, storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});
window.SIFT_CONFIG = { supabaseUrl: URL_BASE, supabaseKey: 'preview' };

// Starter pack JSON (Settings → Topics → Add a starter pack) comes from the bundle, not the network.
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  const m = /(?:^|\/)starters\/([\w.-]+\.json)(?:\?|$)/.exec(u);
  if (m) {
    const body = m[1] === 'index.json' ? Object.keys(STARTERS) : STARTERS[m[1]];
    return body ? new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }) : new Response('not found', { status: 404 });
  }
  return realFetch(input, init);
};

// The frame an artifact runs in has no confirm()/prompt() dialogs (they return false/null at once), which would
// make every "Delete …?" a no-op. In the preview, deletes go ahead; the sample data comes back on reload.
window.confirm = () => true;

// ---- seed ----
const seedClient = realCreate(URL_BASE, 'preview', { global: { fetch: mockFetch }, auth: { storage: memoryStorage(), persistSession: false, autoRefreshToken: false } });
const seedData = createData(seedClient);
const now = Date.now();
for (const f of PACKS) await installPack(seedData, STARTERS[f]);
for (const src of db.tables.sources) {
  src.last_fetched = iso(now - 25 * 60000);
  // A source in two packs (e.g. Simon Willison in AI and Programming) gets its articles once, in the first topic.
  for (const a of ARTICLES[src.name] || []) if (!db.tables.items.some((i) => i.title === a.title)) addArticle(src, a, now);
}
// A failing source, so the error state shows in Settings.
const broken = db.tables.sources.find((s) => s.name === 'Latent Space');
if (broken) broken.last_error = 'Feed returned HTTP 403';
// Flashcard history: some cards studied, some of those due now.
for (const [name, { studied, dueNow }] of Object.entries(STUDY)) {
  const deck = db.tables.decks.find((d) => d.name === name);
  const cards = db.tables.cards.filter((c) => c.deck_id === deck?.id).sort((a, b) => a.position - b.position).slice(0, studied);
  cards.forEach((c, i) => {
    const due = i < dueNow ? now - (i + 1) * HOUR : now + (i - dueNow + 1) * DAY;
    Object.assign(c, { reps: 1 + (i % 4), interval_days: 1 + (i % 6), ease: 2.5, due: iso(due), introduced_at: iso(now - (10 + i) * DAY) });
  });
}
for (const { topic, payload } of SAVED_CARDS) {
  const t = db.tables.topics.find((x) => x.name === topic);
  const gen = db.tables.generators.find((g) => g.topic_id === t?.id && g.name === payload.generator);
  db.insert('saved_cards', { topic_id: t?.id ?? null, payload: { label: 'Tip', generator_id: gen?.id, topic_id: t?.id, ...payload }, saved_at: iso(now - 2 * DAY) });
}
window.SIFT_PREVIEW = { db }; // poke at the data from the console: SIFT_PREVIEW.db.tables
