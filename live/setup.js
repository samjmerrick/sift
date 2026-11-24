// Live setup: the real app (public/) running in a claude.ai artifact on Sam's data in the personal database.
// The data is loaded into the in-memory backend from the preview build (preview/mock-backend.js), which answers
// supabase-js; every change the backend makes is saved back through live/sync.js. Fetching articles and reader text
// happens on bee (bee/fetch.js), since an artifact cannot load other websites.
import { createDb, createMockFetch, fakeSession } from '../preview/mock-backend.js';
import { createSync } from './sync.js';
import STARTERS from './starters.gen.js'; // { 'ai.json': {...}, ... } written by scripts/build-preview.js

const URL_BASE = 'https://live.sift.local';
const NOT_HERE = 'Fetching runs on bee every hour, so new articles show up after the next run.';

// ---- status pill (loading, saving, errors) ----
const pill = document.createElement('div');
pill.id = 'live-status';
pill.setAttribute('role', 'status');
document.body.append(pill);
function show(text, { error = false, action = null } = {}) {
  pill.hidden = !text;
  pill.className = error ? 'error' : '';
  pill.replaceChildren(document.createTextNode(text || ''));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label; b.onclick = action.run;
    pill.append(' ', b);
  }
}

const sync = createSync({
  onStatus: ({ pending, failed, error }) => {
    if (failed) show(`Couldn't save ${failed} change${failed === 1 ? '' : 's'} (${error}).`, { error: true, action: { label: 'Retry', run: () => sync.retry() } });
    else if (pending) show(`Saving ${pending}…`);
    else show('');
  },
});
addEventListener('beforeunload', (e) => { if (sync.pending) e.preventDefault(); });

const LOAD_HELP = {
  no_mcp: 'Open this page on claude.ai or in the Claude app to use your personal database.',
  server_not_connected: 'Add the "Personal database" connector in claude.ai settings, then reload.',
  needs_reauth: 'Your "Personal database" connector needs signing in again (claude.ai → Settings → Connectors), then reload.',
  approval_required: 'Allow this page to use your "Personal database" connector, then reload.',
  blocked_by_policy: 'Your organisation blocks this connector here.',
  server_unavailable: 'The personal database on bee did not answer. Check https://mcp.samjmerrick.com/health, then reload.',
};

const db = createDb({ onChange: sync.onChange });
try {
  show('Connecting to your personal database…');
  await sync.connect();
  const tables = await sync.loadAll((table, n) => show(`Loading ${table}… ${n}`));
  for (const [table, rows] of Object.entries(tables)) db.load(table, rows);
  show('');
} catch (e) {
  const help = LOAD_HELP[e?.code] || `Couldn't load Sift from your personal database: ${e?.message || e}`;
  show(help, { error: true, action: { label: 'Reload', run: () => location.reload() } });
  throw e; // stops app.js from starting on an empty database
}

// The sift-fetch Edge Function, answered here: reader text comes from bee's cache, fetching is bee's job.
async function functions(body) {
  if (body.action === 'read') {
    const item = db.tables.items.find((i) => i.id === Number(body.id));
    if (!item) return { httpStatus: 404, error: 'Article not found' };
    const row = await sync.readerText(item.id);
    if (!row) return { status: 'failed', html: '', text_length: 0, error: "Bee hasn't fetched this article's text yet.", url: item.url, title: item.title };
    const { status, title, byline, site_name, html, text_length, lead_image, error } = row;
    return { status, title: title ?? item.title, byline, site_name, html, text_length, lead_image, error, url: item.url };
  }
  if (['fetch_source', 'fetch_all', 'preview'].includes(body.action)) return { httpStatus: 400, error: NOT_HERE };
  return { httpStatus: 400, error: 'Unknown action' };
}

// supabase-js for the app, talking to the in-memory backend; already signed in.
const backendFetch = createMockFetch(db, { functions });
// Each feed load first picks up articles bee has fetched since the page opened.
let lastPull = Date.now();
const appFetch = async (input, init) => {
  const u = String(input instanceof Request ? input.url : input);
  if (u.includes('/rest/v1/rpc/feed_state') && Date.now() - lastPull > 60000) {
    lastPull = Date.now();
    try {
      const fresh = await sync.loadNew('items');
      const known = new Set(db.tables.items.map((i) => i.id));
      db.load('items', fresh.filter((i) => !known.has(i.id)));
    } catch (e) { console.warn('Sift: could not check for new articles', e); }
  }
  return backendFetch(input, init);
};
const memoryStorage = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
const AUTH_KEY = 'sift-live-auth';
const authStorage = memoryStorage({ [AUTH_KEY]: JSON.stringify(fakeSession()) });
const realCreate = window.supabase.createClient;
window.supabase.createClient = (url, key, options = {}) => realCreate(url, key, {
  ...options,
  global: { ...(options.global || {}), fetch: appFetch },
  auth: { ...(options.auth || {}), storage: authStorage, storageKey: AUTH_KEY, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});
window.SIFT_CONFIG = { supabaseUrl: URL_BASE, supabaseKey: 'live' };

// Starter pack JSON comes from the bundle (the artifact can't load files from GitHub Pages).
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

// Artifact frames have no confirm() dialog (it returns false at once), which would make every delete a no-op,
// so deletes go ahead without asking.
window.confirm = () => true;
window.SIFT_LIVE = { db, sync };
