// Sift client — vanilla JS, no build step. Talks directly to Supabase.
import { createData } from './lib/data.js';
import { buildFeed, generateOne } from './lib/feed.js';
import { GENERATOR_KINDS, scheduleReview, applyReviewToDeck } from './lib/generators.js';
import { SOURCE_KINDS } from './lib/source-kinds.js';
import { installPack } from './lib/packs.js';
import { STAFF, keySigSteps } from './lib/theory.js';
import { sharesFromWeights, toPercents, rankWeights, rankOrder, FALLOFFS, DEFAULT_FALLOFF } from './lib/balance.js';
import { rebalance, saveRank } from './lib/rank.js';
import { sanitiseHtml } from './lib/sanitise.js';

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with trusted, generated markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
const store = {
  get(k, d) { try { const v = localStorage.getItem(`sift:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`sift:${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

let toastTimer;
/** Brief message at the bottom. With `action: { label, onClick }` it stays ~5 s and shows a button (e.g. Undo). */
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (action) {
    t.append(h('button', { type: 'button', onclick: () => { t.classList.remove('show', 'has-action'); clearTimeout(toastTimer); action.onClick(); } }, action.label));
  }
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show', 'has-action'), action ? 5000 : 2200);
}

const config = window.SIFT_CONFIG || {};
let startupError = null;
const data = (() => {
  if (!config.supabaseUrl || !config.supabaseKey) { startupError = 'config.js is missing the Supabase URL or key.'; return null; }
  if (!window.supabase) { startupError = "The Supabase library (vendor/supabase-js) didn't load. A content blocker or a stale cached copy can cause this."; return null; }
  try {
    return createData(window.supabase.createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } }));
  } catch (e) {
    startupError = `Couldn't set up Supabase: ${e.message}`;
    return null;
  }
})();
const fail = (e) => toast(e.message || String(e));

// ---------- icons ----------
const ICON = {
  up: '<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.3 2.6L12.8 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7 13V4H4v9zM7 13l4 8c1.5 0 2.5-1 2.3-2.6L12.8 15H19a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 17.8 4H7"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  comments: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  score: '<svg viewBox="0 0 24 24"><path d="M12 5l7 8h-4v6H9v-6H5z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>',
  arrowup: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  arrowdown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>',
};
const icon = (name) => h('span', { html: ICON[name], style: { display: 'contents' } });

// ---------- global state ----------
let meta = { topics: [], source_kinds: {}, generator_kinds: {}, decks: [] };
const topicById = (id) => meta.topics.find((t) => t.id === id) || { name: '', color: '#888' };
async function loadMeta() {
  const [topics, decks] = await Promise.all([data.topics(), data.deckStats()]);
  meta = {
    topics, decks, source_kinds: SOURCE_KINDS,
    generator_kinds: Object.fromEntries(Object.entries(GENERATOR_KINDS).map(([k, v]) => [k, { label: v.label, description: v.description, fields: v.fields }])),
  };
  renderChips();
}

// ---------- login ----------
function showLogin() {
  $('.topbar').hidden = true; $('.tabbar').hidden = true;
  const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'sub' });
  view.replaceChildren(h('form', {
    class: 'login',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try { await data.signIn(email.value.trim(), password.value); location.reload(); } catch (ex) { err.textContent = ex.message; }
    },
  }, h('h2', {}, 'Sift'), h('label', { class: 'field' }, email), h('label', { class: 'field' }, password),
  h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Sign in'), err));
  email.focus();
}

function showSetup() {
  $('.topbar').hidden = true; $('.tabbar').hidden = true;
  const why = startupError || 'Unknown startup problem.';
  view.replaceChildren(h('div', { class: 'login' }, h('h2', {}, 'Sift'),
    h('p', { class: 'sub' }, `Can't start: ${why}`),
    h('button', { class: 'btn', onclick: () => hardReload() }, 'Clear cache and reload')));
}

/** Drop service-worker caches and reload — fixes "stuck on an old version". */
async function hardReload() {
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
    for (const k of (await caches?.keys?.()) || []) await caches.delete(k);
  } catch { /* best effort */ }
  location.reload();
}

// ---------- topic filter: quick chips + a full picker ----------
// The filter is a set of topic ids; an empty set means "all topics".
const loadFilter = () => { const v = store.get('filter', null); return new Set(Array.isArray(v) ? v : v ? [v] : []); };
let filter = loadFilter();
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const KIND_LABEL = { articles: 'Articles', cards: 'Cards' };
const enabledTopics = () => meta.topics.filter((t) => t.enabled);
function setFilter(ids) {
  filter = new Set(ids);
  store.set('filter', [...filter]);
  renderChips();
  if (route().name !== 'feed') location.hash = '#/'; else resetFeed();
}
function renderChips() {
  const enabled = enabledTopics();
  filter = new Set([...filter].filter((id) => enabled.some((t) => t.id === id)));
  const btn = $('#topics-btn');
  btn.hidden = enabled.length < 2 || route().name === 'settings';
  if (filter.size) btn.dataset.on = ''; else delete btn.dataset.on;
  renderTypebar();
}

// ---------- feed type filter: All · Articles · Cards (this visit only; not remembered) ----------
let feedType = 'all';
const typebar = $('#typebar');
const TYPES = [['all', 'All'], ['articles', 'Articles'], ['cards', 'Cards']];
typebar.querySelector('.seg').append(...TYPES.map(([k, label]) => h('button', {
  type: 'button', 'data-type': k, onclick: () => setFeedType(k),
}, label)));
function renderTypebar() {
  const enabled = enabledTopics();
  const both = enabled.some((t) => t.kind === 'articles') && enabled.some((t) => t.kind === 'cards');
  if (!both && feedType !== 'all') { feedType = 'all'; feed.dirty = true; }
  typebar.hidden = !(both && route().name === 'feed');
  typebar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === feedType)));
}
function setFeedType(k) {
  if (k === feedType) return;
  feedType = k;
  renderTypebar();
  showTypebar(true);
  resetFeed();
}
// Slide away when scrolling down, come back on any scroll up (and always near the top).
let barY = 0, barTick = false;
function showTypebar(on) { if (on) typebar.removeAttribute('data-hidden'); else typebar.setAttribute('data-hidden', ''); }
addEventListener('scroll', () => {
  if (barTick || typebar.hidden) return;
  barTick = true;
  requestAnimationFrame(() => {
    barTick = false;
    const y = scrollY, d = y - barY;
    if (y < 60) { showTypebar(true); barY = y; } else if (d > 8) { showTypebar(false); barY = y; } else if (d < -8) { showTypebar(true); barY = y; }
  });
}, { passive: true });
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`)).observe($('.topbar'));

function openTopicPicker() {
  const topics = enabledTopics();
  const total = topics.reduce((s, t) => s + t.weight, 0) || 1;
  const draft = new Set(filter.size ? filter : topics.map((t) => t.id)); // "all" shows as everything ticked
  const search = h('input', { type: 'search', placeholder: 'Search topics', 'aria-label': 'Search topics', autocomplete: 'off' });
  const list = h('div');
  const apply = h('button', { class: 'btn primary', style: { flex: 1 } });
  const sync = () => {
    apply.disabled = draft.size === 0;
    apply.textContent = draft.size === 0 ? 'Pick at least one topic' : draft.size === topics.length ? 'Show all topics' : `Show ${draft.size} topic${draft.size === 1 ? '' : 's'}`;
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = topics.filter((t) => !q || t.name.toLowerCase().includes(q));
    list.replaceChildren(shown.length ? h('div', { class: 'list' }, shown.map((t) => {
      const box = h('input', { type: 'checkbox', class: 'tick', onchange: (e) => { if (e.target.checked) draft.add(t.id); else draft.delete(t.id); draw(); } });
      box.checked = draft.has(t.id);
      return h('label', { class: 'row pick' }, h('span', { class: 'dot', style: { '--c': t.color } }),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'desc' }, `${KIND_LABEL[t.kind]} · ${Math.round((t.weight / total) * 100)}% of feed`)), box);
    })) : h('p', { class: 'status' }, 'No topics match.'));
    sync();
  };
  search.oninput = draw;
  apply.onclick = () => { if (draft.size) setFilter(draft.size === topics.length ? [] : [...draft]); closeSheet(); };
  openSheet('Filter topics', h('div', {},
    topics.length > 8 ? h('div', { class: 'field' }, search) : null,
    h('div', { class: 'pick-quick' },
      h('button', { class: 'chip', onclick: () => { topics.forEach((t) => draft.add(t.id)); draw(); } }, 'Select all'),
      h('button', { class: 'chip', onclick: () => { draft.clear(); draw(); } }, 'Clear')),
    list,
    h('div', { class: 'pick-foot' }, apply)));
  draw();
}
$('#topics-btn').onclick = openTopicPicker;

// ---------- seen tracking (articles only) ----------
const seenQueue = new Set();
const seenObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting && e.intersectionRatio >= 0.5) {
      el._seenTimer = setTimeout(() => { seenQueue.add(Number(el.dataset.item)); seenObserver.unobserve(el); }, 1200);
    } else clearTimeout(el._seenTimer);
  }
}, { threshold: [0, 0.5] });
setInterval(flushSeen, 4000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSeen());
function flushSeen() {
  if (!seenQueue.size) return;
  const ids = [...seenQueue];
  seenQueue.clear();
  data.markSeen(ids).catch(() => ids.forEach((id) => seenQueue.add(id)));
}

// ---------- feed ----------
const articleData = new Map(); // item_id -> article card data, for the reader and the ⋯ sheet
const feed = { state: null, list: null, sentinel: null, loading: false, done: false, itemIds: [], recentKeys: [], recentTopics: [], dirty: false, scrollY: 0, el: null };

function resetFeed() {
  feed.el = null;
  renderFeed();
}

function renderFeed() {
  if (feed.el && !feed.dirty) { view.replaceChildren(feed.el); requestAnimationFrame(() => scrollTo(0, feed.scrollY)); return; }
  Object.assign(feed, { state: null, loading: false, done: false, itemIds: [], recentKeys: [], recentTopics: [], dirty: false, scrollY: 0 });
  barY = 0; showTypebar(true);
  feed.list = h('div', { class: 'feed' });
  feed.status = h('div', { class: 'status' });
  feed.sentinel = h('div', { style: { height: '1px' } });
  feed.el = h('div', {}, feed.list, feed.status, feed.sentinel);
  view.replaceChildren(feed.el);
  scrollTo(0, 0);
  feed.list.append(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  loadMore(true);
  feedObserver.disconnect();
  feedObserver.observe(feed.sentinel);
}
const feedObserver = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '1400px 0px' });

async function loadMore(first = false) {
  if (feed.loading || feed.done) return;
  feed.loading = true;
  const list = feed.list;
  try {
    if (!feed.state) {
      const state = await data.feedState();
      if (list !== feed.list) return; // feed was reset meanwhile
      feed.state = state;
    }
    const cards = buildFeed(feed.state, {
      n: first ? 8 : 12, topicIds: [...filter], type: feedType, excludeItems: feed.itemIds, recentKeys: feed.recentKeys.slice(-60), recentTopics: feed.recentTopics.slice(-2),
    });
    if (first) list.replaceChildren();
    for (const c of cards) {
      if (c.item_id) feed.itemIds.push(c.item_id);
      feed.recentKeys.push(c.key);
      feed.recentTopics.push(c.topic_id);
      list.append(renderCard(c));
    }
    if (!cards.length) {
      feed.done = true;
      if (!list.children.length) {
        const fresh = !meta.topics.length;
        const typed = feedType !== 'all' && !fresh;
        const noun = feedType === 'articles' ? 'article' : 'card';
        const inFilter = enabledTopics().filter((t) => t.kind === feedType && (!filter.size || filter.has(t.id)));
        const [title, text] = fresh ? ['Welcome to Sift', 'Your feed is empty because you have no topics yet. Add a starter pack, or create your own topic in Settings.']
          : !typed ? ['Nothing here yet', 'Sources are fetched every hour. Add sources or card types in Settings, or use "Fetch all now" there.']
          : !inFilter.length ? [`No ${noun} topics in your filter`, `Your topic filter has no ${noun} topics. Change the filter, or show everything.`]
          : feedType === 'articles' ? ["You're all caught up on articles", 'New articles arrive every hour. Show everything to mix in practice cards.']
          : ['No cards to practise right now', 'Nothing is due, or the daily new-card limit has been reached. Show everything to see articles.'];
        list.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, text),
          fresh ? h('button', { class: 'btn primary', onclick: () => { location.hash = '#/settings/topics'; } }, 'Set up topics')
            : typed ? h('button', { class: 'btn primary', onclick: () => setFeedType('all') }, 'Show everything') : null));
      } else feed.status.textContent = feedType === 'articles' ? "You're all caught up on articles." : "You're all caught up.";
    }
  } catch (e) {
    if (first) list.replaceChildren();
    feed.status.replaceChildren(h('div', {}, `Couldn't load the feed: ${e.message}`), h('button', { class: 'btn', style: { marginTop: '10px' }, onclick: () => { feed.status.textContent = ''; loadMore(first); } }, 'Retry'));
  } finally {
    feed.loading = false;
  }
  // Keep filling if the sentinel is still on screen.
  if (!feed.done && feed.sentinel.getBoundingClientRect().top < innerHeight + 1400) setTimeout(() => loadMore(), 50);
}

// ---------- card rendering ----------
function metaRow(c, extra = []) {
  const t = topicById(c.topic_id);
  return h('div', { class: 'meta' }, h('span', { class: 'dot', style: { '--c': t.color } }), h('span', { class: 'topic' }, t.name),
    ...extra.filter(Boolean).flatMap((x) => [h('span', { class: 'sep' }), h('span', { class: 'trunc' }, x)]));
}

function reactionButtons(c, { onReact, onSave, initialReaction = 0, initialSaved = false }) {
  let reaction = initialReaction;
  let saved = initialSaved;
  const up = h('button', { class: 'act up', 'aria-label': 'More like this', 'aria-pressed': String(reaction === 1) }, icon('up'));
  const down = h('button', { class: 'act down', 'aria-label': 'Less like this', 'aria-pressed': String(reaction === -1) }, icon('down'));
  const save = h('button', { class: 'act save', 'aria-label': 'Save', 'aria-pressed': String(saved) }, icon('save'));
  const set = (r) => {
    reaction = reaction === r ? 0 : r;
    up.setAttribute('aria-pressed', String(reaction === 1));
    down.setAttribute('aria-pressed', String(reaction === -1));
    onReact(reaction).catch((e) => toast(e.message));
    if (reaction === -1) toast('Got it — less of this');
  };
  up.onclick = () => set(1);
  down.onclick = () => set(-1);
  save.onclick = async () => {
    saved = !saved;
    save.setAttribute('aria-pressed', String(saved));
    try { await onSave(saved); toast(saved ? 'Saved' : 'Removed from saved'); } catch (e) { toast(e.message); }
  };
  return [up, down, save];
}

function renderCard(c, { savedId } = {}) {
  const t = topicById(c.topic_id);
  const card = h('article', { class: `card k-${c.kind}`, style: { '--c': t.color } });
  if (c.topic_id != null) card.dataset.topic = c.topic_id;
  if (c.kind === 'article') return renderArticle(c, card);
  if (c.generator_id != null) card.dataset.generator = c.generator_id;

  const body = (GEN_RENDER[c.kind] || ((x) => [h('p', {}, JSON.stringify(x))]))(c);
  let savedCardId = savedId ?? null;
  const btns = reactionButtons(c, {
    initialSaved: savedId != null,
    onReact: async (r) => {
      // 👍/👎 on a generated card nudges that card type's share of its topic.
      const g = feed.state?.generators.find((x) => x.id === c.generator_id);
      if (!r || !g) return;
      g.weight = Math.min(10, Math.max(0.1, g.weight * (r > 0 ? 1.1 : 0.85)));
      await data.setGeneratorWeight(g.id, g.weight);
    },
    onSave: async (s) => {
      if (s) savedCardId = await data.saveCard(c.topic_id, c);
      else if (savedCardId) { await data.deleteSavedCard(savedCardId); savedCardId = null; }
    },
  });
  card.append(metaRow(c, [c.kind === 'note' ? c.deck : null, generatorButton(c) || c.generator]), ...body.filter(Boolean), h('div', { class: 'actions' }, h('span', { class: 'spacer' }), ...btns,
    c.generator ? h('button', { class: 'act more', 'aria-label': `More options for ${c.generator}`, onclick: () => openCardTypeSheet(c) }, icon('more')) : null));
  return card;
}

function renderArticle(c, card) {
  const url = safeUrl(c.url);
  const comments = safeUrl(c.comments_url);
  const summary = c.summary ? h('p', { class: 'summary', onclick: (e) => e.currentTarget.classList.toggle('open') }, c.summary) : null;
  const img = safeUrl(c.image) ? h('img', { class: 'thumb', src: c.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null;
  const btns = reactionButtons(c, {
    initialReaction: c.reaction, initialSaved: c.saved,
    onReact: async (r) => { await data.reactItem(c.item_id, r); c.reaction = r; },
    onSave: async (s) => { await data.saveItem(c.item_id, s); c.saved = s; },
  });
  articleData.set(c.item_id, c);
  card.dataset.item = c.item_id;
  if (c.source_id != null) card.dataset.source = c.source_id;
  if (c.domain) card.dataset.domain = c.domain;
  // A plain left click opens the in-app reader; the href still points at the original so long-press,
  // middle-click and "open in new tab" keep working.
  const openReader = (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    location.hash = `#/read/${c.item_id}`;
  };
  card.append(
    metaRow(c, [sourceButton(c), c.published_at && ago(c.published_at)]),
    h('div', { class: 'article-body' },
      h('div', {}, h('h3', {}, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', onclick: openReader }, c.title)), summary),
      img),
    h('div', { class: 'actions' },
      c.score != null ? h('span', { class: 'act', title: 'Community score' }, icon('score'), compact(c.score)) : null,
      comments && comments !== url ? h('a', { class: 'act', href: comments, target: '_blank', rel: 'noopener noreferrer', title: 'Discussion' }, icon('comments'), c.comments != null ? compact(c.comments) : '') : null,
      h('span', { class: 'act', style: { cursor: 'default', paddingLeft: '4px' } }, c.domain || ''),
      h('span', { class: 'spacer' }), ...btns,
      c.source_id != null ? h('button', { class: 'act more', 'aria-label': `More options for ${c.source}`, onclick: () => openSourceSheet(c) }, icon('more')) : null),
  );
  seenObserver.observe(card);
  return card;
}

function revealable(label, renderAnswer) {
  const wrap = h('div');
  const btn = h('button', { class: 'reveal', onclick: () => { wrap.replaceChildren(h('div', { class: 'answer' }, ...renderAnswer())); } }, label);
  wrap.append(btn);
  return wrap;
}

const GEN_RENDER = {
  flashcard(c) {
    // The deck's language tags whichever side is in it. Cards saved before decks had a language look it up.
    const lang = (c.lang ?? meta.decks.find((d) => d.id === c.deck_id)?.lang) || null;
    const statusLabel = { new: 'New', review: 'Review', relearn: 'Relearn' }[c.status] || '';
    const area = h('div');
    const grade = async (g) => {
      try {
        const deck = feed.state?.decks[c.deck_id];
        const card = deck && [...deck.due, ...deck.new].find((x) => x.id === c.card_id);
        if (!card) throw new Error('Card is no longer in the queue; refresh the feed.');
        const r = scheduleReview(card, g);
        await data.updateCard(card.id, r);
        applyReviewToDeck(deck, card, r);
        const days = r.interval_days;
        area.replaceChildren(h('p', { class: 'graded' }, g === 'again' ? "We'll show it again in a few minutes." : `Next review in ${days < 1.5 ? '1 day' : `${Math.round(days)} days`}.`));
      } catch (e) { toast(e.message); }
    };
    area.append(h('button', {
      class: 'reveal',
      onclick: () => area.replaceChildren(
        h('div', { class: 'answer' }, h('div', { class: 'a-main', lang: c.reverse ? lang : null }, c.back), c.note ? h('div', { class: 'a-note' }, c.note) : null),
        h('div', { class: 'grade' },
          h('button', { class: 'again', onclick: () => grade('again') }, 'Again', h('small', {}, '< 10 min')),
          h('button', { class: 'good', onclick: () => grade('good') }, 'Good', h('small', {}, 'got it')),
          h('button', { onclick: () => grade('easy') }, 'Easy', h('small', {}, 'too easy'))),
      ),
    }, 'Show answer'));
    return [h('div', { class: 'label', style: { marginTop: '8px' } }, statusLabel), h('div', { class: 'big', lang: c.reverse ? null : lang }, c.front), area];
  },
  guitar_chord(c) {
    const answer = () => [h('div', { class: 'diagram', html: chordSvg(c.frets) }), h('div', { class: 'a-note' }, `${c.notes} · ${c.shape === 'open' ? 'open position' : c.shape}`)];
    return [h('div', { class: 'big' }, c.name), h('p', { class: 'sub', style: { textAlign: 'center' } }, c.quality),
      c.quiz ? revealable('Picture the shape, then tap to check', answer) : h('div', { class: 'answer' }, ...answer())];
  },
  fretboard(c) {
    const diagram = () => h('div', { class: 'diagram', html: fretboardSvg(c) });
    if (c.quiz) return [h('p', { class: 'q' }, c.title), revealable('Tap to reveal', () => [h('div', { class: 'a-main' }, c.answer), diagram()])];
    return [h('p', { class: 'q' }, c.title), c.subtitle ? h('p', { class: 'sub' }, c.subtitle) : null, diagram(), h('p', { class: 'sub', style: { textAlign: 'center' } }, c.notes)];
  },
  keyboard(c) {
    return [h('p', { class: 'q' }, c.title), h('p', { class: 'sub' }, c.subtitle),
      revealable('Say the notes, then tap to check', () => [h('div', { class: 'a-main' }, c.answer), h('div', { class: 'diagram', html: keyboardSvg(c.keys) })])];
  },
  quiz(c) {
    return [h('p', { class: 'q' }, c.title), revealable('Tap to reveal', () => [h('div', { class: 'a-main' }, c.answer)])];
  },
  ear(c) {
    const play = () => playNotes(c.notes, c.harmonic);
    const dirText = c.harmonic ? 'Two notes together' : c.direction === 'down' ? 'Descending' : 'Ascending';
    return [h('p', { class: 'q' }, c.title), h('p', { class: 'sub' }, dirText),
      h('div', { class: 'play' }, h('button', { class: 'btn primary', onclick: play }, icon('play'), 'Play')),
      revealable('Tap to reveal', () => [h('div', { class: 'a-main' }, c.answer), h('div', { class: 'play' }, h('button', { class: 'btn', onclick: play }, icon('play'), 'Hear again'))])];
  },
  staff(c) {
    const midis = c.notes.map((n) => n.midi);
    const diagram = h('div', { class: 'diagram', html: staffSvg(c) });
    const play = (label) => h('button', { class: label === 'Play' ? 'btn primary' : 'btn', onclick: () => (c.notes.length > 1 ? playNotes(midis, false, 0.6, 1.1) : playNotes(midis, false)) }, icon('play'), label);
    return [h('p', { class: 'q' }, c.title), h('p', { class: 'sub' }, c.subtitle), diagram,
      c.audio === 'always' ? h('div', { class: 'play' }, play('Play')) : null,
      revealable('Say the notes, then tap to check', () => {
        diagram.innerHTML = staffSvg(c, true);
        return [h('div', { class: 'a-main' }, c.answer), h('div', { class: 'a-note' }, c.detail), c.audio !== 'off' ? h('div', { class: 'play' }, play('Hear it')) : null];
      })];
  },
  note(c) {
    return [h('h3', { class: 'note-title', lang: c.lang || null }, c.title), h('p', { class: 'note-body' }, c.body), c.note ? h('p', { class: 'note-extra' }, c.note) : null];
  },
  prompt(c) {
    return [h('div', { class: 'label', style: { marginTop: '8px' } }, c.label), h('p', { class: 'prompt-text' }, c.text)];
  },
};

// ---------- diagrams (SVG strings built only from numbers and our own note names) ----------
function chordSvg(frets) {
  const played = frets.filter((f) => f != null && f > 0);
  const maxF = Math.max(0, ...played);
  const base = maxF <= 4 ? 1 : Math.min(...played);
  const rows = Math.max(4, maxF - base + 1);
  const x0 = 30, dx = 20, y0 = 34, dy = 26, w = x0 * 2 + dx * 5, hgt = y0 + dy * rows + 14;
  let s = `<svg viewBox="0 0 ${w} ${hgt}" width="${w * 1.25}" role="img" aria-label="Chord diagram">`;
  for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * dx}" y1="${y0}" x2="${x0 + i * dx}" y2="${y0 + rows * dy}" stroke-width="1.2"/>`;
  for (let r = 0; r <= rows; r++) s += `<line x1="${x0}" y1="${y0 + r * dy}" x2="${x0 + 5 * dx}" y2="${y0 + r * dy}" stroke-width="${r === 0 && base === 1 ? 5 : 1.2}"/>`;
  if (base > 1) s += `<text x="${x0 - 10}" y="${y0 + dy * 0.62}" font-size="11" text-anchor="end">${base}fr</text>`;
  const minF = played.length ? Math.min(...played) : 0;
  const idx = frets.map((f, i) => (f === minF ? i : -1)).filter((i) => i >= 0);
  const barre = minF > 0 && idx.length >= 2 && frets[5] === minF && (base > 1 || minF === 1)
    && frets.slice(idx[0], 6).every((f) => f != null && f >= minF);
  if (barre) {
    const y = y0 + (minF - base + 0.5) * dy;
    s += `<rect x="${x0 + idx[0] * dx - 7}" y="${y - 7}" width="${(5 - idx[0]) * dx + 14}" height="14" rx="7" fill="currentColor" stroke="none"/>`;
  }
  frets.forEach((f, i) => {
    const x = x0 + i * dx;
    if (f == null) s += `<text x="${x}" y="${y0 - 10}" font-size="13" text-anchor="middle">×</text>`;
    else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 14}" r="5" stroke-width="1.5"/>`;
    else if (!(barre && f === minF)) s += `<circle cx="${x}" cy="${y0 + (f - base + 0.5) * dy}" r="7.5" fill="currentColor" stroke="none"/>`;
  });
  ['E', 'A', 'D', 'G', 'B', 'e'].forEach((n, i) => { s += `<text x="${x0 + i * dx}" y="${hgt - 1}" font-size="10" text-anchor="middle" opacity=".55">${n}</text>`; });
  return `${s}</svg>`;
}

function fretboardSvg(c) {
  const { start, end, dots } = c;
  const W = 340, left = 20, top = 12, sy = 17;
  const openW = start === 0 ? 22 : 0;
  const first = Math.max(start, 1);
  const n = end - first + 1;
  const cw = (W - left - openW - 6) / n;
  const H = top + sy * 5 + 30;
  const xOf = (f) => (f === 0 ? left + openW / 2 : left + openW + (f - first + 0.5) * cw);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Fretboard diagram">`;
  for (let r = 0; r < 6; r++) {
    const y = top + r * sy;
    s += `<line x1="${left + (openW ? 4 : 0)}" y1="${y}" x2="${W - 6}" y2="${y}" stroke-width="${0.8 + (r * 0.25)}" opacity=".7"/>`;
    s += `<text x="4" y="${y + 3.5}" font-size="9.5" opacity=".55">${['e', 'B', 'G', 'D', 'A', 'E'][r]}</text>`;
  }
  for (let i = 0; i <= n; i++) {
    const x = left + openW + i * cw;
    const isNut = i === 0 && first === 1;
    s += `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + sy * 5}" stroke-width="${isNut ? 4 : 1}" opacity="${isNut ? 1 : 0.5}"/>`;
  }
  for (let f = first; f <= end; f++) {
    if ([3, 5, 7, 9, 12, 15].includes(f) || f === first) {
      s += `<text x="${xOf(f)}" y="${H - 6}" font-size="10" text-anchor="middle" opacity="${f === first && ![3, 5, 7, 9, 12, 15].includes(f) ? 0.85 : 0.5}">${f}</text>`;
    }
  }
  const r = Math.min(cw * 0.4, 8.5);
  for (const d of dots) {
    const x = xOf(d.f), y = top + (5 - d.s) * sy;
    s += d.root
      ? `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--accent)" stroke="none"/>`
      : `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--surface)" stroke="currentColor" stroke-width="1.4"/>`;
    if (d.label) s += `<text x="${x}" y="${y + 3}" font-size="${d.label.length > 2 ? 6.5 : 8}" text-anchor="middle" font-weight="600" ${d.root ? 'style="fill:var(--accent-ink)"' : ''}>${esc(d.label)}</text>`;
  }
  return `${s}</svg>`;
}

function keyboardSvg(keys) {
  const set = new Set(keys);
  const octaves = Math.max(...keys) >= 24 ? 3 : 2;
  const ww = 22, wh = 92, bw = 14, bh = 56;
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const blacks = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]]; // [semitone, white index it follows]
  const W = whites.length * octaves * ww + 2;
  let s = `<svg viewBox="0 0 ${W} ${wh + 2}" width="${W}" role="img" aria-label="Keyboard">`;
  for (let o = 0; o < octaves; o++) {
    whites.forEach((semi, i) => {
      const on = set.has(o * 12 + semi);
      s += `<rect x="${1 + (o * 7 + i) * ww}" y="1" width="${ww}" height="${wh}" rx="3" fill="${on ? 'var(--accent)' : '#fff'}" stroke="#8a8378" stroke-width="1"/>`;
    });
  }
  for (let o = 0; o < octaves; o++) {
    for (const [semi, after] of blacks) {
      const on = set.has(o * 12 + semi);
      s += `<rect x="${1 + (o * 7 + after + 1) * ww - bw / 2}" y="1" width="${bw}" height="${bh}" rx="2" fill="${on ? 'var(--accent)' : '#222'}" stroke="#222" stroke-width="1"/>`;
    }
  }
  return `${s}</svg>`;
}

// Notes on a staff. Positions use the diatonic step `d` (see lib/theory.js): one shared vertical scale for both clefs.
const TREBLE_CLEF = 'M-6 19C-7 26 2 28 3.4 19C4 12 4 4 4.4-6C5-22 6.5-36 9-44C11-50 14-47 13-41C11.5-32 1-26-5-17C-12-6-8 9 2.5 9.5C11.5 10 13.5-2 6.5-7.5C-.5-13-9.5-6.5-6 1.5C-4 6 2 5.5 2.6 1';
const BASS_CLEF = 'M-4 0C-4-9 8-11 12-3C15 5 6 19-12 27';
const sharpGlyph = (x, y) => `<path d="M${x - 2} ${y - 8}V${y + 9}M${x + 2} ${y - 9}V${y + 8}" stroke-width="1.1"/><path d="M${x - 4.5} ${y + 1.5}L${x + 4.5} ${y - 2}M${x - 4.5} ${y + 5.5}L${x + 4.5} ${y + 2}" stroke-width="2.4"/>`;
const flatGlyph = (x, y) => `<path d="M${x - 2} ${y - 12}V${y + 4}C${x + 6} ${y + 1} ${x + 6} ${y - 6} ${x - 2} ${y - 3.5}" stroke-width="1.5"/>`;
const naturalGlyph = (x, y) => `<path d="M${x - 2.5} ${y - 9}V${y + 4}M${x + 2.5} ${y - 4}V${y + 9}" stroke-width="1.1"/><path d="M${x - 2.5} ${y + 4}L${x + 2.5} ${y + 2.3}M${x - 2.5} ${y - 1.3}L${x + 2.5} ${y - 3}" stroke-width="2"/>`;

function staffSvg(c, labels = false) {
  const STEP = 5; // px per diatonic step; staff lines are two steps (10px) apart
  const grand = c.clef === 'grand';
  const staves = grand ? ['treble', 'bass'] : [c.clef];
  const topLine = Math.max(...staves.map((k) => STAFF[k].bottom + 8));
  const bottomLine = Math.min(...staves.map((k) => STAFF[k].bottom));
  const dTop = topLine + 5;
  labels = labels && c.notes.length > 1; // a single note's name is already the answer
  const y = (d) => 10 + (dTop - d) * STEP;
  const nSig = Math.abs(c.keyN || 0);
  const x0 = 6 + (grand ? 14 : 0);
  const sigX = x0 + 38;
  const noteX0 = sigX + (nSig ? nSig * 9 + 6 : 0) + 24;
  const GAP = 30;
  const W = noteX0 + (c.notes.length - 1) * GAP + 28;
  const H = 20 + (dTop - (bottomLine - 5)) * STEP + (labels ? 22 : 0);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${Math.round(W * 1.2)}" role="img" aria-label="${esc(c.subtitle)}" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
  for (const clef of staves) {
    const b = STAFF[clef].bottom;
    for (let i = 0; i < 5; i++) s += `<line x1="${x0}" y1="${y(b + 2 * i)}" x2="${W - 4}" y2="${y(b + 2 * i)}" stroke-width="1" opacity=".75"/>`;
    if (clef === 'treble') s += `<path d="${TREBLE_CLEF}" transform="translate(${x0 + 14} ${y(b + 2)})" stroke-width="2.3"/>`;
    else {
      const fy = y(b + 6);
      s += `<g transform="translate(${x0 + 8} ${fy})"><path d="${BASS_CLEF}" stroke-width="2.8"/><circle r="3.4" fill="currentColor" stroke="none"/><circle cx="18" cy="-5" r="1.8" fill="currentColor" stroke="none"/><circle cx="18" cy="5" r="1.8" fill="currentColor" stroke="none"/></g>`;
    }
    keySigSteps(c.keyN || 0, clef).forEach((st, i) => { s += (c.keyN > 0 ? sharpGlyph : flatGlyph)(sigX + 8 + i * 9, y(b + st)); });
  }
  if (grand) {
    const yt = y(topLine), yb = y(bottomLine), mid = (yt + yb) / 2;
    s += `<path d="M${x0} ${yt}V${yb}" stroke-width="1.2"/><path d="M${x0 - 3} ${yt}C${x0 - 15} ${yt + 30} ${x0 - 3} ${mid - 18} ${x0 - 11} ${mid}C${x0 - 3} ${mid + 18} ${x0 - 15} ${yb - 30} ${x0 - 3} ${yb}" stroke-width="2"/>`;
  }
  c.notes.forEach((n, i) => {
    const x = noteX0 + i * GAP, ny = y(n.d), b = STAFF[n.staff].bottom;
    for (let d = b - 2; d >= n.d; d -= 2) s += `<line x1="${x - 10}" y1="${y(d)}" x2="${x + 10}" y2="${y(d)}" stroke-width="1.2"/>`;
    for (let d = b + 10; d <= n.d; d += 2) s += `<line x1="${x - 10}" y1="${y(d)}" x2="${x + 10}" y2="${y(d)}" stroke-width="1.2"/>`;
    const up = n.d < b + 4;
    s += up ? `<line x1="${x + 5.6}" y1="${ny - 1}" x2="${x + 5.6}" y2="${ny - 33}" stroke-width="1.4"/>` : `<line x1="${x - 5.6}" y1="${ny + 1}" x2="${x - 5.6}" y2="${ny + 33}" stroke-width="1.4"/>`;
    s += `<ellipse cx="${x}" cy="${ny}" rx="6" ry="4.4" transform="rotate(-20 ${x} ${ny})" fill="currentColor" stroke="none"/>`;
    if (n.show) s += (n.acc > 0 ? sharpGlyph : n.acc < 0 ? flatGlyph : naturalGlyph)(x - 16, ny);
    if (labels) s += `<text x="${x}" y="${H - 7}" font-size="14" font-weight="600" text-anchor="middle">${esc(n.name)}</text>`;
  });
  return `${s}</svg>`;
}

// ---------- audio (ear training, sight reading) ----------
let audioCtx;
function playNotes(midis, harmonic, gap = 0.9, dur = 1.4) {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
  const t0 = audioCtx.currentTime + 0.05;
  midis.forEach((m, i) => tone(m, harmonic ? t0 : t0 + i * gap, harmonic ? 2 : dur));
}
function tone(midi, t, dur) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const out = audioCtx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  out.connect(audioCtx.destination);
  [[1, 1], [2, 0.35], [3, 0.12], [4, 0.06]].forEach(([mul, g]) => {
    const o = audioCtx.createOscillator();
    const gn = audioCtx.createGain();
    o.frequency.value = f * mul;
    gn.gain.value = g;
    o.connect(gn).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  });
}

// ---------- changing what the feed shows (⋯ sheet) ----------
const sourceButton = (c, opts) => (c.source ? h('button', { class: 'src-btn', type: 'button', title: 'Options for this source', onclick: () => openSourceSheet(c, opts) }, c.source) : null);
const generatorButton = (c) => (c.generator ? h('button', { class: 'src-btn', type: 'button', title: 'Options for this card type', onclick: () => openCardTypeSheet(c) }, c.generator) : null);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Remove rendered feed cards whose data-* attributes match, so hidden things vanish immediately. */
function removeFeedCards(match) {
  if (!feed.el) return;
  for (const el of feed.el.querySelectorAll('.card')) {
    if (!match(el.dataset)) continue;
    seenObserver.unobserve(el);
    clearTimeout(el._seenTimer);
    el.remove();
  }
  if (feed.done && feed.list && !feed.list.children.length) feed.status.textContent = "You're all caught up.";
}

/**
 * Persist a "hide" choice, drop what it covers from the feed (DOM and in-memory state), and offer Undo.
 * dropItem(item) / dropCard(dataset) say what is covered; local()/unlocal() adjust other in-memory state.
 */
async function hideFromFeed({ name, persist, undo, dropItem, dropCard, local, unlocal, done }) {
  try { await persist(); } catch (e) { return fail(e); }
  const state = feed.state;
  const removed = state ? state.items.filter(dropItem) : [];
  if (state) state.items = state.items.filter((i) => !dropItem(i));
  local?.();
  removeFeedCards(dropCard);
  done?.();
  toast(`Hidden ${name}`, {
    label: 'Undo',
    onClick: async () => {
      try { await undo(); } catch (e) { return fail(e); }
      unlocal?.();
      if (state && feed.state === state) {
        state.items.push(...removed);
        const gone = new Set(removed.map((i) => i.id));
        feed.itemIds = feed.itemIds.filter((x) => !gone.has(x)); // let them be picked again further down
      }
      feed.dirty = true;
      toast(`Restored ${name}`);
    },
  });
}

const hideSource = (c, done) => hideFromFeed({
  name: c.source,
  persist: () => data.update('sources', c.source_id, { enabled: false }),
  undo: () => data.update('sources', c.source_id, { enabled: true }),
  dropItem: (i) => i.source_id === c.source_id,
  dropCard: (d) => d.source === String(c.source_id),
  local: () => { const s = feed.state?.sources.find((x) => x.id === c.source_id); if (s) s.enabled = false; },
  unlocal: () => { const s = feed.state?.sources.find((x) => x.id === c.source_id); if (s) s.enabled = true; },
  done,
});

const hideDomain = (c, done) => hideFromFeed({
  name: c.domain,
  persist: () => data.muteDomain(c.domain),
  undo: () => data.unmuteDomain(c.domain),
  dropItem: (i) => i.domain === c.domain,
  dropCard: (d) => d.domain === c.domain,
  done,
});

const hideTopic = (c, done) => {
  const t = topicById(c.topic_id);
  const setEnabled = (v) => {
    for (const list of [meta.topics, feed.state?.topics || []]) { const x = list.find((y) => y.id === c.topic_id); if (x) x.enabled = v; }
    renderChips();
  };
  return hideFromFeed({
    name: t.name,
    persist: async () => { await data.update('topics', c.topic_id, { enabled: false }); await rebalanceNow(); },
    undo: async () => { await data.update('topics', c.topic_id, { enabled: true }); await rebalanceNow(); },
    dropItem: (i) => i.topic_id === c.topic_id,
    dropCard: (d) => d.topic === String(c.topic_id),
    local: () => {
      const filtered = filter.has(c.topic_id);
      setEnabled(false); // renderChips drops it from the filter
      if (filtered) { store.set('filter', [...filter]); feed.dirty = true; if (route().name === 'feed') resetFeed(); }
    },
    unlocal: () => setEnabled(true),
    done,
  });
};

async function nudgeSource(c, factor) {
  try {
    const src = (await data.sourceStats()).find((s) => s.id === c.source_id);
    if (!src) throw new Error('That source no longer exists.');
    const next = clamp(+(src.weight * factor).toFixed(2), 0.1, 10);
    if (next === src.weight) return toast(factor < 1 ? 'Already at the lowest weight' : 'Already at the highest weight');
    const apply = async (w) => {
      await data.update('sources', c.source_id, { weight: w });
      const s = feed.state?.sources.find((x) => x.id === c.source_id);
      if (s) s.weight = w;
    };
    await apply(next);
    toast(`${factor < 1 ? 'Less' : 'More'} from ${c.source}`, { label: 'Undo', onClick: () => apply(src.weight).catch(fail) });
  } catch (e) { fail(e); }
}

async function editSourceFor(c) {
  try {
    const src = (await data.sourceStats()).find((s) => s.id === c.source_id);
    if (!src) throw new Error('That source no longer exists.');
    const target = `#/settings/topic/${src.topic_id}`;
    if (location.hash !== target) {
      const routed = new Promise((resolve) => window.addEventListener('hashchange', resolve, { once: true }));
      location.hash = target;
      await routed; // onRoute (registered first) has run and closed any sheet by now
    }
    await loadMeta().catch(() => {});
    editSource(src);
  } catch (e) { fail(e); }
}

const sheetAct = (fn) => () => { closeSheet(); fn(); };
const sheetRow = (title, desc, onclick) => h('button', { class: 'row row-btn', type: 'button', onclick },
  h('div', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'desc' }, desc)));

/** The ⋯ sheet: hide, rebalance or edit what a card came from. */
function openSourceSheet(c, { reader = false } = {}) {
  const topic = topicById(c.topic_id);
  const done = () => { if (reader) leaveReader(); };
  const act = sheetAct;
  const row = sheetRow;
  openSheet(c.source || 'This card', h('div', { class: 'list' }, [
    row(`Hide source “${c.source}”`, 'Stop showing articles from it. You can undo this.', act(() => hideSource(c, done))),
    c.domain ? row(`Hide ${c.domain}`, 'Never show links to this site, whichever source they come from.', act(() => hideDomain(c, done))) : null,
    row('Show less from this source', 'Lowers its weight, so it ranks lower.', act(() => nudgeSource(c, 0.6))),
    row('Show more from this source', 'Raises its weight, so it ranks higher.', act(() => nudgeSource(c, 1.5))),
    topic.name ? row(`Hide topic “${topic.name}”`, 'Hides the whole topic, including its practice cards.', act(() => hideTopic(c, done))) : null,
    row('Edit source…', 'Name, keywords, weight and more, in its topic’s settings.', act(() => editSourceFor(c))),
  ]));
}

const hideCardType = (c) => {
  const id = c.generator_id;
  let removed = null;
  let at = -1;
  return hideFromFeed({
    name: c.generator,
    persist: () => data.update('generators', id, { enabled: false }),
    undo: () => data.update('generators', id, { enabled: true }),
    dropItem: () => false,
    dropCard: (d) => d.generator === String(id),
    local: () => {
      const list = feed.state?.generators;
      at = list ? list.findIndex((x) => x.id === id) : -1;
      if (at >= 0) [removed] = list.splice(at, 1);
    },
    unlocal: () => { if (removed && feed.state && !feed.state.generators.some((x) => x.id === id)) feed.state.generators.splice(Math.min(at, feed.state.generators.length), 0, removed); },
  });
};

async function nudgeCardType(c, factor) {
  try {
    const g = (await data.generators()).find((x) => x.id === c.generator_id);
    if (!g) throw new Error('That card type no longer exists.');
    const current = g.weight ?? 1;
    const next = clamp(+(current * factor).toFixed(2), 0.1, 10);
    if (next === current) return toast(factor < 1 ? 'Already at the lowest weight' : 'Already at the highest weight');
    const apply = async (w) => {
      await data.update('generators', g.id, { weight: w });
      const x = feed.state?.generators.find((y) => y.id === g.id);
      if (x) x.weight = w;
    };
    await apply(next);
    toast(`${factor < 1 ? 'Less' : 'More'} ${c.generator}`, { label: 'Undo', onClick: () => apply(current).catch(fail) });
  } catch (e) { fail(e); }
}

async function editCardTypeFor(c) {
  try {
    const g = (await data.generators()).find((x) => x.id === c.generator_id);
    if (!g) throw new Error('That card type no longer exists.');
    const target = `#/settings/topic/${g.topic_id}`;
    if (location.hash !== target) {
      const routed = new Promise((resolve) => window.addEventListener('hashchange', resolve, { once: true }));
      location.hash = target;
      await routed;
    }
    await loadMeta().catch(() => {});
    editGenerator(g);
  } catch (e) { fail(e); }
}

/** The ⋯ sheet on practice cards: hide, rebalance or edit the card type. */
async function openCardTypeSheet(c) {
  const topic = topicById(c.topic_id);
  const box = h('div', {}, h('p', { class: 'sub' }, 'Loading…'));
  openSheet(c.generator || 'This card', box);
  let exists = false;
  try { exists = (await data.generators()).some((x) => x.id === c.generator_id); } catch { /* treat as gone */ }
  const topicRow = topic.name ? sheetRow(`Hide topic “${topic.name}”`, 'Hides the whole topic, including its articles.', sheetAct(() => hideTopic(c))) : null;
  box.replaceChildren(exists
    ? h('div', { class: 'list' }, [
      sheetRow(`Hide card type “${c.generator}”`, 'Stop showing these cards. You can undo this.', sheetAct(() => hideCardType(c))),
      sheetRow('Show less of this card type', 'Lowers its weight, so it appears less often.', sheetAct(() => nudgeCardType(c, 0.6))),
      sheetRow('Show more of this card type', 'Raises its weight, so it appears more often.', sheetAct(() => nudgeCardType(c, 1.5))),
      topicRow,
      sheetRow('Edit card type…', 'Name, topic, weight and more, in its topic’s settings.', sheetAct(() => editCardTypeFor(c))),
    ])
    : h('div', { class: 'list' }, [h('p', { class: 'sub' }, 'This card type no longer exists.'), topicRow]));
}

// ---------- reader ----------
const READER_SIZES = [17, 19, 21, 24]; // px; index 1 is the default
const readCache = new Map(); // item_id -> successful `read` result, for this session
let readerToken = 0;

function leaveReader() {
  if (routeCount > 1) history.back(); else location.hash = '#/';
}

function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com') id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(shorts|embed|live)\//.test(u.pathname) ? u.pathname.split('/')[2] : null;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

const rowToCard = (r) => ({
  key: `item:${r.id}`, kind: 'article', item_id: r.id, topic_id: r.topic_id, source_id: r.source_id, title: r.title, summary: (r.summary || '').trim(),
  url: r.url, domain: r.domain, image: r.image, source: r.source_name, comments_url: r.comments_url, score: r.community_score, comments: r.comment_count,
  published_at: r.published_at, reaction: r.reaction, saved: !!r.saved_at,
});

/** Keep the (hidden) feed card's buttons in step with a reaction made in the reader. */
function syncFeedCard(c) {
  const el = feed.el?.querySelector(`.card[data-item="${c.item_id}"]`);
  if (!el) return;
  $('.act.up', el)?.setAttribute('aria-pressed', String(c.reaction === 1));
  $('.act.down', el)?.setAttribute('aria-pressed', String(c.reaction === -1));
  $('.act.save', el)?.setAttribute('aria-pressed', String(!!c.saved));
}

const openOriginal = (c, { primary = false, label = 'Open original' } = {}) => (safeUrl(c.url)
  ? h('a', { class: `btn${primary ? ' primary' : ''}`, href: c.url, target: '_blank', rel: 'noopener noreferrer' }, icon('ext'), label) : null);

/** Share an article's original link: the system share sheet where there is one, else copy the link. */
async function shareArticle(c) {
  const url = safeUrl(c.url);
  if (!url) return;
  if (navigator.share) {
    try { await navigator.share({ title: c.title || undefined, url }); return; } catch (e) {
      if (e.name === 'AbortError') return; // the person closed the share sheet
    }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
}

const readerSkeleton = () => h('div', { class: 'reader-skel', 'aria-label': 'Loading article', role: 'status' },
  [92, 100, 97, 64, 0, 100, 95, 99, 78, 0, 98, 100, 52].map((w) => (w ? h('div', { class: 'skel-line', style: { width: `${w}%` } }) : h('div', { class: 'skel-gap' }))));

function readerBar(c, page) {
  let step = clamp(Number(store.get('readerSize', 1)) || 0, 0, READER_SIZES.length - 1);
  const dec = h('button', { class: 'icon-btn size-btn', 'aria-label': 'Smaller text', onclick: () => { step--; apply(); } }, h('span', { class: 'size-a small' }, 'A−'));
  const inc = h('button', { class: 'icon-btn size-btn', 'aria-label': 'Larger text', onclick: () => { step++; apply(); } }, h('span', { class: 'size-a' }, 'A+'));
  const apply = () => {
    page.style.setProperty('--reader-fs', `${READER_SIZES[step]}px`);
    dec.disabled = step === 0;
    inc.disabled = step === READER_SIZES.length - 1;
    store.set('readerSize', step);
  };
  apply();
  const ext = c && safeUrl(c.url) ? h('a', { class: 'icon-btn', href: c.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open original in a new tab', title: 'Open original' }, icon('ext')) : null;
  const share = c && safeUrl(c.url) ? h('button', { class: 'icon-btn', 'aria-label': 'Share', title: 'Share', onclick: () => shareArticle(c) }, icon('share')) : null;
  const more = c && c.source_id != null ? h('button', { class: 'icon-btn', 'aria-label': `More options for ${c.source}`, title: 'More options', onclick: () => openSourceSheet(c, { reader: true }) }, icon('more')) : null;
  return h('div', { class: 'reader-bar' },
    h('button', { class: 'reader-back', onclick: leaveReader, 'aria-label': 'Back to the feed' }, icon('back'), h('span', {}, 'Back')),
    h('span', { class: 'spacer' }), dec, inc, share, ext, more);
}

async function renderReader(id) {
  const token = ++readerToken;
  const alive = () => token === readerToken && route().name === 'read';
  const page = h('div', { class: 'reader' });
  view.replaceChildren(page);
  scrollTo(0, 0);
  let c = articleData.get(id);
  if (!c) {
    page.replaceChildren(readerBar(null, page), h('div', { class: 'reader-article' }, readerSkeleton()));
    try {
      const row = await data.item(id);
      if (!alive()) return;
      if (!row) throw new Error("That article doesn't exist any more.");
      c = rowToCard(row);
      articleData.set(id, c);
    } catch (e) {
      if (alive()) page.replaceChildren(readerBar(null, page), h('div', { class: 'empty' }, h('h3', {}, "Couldn't open this article"), h('p', {}, e.message)));
      return;
    }
  }
  seenQueue.add(id);

  const t = topicById(c.topic_id);
  const when = c.published_at ? new Date(c.published_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const bylineEl = h('p', { class: 'reader-byline' }, when);
  const body = h('div', { class: 'reader-body' });
  const title = h('h1', { class: 'reader-title', tabindex: '-1' }, c.title);
  const btns = reactionButtons(c, {
    initialReaction: c.reaction, initialSaved: c.saved,
    onReact: async (r) => { await data.reactItem(id, r); c.reaction = r; syncFeedCard(c); },
    onSave: async (s) => { await data.saveItem(id, s); c.saved = s; syncFeedCard(c); },
  });
  page.replaceChildren(
    readerBar(c, page),
    h('article', { class: 'reader-article', style: { '--c': t.color } },
      metaRow(c, [sourceButton(c, { reader: true })]), title, bylineEl, body),
    h('div', { class: 'reader-foot' },
      h('div', { class: 'actions' }, ...btns, h('span', { class: 'spacer' }), openOriginal(c))));
  title.focus({ preventScroll: true });

  const summary = () => (c.summary ? h('p', { class: 'reader-summary' }, c.summary) : null);
  const setByline = (parts) => { bylineEl.textContent = [...parts, when].filter(Boolean).join(' · '); };
  const showFailure = (msg) => body.replaceChildren(h('div', { class: 'reader-fail', role: 'alert' },
    h('p', { class: 'reader-fail-msg' }, `Couldn't load this article in Sift: ${msg}`),
    summary(),
    h('div', { class: 'toolbar' }, openOriginal(c, { primary: true }), h('button', { class: 'btn', onclick: () => load() }, 'Try again'))));

  async function load() {
    const video = youtubeId(c.url);
    if (video) {
      body.replaceChildren(...[
        h('div', { class: 'reader-video' }, h('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${video}`, title: c.title, loading: 'lazy', allowfullscreen: true,
          allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen', referrerpolicy: 'strict-origin-when-cross-origin',
        })),
        summary(), h('div', { class: 'toolbar' }, openOriginal(c, { label: 'Watch on YouTube' }))].filter(Boolean));
      return;
    }
    body.replaceChildren(readerSkeleton());
    try {
      let res = readCache.get(id);
      if (!res) res = await data.fetcher('read', { id });
      if (!alive()) return;
      if (res?.status !== 'ok') throw new Error(res?.error || 'the page could not be read');
      const frag = sanitiseHtml(res.html || '');
      if (!frag.textContent.trim() && !frag.querySelector('img')) throw new Error('no readable text was found on the page');
      readCache.set(id, res);
      const lead = safeUrl(res.lead_image);
      const hasLead = lead && [...frag.querySelectorAll('img')].some((i) => i.getAttribute('src') === lead);
      body.replaceChildren(...[
        lead && !hasLead ? h('img', { class: 'reader-lead', src: lead, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null,
        frag].filter(Boolean));
      const mins = res.text_length ? Math.max(1, Math.round(res.text_length / 1100)) : 0;
      const by = res.byline && !/^by\s/i.test(res.byline) ? `By ${res.byline}` : res.byline;
      setByline([by, res.site_name && res.site_name !== c.source ? res.site_name : null, mins ? `${mins} min read` : null]);
    } catch (e) {
      if (alive()) showFailure(e.message || String(e));
    }
  }
  load();
}

// ---------- saved ----------
async function renderSaved() {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  try {
    const { items, cards } = await data.saved();
    const all = [
      ...items.map((r) => ({ at: r.saved_at, el: renderCard({ key: `item:${r.id}`, kind: 'article', item_id: r.id, topic_id: r.topic_id, title: r.title, summary: (r.summary || '').trim(), url: r.url, domain: r.domain, image: r.image, source: r.source_name, source_id: r.source_id, comments_url: r.comments_url, score: r.community_score, comments: r.comment_count, published_at: r.published_at, reaction: r.reaction, saved: true }) })),
      ...cards.map((c) => ({ at: c.saved_at, el: renderCard({ ...c.payload, topic_id: c.topic_id ?? c.payload.topic_id }, { savedId: c.id }) })),
    ].sort((a, b) => b.at - a.at);
    view.replaceChildren(all.length ? h('div', { class: 'feed saved-list' }, all.map((x) => x.el))
      : h('div', { class: 'empty' }, h('h3', {}, 'Nothing saved yet'), h('p', {}, 'Tap the bookmark on any card to keep it here.')));
  } catch (e) { view.replaceChildren(h('p', { class: 'status' }, e.message)); }
}

// ---------- settings ----------
const TABS = [['topics', 'Topics'], ['domains', 'Domains']];

const BULK = {}; // per-list UI state (key = list name); survives rerender() so filters and search stay put
const PAINTS = {}; // repaint functions of the lists on screen, so one list can leave selection mode when another enters it
let settingsPage = null; // which settings screen is showing; leaving it drops list filters and selection
let flushRank = null; // set by the Topics screen: saves a pending reorder straight away
function enterPage(key) {
  if (key === settingsPage) return;
  settingsPage = key;
  for (const k of Object.keys(BULK)) delete BULK[k];
  for (const k of Object.keys(PAINTS)) delete PAINTS[k];
  flushRank?.(); flushRank = null;
}

async function renderSettings(tab = 'topics') {
  enterPage(tab);
  await loadMeta().catch(() => {});
  const seg = h('div', { class: 'seg', role: 'tablist' }, TABS.map(([k, label]) => h('button', { 'aria-pressed': String(k === tab), onclick: () => { location.hash = `#/settings/${k}`; } }, label)));
  const body = h('div');
  const footer = h('div', { class: 'toolbar', style: { justifyContent: 'center', marginTop: '32px' } },
    h('button', { class: 'btn', onclick: async () => { await data.signOut(); location.reload(); } }, 'Sign out'));
  view.replaceChildren(seg, body, footer);
  try { await SETTINGS[tab](body); } catch (e) { body.replaceChildren(h('p', { class: 'status' }, e.message)); }
}
const renderSettingsRoute = () => {
  const r = route();
  return r.arg === 'topic' && Number(r.id) ? renderTopicPage(Number(r.id)) : renderSettings(r.arg === 'domains' ? 'domains' : 'topics');
};
const rerender = async () => { // keeps the scroll position; filters and search live in BULK
  feed.dirty = true;
  if (route().name !== 'settings') return;
  const y = scrollY;
  await renderSettingsRoute();
  scrollTo(0, y);
};

function toggle(checked, onchange) {
  const input = h('input', { type: 'checkbox', onclick: (e) => e.stopPropagation(), onchange: (e) => onchange(e.target.checked) });
  input.checked = !!checked;
  return h('label', { class: 'toggle', onclick: (e) => e.stopPropagation() }, input, h('span'));
}
const rowEl = ({ dot, title, desc, err, right, left, onclick, check, label, off }) => h('div', {
  class: `row${off ? ' off' : ''}`, onclick, tabindex: 0,
  role: check == null ? 'button' : 'checkbox', 'aria-checked': check == null ? null : String(check), 'aria-label': label,
  onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onclick?.(e); } },
},
left, check == null ? null : tick(check),
dot ? h('span', { class: 'dot', style: { '--c': dot } }) : null,
h('div', { class: 'grow' }, h('div', { class: 'title' }, title), desc ? h('div', { class: `desc${err ? ' err' : ''}` }, desc) : null), right);

// ---------- bulk management (search, filters, multi-select) ----------
const bulkState = (tab) => (BULK[tab] ||= { q: '', kind: '', status: 'all', select: false, sel: new Set() });
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const tick = (on) => h('span', { class: `tk${on ? ' on' : ''}`, 'aria-hidden': 'true' });

/** Single-choice list in a sheet. options: [[value, label, dotColour?]]. */
function pickerSheet(title, options, current, onPick) {
  const pick = (v) => { closeSheet(); onPick(v); };
  openSheet(title, h('div', { class: 'list', role: 'radiogroup', 'aria-label': title }, options.map(([v, label, dot]) => h('div', {
    class: 'row', role: 'radio', 'aria-checked': String(v === current), tabindex: 0, onclick: () => pick(v),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(v); } },
  }, tick(v === current), dot ? h('span', { class: 'dot', style: { '--c': dot } }) : null, h('div', { class: 'grow' }, h('div', { class: 'title' }, label))))));
}

/**
 * A settings list with a sticky toolbar (search + filters) and a selection mode with a bulk action bar. `spec.tab` is
 * its unique key (several lists can share a page); see sourceList / cardList for examples.
 */
function manage(body, spec) {
  const st = bulkState(spec.tab);
  const { items, noun } = spec;
  const statuses = [['all', 'All', () => true], ...spec.statuses];
  const filterActive = () => !!(st.q.trim() || st.kind || st.status !== 'all');

  const matches = (it) => {
    if (st.kind && it.kind !== st.kind) return false;
    if (!statuses.find(([k]) => k === st.status)[2](it)) return false;
    return st.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => spec.search(it).toLowerCase().includes(w));
  };
  const shown = () => items.filter(matches);

  // ---- toolbar ----
  const search = h('input', { type: 'search', class: 'bulk-search', placeholder: `Search ${noun[1]}`, 'aria-label': `Search ${noun[1]}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  search.value = st.q;
  search.addEventListener('input', () => { st.q = search.value; paint(); });
  const selectBtn = h('button', { class: 'btn bulk-select', onclick: () => {
    st.select = !st.select; st.sel.clear();
    if (st.select) for (const [k, other] of Object.entries(PAINTS)) if (k !== spec.tab && BULK[k]?.select) { BULK[k].select = false; BULK[k].sel.clear(); other(); } // one action bar at a time
    paint();
  } });
  const chip = (onclick) => h('button', { class: 'chip', onclick });
  const kindChip = spec.kinds ? chip(() => pickerSheet('Filter by type', [['', 'All types'], ...Object.entries(spec.kinds).map(([k, v]) => [k, v.label])], st.kind,
    (v) => { st.kind = v; paint(); })) : null;
  const statusChips = statuses.map(([k, label]) => { const b = chip(() => { st.status = k; paint(); }); b.textContent = label; b.dataset.status = k; return b; });
  const chipsRow = h('div', { class: 'bulk-chips', role: 'group', 'aria-label': 'Filters' }, kindChip, statusChips);
  const count = h('span', { class: 'bulk-count', role: 'status' });
  const selAll = h('button', { class: 'linkbtn', onclick: () => { shown().forEach((it) => st.sel.add(it.id)); paint(); } }, 'Select all shown');
  const selNone = h('button', { class: 'linkbtn', onclick: () => { st.sel.clear(); paint(); } }, 'Clear');
  const toolbar = h('div', { class: 'bulk-toolbar' }, h('div', { class: 'bulk-top' }, search, selectBtn), chipsRow,
    h('div', { class: 'bulk-countrow' }, count, h('span', { class: 'grow' }), selAll, selNone));

  // ---- action bar ----
  const barCount = h('b', {});
  const ctx = {
    noun,
    enable: (v) => ({ label: (v ? spec.on : spec.off).label, run: (ids) => ctx.apply(() => data.updateMany(spec.table, ids, { enabled: v }), `${(v ? spec.on : spec.off).done} ${plural(ids.length, noun)}`) }),
    remove: (warn) => ({
      label: 'Delete…', danger: true,
      run: (ids) => { if (confirm(warn(plural(ids.length, noun)))) return ctx.apply(() => data.removeMany(spec.table, ids), `Deleted ${plural(ids.length, noun)}`); },
    }),
    /** Run a bulk change, then leave selection mode and re-render with filters and search intact. */
    async apply(fn, msg) {
      bar.classList.add('busy');
      try { const r = await fn(); if (r?.msg) msg = r.msg; } catch (e) { bar.classList.remove('busy'); paint(); return fail(e); }
      closeSheet(); st.select = false; st.sel.clear(); toast(msg); rerender();
    },
  };
  const actionBtns = spec.actions(ctx).filter(Boolean).map((a) => {
    const b = h('button', { class: `btn${a.danger ? ' danger' : ''}`, 'aria-label': `${a.label.replace('…', '')} for selected ${noun[1]}`, onclick: () => a.run([...st.sel], b) }, a.label);
    return b;
  });
  const bar = h('div', { class: 'bulk-bar', role: 'toolbar', 'aria-label': `Actions for selected ${noun[1]}`, hidden: true },
    h('div', { class: 'bulk-bar-n', 'aria-live': 'polite' }, barCount, ' selected'), h('div', { class: 'bulk-actions' }, actionBtns));

  const list = h('div', { class: 'bulk-list' });
  body.append(toolbar, list, bar);

  function rowFor(it) {
    const r = spec.row(it);
    const common = { ...r, off: it.enabled === false };
    if (st.select) {
      const flip = () => { if (st.sel.has(it.id)) st.sel.delete(it.id); else st.sel.add(it.id); paint(true); };
      return rowEl({ ...common, check: st.sel.has(it.id), label: `Select ${r.title}`, onclick: flip });
    }
    return rowEl({
      ...common, onclick: () => spec.onOpen(it),
      right: toggle(it.enabled, async (v) => {
        const prev = it.enabled; it.enabled = v;
        try { await data.update(spec.table, it.id, { enabled: v }); feed.dirty = true; } catch (e) { it.enabled = prev; fail(e); }
        paint(true);
      }),
    });
  }
  const addRowEl = () => (!st.select && spec.addRow && !filterActive() ? rowEl({ title: h('span', { class: 'add-row' }, spec.addRow.label), onclick: spec.addRow.onclick }) : null);

  function paint(keepScroll) {
    const rows = shown();
    const ids = new Set(rows.map((x) => x.id));
    for (const id of st.sel) if (!ids.has(id)) st.sel.delete(id); // selection only ever holds what is visible under the filters

    selectBtn.textContent = st.select ? 'Done' : 'Select';
    selectBtn.classList.toggle('primary', st.select);
    selectBtn.setAttribute('aria-pressed', String(st.select));
    selectBtn.setAttribute('aria-label', st.select ? 'Leave selection mode' : `Select ${noun[1]}`);
    if (kindChip) { kindChip.textContent = `${st.kind ? spec.kinds[st.kind]?.label || st.kind : 'Type'} ▾`; kindChip.setAttribute('aria-pressed', String(!!st.kind)); }
    statusChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === st.status)));
    count.textContent = `${rows.length} of ${items.length} ${noun[1]}`;
    selAll.hidden = selNone.hidden = !st.select;
    selAll.disabled = !rows.length || st.sel.size === rows.length;
    selNone.disabled = !st.sel.size;
    bar.hidden = !st.select;
    barCount.textContent = st.sel.size;
    actionBtns.forEach((b) => { b.disabled = !st.sel.size; });

    const y = keepScroll ? scrollY : null;
    list.replaceChildren(!rows.length && items.length
      ? h('div', { class: 'empty small' }, h('p', {}, `No ${noun[1]} match.`),
        h('button', { class: 'btn', onclick: () => { Object.assign(st, { q: '', kind: '', status: 'all' }); search.value = ''; paint(); } }, 'Clear search and filters'))
      : h('div', { class: 'list' }, rows.map(rowFor), addRowEl()));
    list.classList.toggle('selecting', st.select);
    if (y != null) scrollTo(0, y);
  }
  PAINTS[spec.tab] = paint;
  paint();
}

/** Apply saved rank changes to the copies of the topics held in memory (settings and feed). */
function applyPatches(patches) {
  for (const { id, ...p } of patches) for (const list of [meta.topics, feed.state?.topics || []]) { const x = list.find((y) => y.id === id); if (x) Object.assign(x, p); }
}
/** Recompute positions and weights from the stored order and falloff, after topics were added, shown, hidden or deleted. */
const rebalanceNow = async () => applyPatches(await rebalance(data));
/** Show a hidden topic at the bottom of the rank. */
async function showTopic(t) {
  await data.update('topics', t.id, { enabled: true, position: await data.nextTopicPosition() });
  await rebalanceNow();
  feed.dirty = true;
}
const topicLink = (id) => { location.hash = `#/settings/topic/${id}`; };

const domainsUi = { q: '', status: 'all' }; // Settings → Domains search and filter, kept across rerenders
const SETTINGS = {
  /** Topics as a stack rank: order = priority, and the falloff turns rank into each topic's share of the feed. */
  async topics(body) {
    await rebalance(data); // weights always follow rank + falloff (a no-op once they do)
    const [topics, stats, gens, stored] = await Promise.all([data.topics(), data.sourceStats(), data.generators(), data.setting('falloff', DEFAULT_FALLOFF)]);
    let falloff = Number(stored) || DEFAULT_FALLOFF;
    let savedFalloff = falloff;
    const ordered = rankOrder(topics);
    let rank = ordered.filter((t) => t.enabled);
    const hidden = ordered.filter((t) => !t.enabled);
    const errored = new Set(stats.filter((s) => s.last_error).map((s) => s.topic_id)); // only article topics have sources
    const desc = (t) => (t.kind === 'cards'
      ? `Cards · ${plural(gens.filter((g) => g.topic_id === t.id).length, ['card type', 'card types'])}`
      : `Articles · ${plural(stats.filter((s) => s.topic_id === t.id).length, ['source', 'sources'])}`);

    body.append(h('p', { class: 'intro' }, topics.length
      ? 'Your topics in order of priority: the higher a topic sits, the more of your feed it gets. Article topics are for reading, card topics for practice. Drag the handle or use the arrows to reorder. Tap a topic to manage its sources or card types.'
      : 'Topics are the channels in your feed. Start from a starter pack or add your own.'));

    if (rank.length) {
      const status = h('span', { class: 'sub rank-status', role: 'status' });
      const spans = new Map(rank.map((t) => [t.id, h('span', { style: { '--c': t.color } })]));
      const stack = h('div', { class: 'stack', role: 'img', 'aria-label': 'Share of feed by topic' });
      const list = h('div', { class: 'list rank-list' });
      const pcts = new Map();
      let lastDrag = 0;

      const paintShares = (ids) => {
        const order = ids.map((id) => rank.find((t) => t.id === id));
        const shares = sharesFromWeights(rankWeights(order.length, falloff));
        const pct = toPercents(shares);
        order.forEach((t, i) => {
          pcts.get(t.id).textContent = `${pct[i]}%`;
          spans.get(t.id).style.flexGrow = String(shares[i]);
          spans.get(t.id).title = `${t.name} ${pct[i]}%`;
        });
        stack.append(...order.map((t) => spans.get(t.id)));
      };

      // Saving: rank → position, falloff → app_settings, both → weight. Debounced; only changed rows are written.
      let timer = null;
      let chain = Promise.resolve();
      const persist = () => {
        clearTimeout(timer); timer = null;
        chain = chain.then(async () => {
          try {
            if (falloff !== savedFalloff) { await data.setSetting('falloff', falloff); savedFalloff = falloff; }
            const all = [...rank, ...hidden];
            const patches = await saveRank(data, all, falloff);
            for (const { id, ...p } of patches) Object.assign(all.find((t) => t.id === id), p);
            applyPatches(patches);
            feed.dirty = true;
            status.textContent = 'Saved';
          } catch (e) { status.textContent = 'Not saved'; fail(e); }
        });
        return chain;
      };
      const scheduleSave = () => { status.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(persist, 400); };
      flushRank = () => (timer ? persist() : chain);

      const commit = (next) => { rank = next; draw(); scheduleSave(); };
      const move = (t, dir, btn) => {
        const i = rank.indexOf(t);
        const next = rank.slice();
        next.splice(i + dir, 0, ...next.splice(i, 1));
        commit(next);
        const row = list.querySelector(`[data-id="${t.id}"]`);
        const target = row?.querySelector(`.rank-${btn}`);
        (target?.disabled ? row.querySelector(`.rank-${btn === 'up' ? 'down' : 'up'}`) : target)?.focus();
      };

      // Dragging: pointer events from the handle, so mouse, touch and pen all work. The row is moved in the DOM
      // under the pointer and the new order is read back from it on release.
      const startDrag = (e, row) => {
        if (e.button > 0) return;
        e.preventDefault();
        row.classList.add('dragging');
        const onMove = (ev) => {
          if (ev.clientY < 90) scrollBy(0, -12); else if (ev.clientY > innerHeight - 120) scrollBy(0, 12);
          const next = [...list.children].filter((r) => r !== row).find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
          if (next) { if (row.nextSibling !== next) list.insertBefore(row, next); } else if (list.lastChild !== row) list.append(row);
          paintShares([...list.children].map((r) => Number(r.dataset.id)));
        };
        const onEnd = () => {
          for (const [type, fn] of [['pointermove', onMove], ['pointerup', onEnd], ['pointercancel', onEnd]]) removeEventListener(type, fn);
          row.classList.remove('dragging');
          lastDrag = Date.now(); // the release can also arrive as a click on the row
          const ids = [...list.children].map((r) => Number(r.dataset.id));
          const before = rank.map((t) => t.id).join();
          if (ids.join() === before) return;
          commit(ids.map((id) => rank.find((t) => t.id === id)));
          list.querySelector(`[data-id="${row.dataset.id}"] .rank-handle`)?.focus();
        };
        for (const [type, fn] of [['pointermove', onMove], ['pointerup', onEnd], ['pointercancel', onEnd]]) addEventListener(type, fn); // on window: moving the row in the DOM drops pointer capture
      };

      const rowFor = (t, i) => {
        const handle = h('button', { class: 'rank-handle', type: 'button', 'aria-label': `Drag to reorder ${t.name}`, title: 'Drag to reorder', onclick: (e) => e.stopPropagation(), onpointerdown: (e) => startDrag(e, row) }, icon('grip'));
        const step = (dir, name, ico) => h('button', { class: `act rank-${name}`, type: 'button', 'aria-label': `Move ${t.name} ${name}`, title: `Move ${name}`, disabled: dir < 0 ? i === 0 : i === rank.length - 1, onclick: (e) => { e.stopPropagation(); move(t, dir, name); } }, icon(ico));
        const pct = h('span', { class: 'rank-pct' });
        pcts.set(t.id, pct);
        const row = rowEl({
          left: handle, dot: t.color, desc: desc(t), right: [pct, step(-1, 'up', 'arrowup'), step(1, 'down', 'arrowdown')],
          title: [t.name, errored.has(t.id) ? h('span', { class: 'warn-badge', role: 'img', 'aria-label': 'A source has an error', title: 'A source has an error' }, '⚠') : null],
          onclick: (e) => { if (!e.target.closest('.rank-handle, .act') && Date.now() - lastDrag > 300) topicLink(t.id); },
        });
        row.dataset.id = t.id;
        return row;
      };
      const draw = () => { pcts.clear(); list.replaceChildren(...rank.map(rowFor)); paintShares(rank.map((t) => t.id)); };

      const presets = h('div', { class: 'seg falloff', role: 'group', 'aria-label': 'Falloff' }, FALLOFFS.map(([k, label, r]) => h('button', {
        'data-falloff': k, onclick: () => { falloff = r; markPresets(); paintShares(rank.map((x) => x.id)); scheduleSave(); },
      }, label)));
      const markPresets = () => presets.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(Math.abs(FALLOFFS[i][2] - falloff) < 1e-6)));

      body.append(
        h('div', { class: 'section-h' }, 'Falloff', h('span', { class: 'grow' }), status),
        presets,
        h('p', { class: 'help' }, 'How quickly the share drops down the list. Even gives every topic the same share; Steep gives the top few most of the feed.'),
        stack, list);
      markPresets();
      draw();
    }

    if (hidden.length) {
      body.append(h('div', { class: 'section-h' }, 'Hidden'), h('div', { class: 'list hidden-list' }, hidden.map((t) => rowEl({
        dot: t.color, title: t.name, desc: `Hidden · ${desc(t)}`, off: true, onclick: () => topicLink(t.id),
        right: h('button', { class: 'btn', 'aria-label': `Show ${t.name}`, onclick: async (e) => { e.stopPropagation(); try { await flushRank?.(); await showTopic(t); rerender(); } catch (err) { fail(err); } } }, 'Show'),
      }))));
    }

    const fetchBtn = h('button', {
      class: 'btn',
      onclick: async () => {
        fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching…';
        try {
          const r = await data.fetcher('fetch_all');
          const added = Object.values(r).reduce((s, x) => s + (x.added || 0), 0);
          toast(`${added} new article${added === 1 ? '' : 's'}`); rerender();
        } catch (e) { toast(e.message); fetchBtn.disabled = false; fetchBtn.textContent = 'Fetch all now'; }
      },
    }, 'Fetch all now');
    body.append(
      h('div', { class: 'list', style: { marginTop: '18px' } },
        rowEl({ title: h('span', { class: 'add-row' }, '+ Add topic'), onclick: () => editTopic(null) }),
        rowEl({ title: h('span', { class: 'add-row' }, '+ Add starter pack'), desc: 'Ready-made article and practice topics', onclick: openPackPicker })),
      h('div', { class: 'toolbar' }, fetchBtn));
  },
  async domains(body) {
    const domains = await data.domainStats();
    const ui = domainsUi;
    body.append(h('p', { class: 'intro' }, 'Sites your articles link to. Mute a domain to stop seeing it; its articles are kept, just hidden.'));
    const search = h('input', { type: 'search', class: 'bulk-search', placeholder: 'Search domains', 'aria-label': 'Search domains', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    search.value = ui.q;
    const chips = [['all', 'All'], ['muted', 'Muted']].map(([k, label]) => { const b = h('button', { class: 'chip', onclick: () => { ui.status = k; draw(); } }, label); b.dataset.status = k; return b; });
    const count = h('span', { class: 'bulk-count', role: 'status' });
    const list = h('div', { class: 'bulk-list' });
    search.addEventListener('input', () => { ui.q = search.value; draw(); });
    body.append(h('div', { class: 'bulk-toolbar' }, h('div', { class: 'bulk-top' }, search), h('div', { class: 'bulk-chips', role: 'group', 'aria-label': 'Filters' }, chips),
      h('div', { class: 'bulk-countrow' }, count)), list);
    const LIMIT = 200;
    function draw() {
      const q = ui.q.trim().toLowerCase();
      const rows = domains.filter((d) => (ui.status === 'all' || d.muted) && (!q || d.domain.includes(q)));
      chips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === ui.status)));
      count.textContent = `${rows.length} of ${domains.length} domains`;
      list.replaceChildren(rows.length ? h('div', { class: 'list' }, rows.slice(0, LIMIT).map((d) => h('div', { class: `row row-static${d.muted ? ' off' : ''}`, 'data-domain': d.domain },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, d.domain),
          h('div', { class: 'desc' }, `${d.unread} unread · ${d.total} total · 👍${d.up} 👎${d.down}${d.muted ? ' · muted' : ''}`)),
        h('button', {
          class: 'btn', 'aria-label': `${d.muted ? 'Unmute' : 'Mute'} ${d.domain}`,
          onclick: async () => {
            try { await (d.muted ? data.unmuteDomain(d.domain) : data.muteDomain(d.domain)); d.muted = !d.muted; feed.dirty = true; draw(); } catch (e) { fail(e); }
          },
        }, d.muted ? 'Unmute' : 'Mute'))).concat(rows.length > LIMIT ? [h('div', { class: 'row row-static' }, h('div', { class: 'desc' }, `Showing the first ${LIMIT}. Search to narrow the list.`))] : []))
        : h('div', { class: 'empty small' }, h('p', {}, domains.length ? 'No domains match.' : 'No domains yet. They appear once articles have been fetched.')));
    }
    draw();
  },
};

// ---------- topic page: one topic's settings, sources and card types ----------
function sourceList(t, sources) {
  return {
    tab: `sources:${t.id}`, noun: ['source', 'sources'], items: sources, kinds: meta.source_kinds,
    search: (s) => `${s.name} ${s.config?.url || ''} ${s.include || ''}`,
    statuses: [
      ['on', 'On', (s) => s.enabled], ['off', 'Off', (s) => !s.enabled], ['errors', 'Errors', (s) => !!s.last_error],
      ['read', 'No unread', (s) => !s.unseen_count], ['never', 'Never fetched', (s) => !s.last_fetched],
    ],
    row: (s) => ({
      title: s.name,
      desc: s.last_error ? `Error: ${s.last_error}` : `${meta.source_kinds[s.kind]?.label || s.kind} · ${s.unseen_count} unread${s.last_fetched ? ` · fetched ${ago(s.last_fetched)} ago` : ' · not fetched yet'}`,
      err: !!s.last_error,
    }),
    table: 'sources', onOpen: editSource,
    addRow: { label: '+ Add source', onclick: () => editSource({ topic_id: t.id, kind: 'rss', config: {}, weight: 1, enabled: true }) },
    on: { label: 'Turn on', done: 'Turned on' }, off: { label: 'Turn off', done: 'Turned off' },
    actions: (ctx) => [
      ctx.enable(true), ctx.enable(false),
      {
        label: 'Move to topic…', run: (ids) => pickerSheet(`Move ${plural(ids.length, ctx.noun)} to`, meta.topics.filter((x) => x.kind === 'articles').map((x) => [x.id, x.name, x.color]), null,
          (topicId) => ctx.apply(() => data.updateMany('sources', ids, { topic_id: topicId }), `Moved ${plural(ids.length, ctx.noun)} to ${topicById(topicId).name}`)),
      },
      {
        label: 'Weight…', run: (ids) => {
          const input = h('input', { type: 'number', step: 0.1, min: 0, inputmode: 'decimal', value: 1 });
          openSheet('Set weight', h('div', {},
            field(`Weight for ${plural(ids.length, ctx.noun)}`, input, '1 = normal. Higher ranks these sources above others.'),
            h('button', { class: 'btn primary', onclick: () => { const w = Number(input.value); return w > 0 ? ctx.apply(() => data.updateMany('sources', ids, { weight: w }), `Set weight to ${w} on ${plural(ids.length, ctx.noun)}`) : toast('Enter a weight above 0'); } }, 'Apply')));
          input.focus(); input.select();
        },
      },
      {
        label: 'Fetch now', run: (ids, btn) => ctx.apply(async () => {
          let added = 0, failed = 0, done = 0, next = 0;
          const worker = async () => {
            while (next < ids.length) {
              const id = ids[next++];
              try { const r = await data.fetcher('fetch_source', { id }); if (r.error) failed++; else added += r.added || 0; } catch { failed++; }
              btn.textContent = `Fetching ${++done}/${ids.length}…`;
            }
          };
          await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
          return { msg: `${added} new article${added === 1 ? '' : 's'} from ${plural(ids.length, ctx.noun)}${failed ? ` · ${failed} failed` : ''}` };
        }),
      },
      ctx.remove((n) => `Delete ${n} and all their articles (including saved ones)?`),
    ],
  };
}

function cardList(t, gens) {
  return {
    tab: `cards:${t.id}`, noun: ['card type', 'card types'], items: gens, kinds: meta.generator_kinds,
    search: (g) => `${g.name} ${meta.generator_kinds[g.kind]?.label || g.kind}`,
    statuses: [['on', 'On', (g) => g.enabled], ['off', 'Off', (g) => !g.enabled]],
    row: (g) => ({ title: g.name, desc: `${meta.generator_kinds[g.kind]?.label || g.kind} · weight ${(+g.weight).toFixed(1)}` }),
    table: 'generators', onOpen: editGenerator,
    addRow: { label: '+ Add card type', onclick: () => editGenerator({ topic_id: t.id, kind: 'prompts', config: {}, weight: 1, enabled: true }) },
    on: { label: 'Turn on', done: 'Turned on' }, off: { label: 'Turn off', done: 'Turned off' },
    actions: (ctx) => [ctx.enable(true), ctx.enable(false), ctx.remove((n) => `Delete ${n}?`)],
  };
}

async function renderTopicPage(id) {
  enterPage(`topic:${id}`);
  await loadMeta().catch(() => {});
  const t = meta.topics.find((x) => x.id === id);
  const head = h('div', { class: 'page-head' },
    h('button', { class: 'reader-back', onclick: () => { location.hash = '#/settings/topics'; }, 'aria-label': 'Back to topics' }, icon('back'), h('span', {}, 'Topics')),
    t ? h('span', { class: 'dot', style: { '--c': t.color } }) : null, h('h2', { class: 'page-title' }, t ? t.name : 'Topic'));
  const body = h('div');
  view.replaceChildren(head, body);
  if (!t) { body.append(h('div', { class: 'empty small' }, h('p', {}, 'That topic no longer exists.'))); return; }
  try {
    const [stats, gens] = await Promise.all([data.sourceStats(), data.generators()]);
    const visible = rankOrder(meta.topics).filter((x) => x.enabled);
    const total = visible.reduce((s, x) => s + x.weight, 0) || 1;
    const where = t.enabled ? `#${visible.indexOf(t) + 1} of ${visible.length} · ${Math.round((t.weight / total) * 100)}% of feed` : 'Hidden · no share of the feed';
    const flip = async () => {
      try {
        if (t.enabled) { await data.update('topics', t.id, { enabled: false }); await rebalanceNow(); toast(`Hidden ${t.name}`); } else { await showTopic(t); toast(`Showing ${t.name}`); }
        rerender();
      } catch (e) { fail(e); }
    };
    body.append(
      h('div', { class: 'section-h' }, 'Topic settings'),
      h('div', { class: 'list' }, rowEl({
        dot: t.color, title: t.name, desc: `${t.kind === 'cards' ? 'Practice cards' : 'Articles'} · ${where}`,
        onclick: () => editTopic(t), right: h('button', { class: 'btn', 'aria-label': `Edit ${t.name}`, onclick: (e) => { e.stopPropagation(); editTopic(t); } }, 'Edit'),
      })),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn topic-flip', onclick: flip }, t.enabled ? 'Hide topic' : 'Show topic'),
        h('button', { class: 'btn danger', onclick: () => deleteRow('topics', t, `"${t.name}" and all its sources and card types`, async () => { await rebalanceNow(); location.hash = '#/settings/topics'; }) }, 'Delete topic')),
      h('div', { class: 'section-h' }, t.kind === 'cards' ? 'Card types' : 'Sources'),
      h('p', { class: 'intro' }, t.kind === 'cards'
        ? 'Practice cards made from code and your own decks and lists. This topic only ever shows cards. Decks are created and edited from a Flashcards or Notes card type.'
        : 'Where this topic’s articles come from. This topic only ever shows articles. Strict sources and score thresholds keep the feed useful.'));
    const box = h('div');
    body.append(box);
    if (t.kind === 'cards') manage(box, cardList(t, gens.filter((g) => g.topic_id === id)));
    else manage(box, sourceList(t, stats.filter((s) => s.topic_id === id)));
  } catch (e) { body.replaceChildren(h('p', { class: 'status' }, e.message)); }
}

// ---------- sheet + forms ----------
function openSheet(title, content) {
  const sheet = $('#sheet');
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(content);
  $('#sheet-body').scrollTop = 0;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#sheet').hidden) closeSheet();
  else if (route().name === 'read') leaveReader();
});

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label), input, help ? h('small', {}, help) : null);
}
/** A topic dropdown limited to one kind: sources go in article topics, card types in card topics. */
function topicSelect(value, kind) {
  const sel = h('select', {}, meta.topics.filter((t) => t.kind === kind || t.id === value).map((t) => h('option', { value: t.id }, t.name)));
  sel.value = value;
  return sel;
}

/** Build inputs from a kind's field schema. Returns { el, read() }. */
/** `opts.onDeck(deck | null)` opens the deck editor from a deck field (the form is rebuilt afterwards by the caller). */
function schemaFields(fields, config, opts = {}) {
  const getters = {};
  const els = fields.map((f) => {
    const v = config[f.key] ?? f.default;
    let input;
    switch (f.type) {
      case 'textarea': input = h('textarea', { rows: 8 }); input.value = v ?? ''; getters[f.key] = () => input.value; break;
      case 'number': input = h('input', { type: 'number', step: 'any', inputmode: 'decimal' }); input.value = v ?? ''; getters[f.key] = () => Number(input.value); break;
      case 'checkbox': {
        input = h('input', { type: 'checkbox' }); input.checked = !!v; getters[f.key] = () => input.checked;
        return h('label', { class: 'field inline-check' }, input, f.label);
      }
      case 'select': input = h('select', {}, f.options.map((o) => h('option', { value: o }, o.replace(/_/g, ' ')))); input.value = v ?? f.options[0]; getters[f.key] = () => input.value; break;
      case 'deck': {
        const sel = h('select', {}, h('option', { value: '' }, '— choose a deck —'), meta.decks.map((d) => h('option', { value: d.id }, `${d.name} (${d.cards})`)));
        sel.value = v ?? '';
        if (sel.value !== String(v ?? '')) sel.value = ''; // the deck no longer exists
        getters[f.key] = () => Number(sel.value) || null;
        const edit = h('button', { type: 'button', class: 'btn deck-edit', disabled: !sel.value, onclick: () => opts.onDeck?.(meta.decks.find((d) => d.id === Number(sel.value)) || null) }, 'Edit deck');
        sel.onchange = () => { edit.disabled = !sel.value; };
        input = h('div', { class: 'deck-pick' }, sel, h('div', { class: 'deck-btns' }, h('button', { type: 'button', class: 'btn deck-new', onclick: () => opts.onDeck?.(null) }, '+ New deck'), edit));
        break;
      }
      case 'multiselect': {
        const chosen = new Set(String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean));
        const boxes = f.options.map((o) => { const cb = h('input', { type: 'checkbox', value: o }); cb.checked = chosen.has(o); return [o, cb]; });
        input = h('div', { class: 'checks' }, boxes.map(([o, cb]) => h('label', {}, cb, o.replace(/_/g, ' '))));
        getters[f.key] = () => boxes.filter(([, cb]) => cb.checked).map(([o]) => o).join(',');
        return h('div', { class: 'field' }, h('span', {}, f.label), input);
      }
      default: input = h('input', { type: 'text', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }); input.value = v ?? ''; getters[f.key] = () => input.value.trim();
    }
    return field(f.label, input, f.help);
  });
  return { el: h('div', {}, els), read: () => Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()])) };
}

async function saveRow(table, row, values) {
  try {
    if (row?.id) await data.update(table, row.id, values);
    else {
      if (table === 'topics') values.position = await data.nextTopicPosition();
      const row = await data.insert(table, values);
      if (table === 'topics') await rebalanceNow();
      if (table === 'sources') {
        // Fetch a new source straight away instead of waiting for the hourly job.
        data.fetcher('fetch_source', { id: row.id })
          .then((r) => { toast(r.error ? `Fetch failed: ${r.error}` : `${r.added} new from ${row.name}`); feed.dirty = true; rerender(); })
          .catch(fail);
      }
    }
    closeSheet(); toast('Saved'); rerender();
  } catch (e) { toast(e.message); }
}
/** Confirm, delete, then `after()` (default: re-render the settings page). */
async function deleteRow(table, row, what, after = rerender) {
  if (!confirm(`Delete ${what}?`)) return;
  try { await data.remove(table, row.id); } catch (e) { return fail(e); }
  closeSheet(); toast('Deleted');
  try { await after(); } catch (e) { fail(e); }
}

async function openPackPicker() {
  const body = h('div', {}, h('p', { class: 'intro' }, 'Loading…'));
  openSheet('Starter packs', body);
  try {
    const files = await (await fetch('starters/index.json', { cache: 'no-cache' })).json();
    const packs = await Promise.all(files.map(async (f) => (await fetch(`starters/${f}`, { cache: 'no-cache' })).json()));
    const have = new Set(meta.topics.map((t) => t.name));
    body.replaceChildren(
      h('p', { class: 'intro' }, 'Each pack adds topics with sources and card types. Everything can be edited or deleted afterwards. Packs only add what is missing, so adding one twice is harmless.'),
      h('div', { class: 'list' }, packs.map((pack) => {
        const done = pack.topics.every((t) => have.has(t.name));
        const sources = pack.topics.reduce((n, t) => n + (t.sources?.length || 0), 0);
        const cards = pack.topics.reduce((n, t) => n + (t.cards?.length || 0), 0);
        const counts = [sources ? `${sources} sources` : null, cards ? `${cards} card types` : null].filter(Boolean).join(', ');
        const btn = h('button', { class: 'btn', disabled: done, onclick: async () => {
          btn.disabled = true; btn.textContent = 'Adding…';
          try {
            const r = await installPack(data, pack);
            toast(`Added ${r.topics} topic${r.topics === 1 ? '' : 's'}, ${r.sources} sources`);
            // Pull in the first articles now rather than waiting for the hourly fetch.
            data.fetcher('fetch_all').then(() => { feed.dirty = true; }).catch(() => {});
            btn.textContent = 'Added';
            rerender(); // the sheet stays open so several packs can be added in one go
          } catch (e) { fail(e); btn.disabled = false; btn.textContent = 'Add'; }
        } }, done ? 'Added' : 'Add');
        return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, pack.name),
          h('div', { class: 'desc wrap' }, `${pack.description || ''} (${counts})`)), btn);
      })));
  } catch (e) { body.replaceChildren(h('p', { class: 'intro' }, `Couldn't load starter packs: ${e.message}`)); }
}

function editTopic(t) {
  // A new topic joins the bottom of the rank; reorder it on the Topics screen. Its kind is fixed once created.
  t ||= { name: '', color: '#64748b', kind: 'articles', enabled: true };
  const name = h('input', { type: 'text', value: t.name, placeholder: 'e.g. Chess' });
  const color = h('input', { type: 'color', value: t.color });
  const KINDS = [['articles', 'Articles', 'Reading from sources you choose: RSS feeds, YouTube, Hacker News.'], ['cards', 'Practice cards', 'Flashcards, quizzes and prompts made from your own decks and lists.']];
  let kind = t.kind;
  const help = h('small', {}, KINDS.find((k) => k[0] === kind)[2]);
  const kindField = t.id
    ? field('Kind', h('div', { class: 'kind-fixed' }, KINDS.find((k) => k[0] === kind)[1]), 'A topic keeps its kind. To mix reading and practice, make two topics.')
    : h('div', { class: 'field' }, h('span', {}, 'Kind'),
      h('div', { class: 'seg inline', role: 'radiogroup', 'aria-label': 'Kind' }, KINDS.map(([k, label]) => h('button', {
        type: 'button', role: 'radio', 'data-kind': k, 'aria-checked': String(k === kind), 'aria-pressed': String(k === kind),
        onclick: (e) => {
          kind = k; help.textContent = KINDS.find((x) => x[0] === k)[2];
          e.currentTarget.parentNode.querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.kind === k)); b.setAttribute('aria-checked', String(b.dataset.kind === k)); });
        },
      }, label))), help);
  openSheet(t.id ? 'Edit topic' : 'New topic', h('div', {},
    field('Name', name), kindField, field('Colour', color),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => name.value.trim() ? saveRow('topics', t, { name: name.value.trim(), color: color.value, enabled: t.enabled, ...(t.id ? {} : { kind }) }) : toast('Name is required') }, 'Save'))));
}

function editSource(s) {
  const name = h('input', { type: 'text', value: s.name || '', placeholder: 'e.g. r/learnpython' });
  const topic = topicSelect(s.topic_id, 'articles');
  const kind = h('select', {}, Object.entries(meta.source_kinds).map(([k, v]) => h('option', { value: k }, v.label)));
  kind.value = s.kind;
  const include = h('input', { type: 'text', value: s.include || '', placeholder: 'e.g. LLM, transformer, Claude' });
  const exclude = h('input', { type: 'text', value: s.exclude || '', placeholder: 'e.g. hiring, crypto' });
  const weight = h('input', { type: 'number', step: 0.1, value: s.weight ?? 1, inputmode: 'decimal' });
  const kindBox = h('div');
  const preview = h('div', { class: 'preview' });
  let form;
  const renderKind = () => {
    const k = meta.source_kinds[kind.value];
    form = schemaFields(k.fields, kind.value === s.kind ? s.config || {} : {});
    kindBox.replaceChildren(h('div', { class: 'kind-desc' }, k.description), form.el);
  };
  kind.onchange = renderKind;
  renderKind();
  const values = () => ({ name: name.value.trim() || defaultName(kind.value, form.read()), topic_id: +topic.value, kind: kind.value, config: form.read(), include: include.value, exclude: exclude.value, weight: +weight.value || 1, enabled: s.enabled ?? true });
  const previewBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      previewBtn.disabled = true; preview.replaceChildren(h('div', { class: 'sub' }, 'Fetching…'));
      try {
        const items = await data.fetcher('preview', { source: values() });
        preview.replaceChildren(h('div', { class: 'sub' }, `${items.length} item${items.length === 1 ? ' passes' : 's pass'} your filters${items.length === 15 ? ' (showing 15)' : ''}:`),
          ...items.map((i) => h('div', { class: 'pv' }, h('b', {}, i.title), h('div', {}, [i.community_score != null ? `▲ ${i.community_score}` : null, i.published ? ago(i.published) : null].filter(Boolean).join(' · ')))));
      } catch (e) { preview.replaceChildren(h('div', { class: 'sub', style: { color: 'var(--bad)' } }, e.message)); }
      previewBtn.disabled = false;
    },
  }, 'Preview');
  openSheet(s.id ? 'Edit source' : 'New source', h('div', {},
    field('Type', kind), kindBox, field('Name', name), field('Topic', topic),
    field('Only include if it mentions', include, 'Comma-separated keywords. Leave empty to include everything.'),
    field('Skip if it mentions', exclude, 'Comma-separated keywords.'),
    field('Weight', weight, '1 = normal. Higher ranks this source above others.'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => saveRow('sources', s, values()) }, 'Save'),
      previewBtn,
      s.id ? h('button', { class: 'btn', onclick: async () => { try { const r = await data.fetcher('fetch_source', { id: s.id }); toast(r.error ? r.error : `${r.added} new`); feed.dirty = true; } catch (e) { fail(e); } } }, 'Fetch now') : null,
      s.id ? h('button', { class: 'btn danger', onclick: () => deleteRow('sources', s, `"${s.name}"`) }, 'Delete') : null),
    preview));
}
function defaultName(kind, cfg) {
  if (kind === 'hn') return 'Hacker News';
  try { return new URL(cfg.url).hostname.replace(/^www\./, ''); } catch { return 'Feed'; }
}

function editGenerator(g) {
  // Editing a deck replaces the sheet, so the form is snapshotted and reopened with the chosen deck afterwards.
  const reopen = (deckId) => editGenerator({ ...g, topic_id: +topic.value, kind: kind.value, name: name.value, weight: +weight.value || 1, config: { ...form.read(), deck_id: deckId } });
  const onDeck = (d) => editDeck(d, { onDone: reopen, onBack: () => reopen(form.read().deck_id) });
  const topic = topicSelect(g.topic_id, 'cards');
  const kind = h('select', {}, Object.entries(meta.generator_kinds).map(([k, v]) => h('option', { value: k }, v.label)));
  kind.value = g.kind;
  const name = h('input', { type: 'text', value: g.name || '' });
  const weight = h('input', { type: 'number', step: 0.1, value: g.weight ?? 1, inputmode: 'decimal' });
  const kindBox = h('div');
  const preview = h('div', { class: 'preview' });
  let form;
  const renderKind = () => {
    const k = meta.generator_kinds[kind.value];
    form = schemaFields(k.fields, kind.value === g.kind ? g.config || {} : {}, { onDeck });
    kindBox.replaceChildren(h('div', { class: 'kind-desc' }, k.description), form.el);
    if (!name.value || !g.id) name.placeholder = k.label;
  };
  kind.onchange = renderKind;
  renderKind();
  const values = () => ({ name: name.value.trim() || meta.generator_kinds[kind.value].label, topic_id: +topic.value, kind: kind.value, config: form.read(), weight: +weight.value || 1, enabled: g.enabled ?? true });
  openSheet(g.id ? 'Edit card type' : 'New card type', h('div', {},
    field('Kind', kind), kindBox, field('Name', name), field('Topic', topic),
    field('Weight', weight, 'How often this appears relative to other card types in the topic. 👍/👎 on cards adjusts this.'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => saveRow('generators', g, values()) }, 'Save'),
      g.id ? h('button', {
        class: 'btn',
        onclick: async () => {
          const state = await data.feedState();
          const card = generateOne(state, g);
          const c = card && { ...card, topic_id: g.topic_id, generator_id: g.id, generator: g.name };
          preview.replaceChildren(c ? renderCard(c) : h('div', { class: 'sub' }, 'Nothing to show right now (e.g. no cards due and the daily new-card limit was reached).'));
        },
      }, 'Preview (saved settings)') : null,
      g.id ? h('button', { class: 'btn danger', onclick: () => deleteRow('generators', g, `"${g.name}"`) }, 'Delete') : null),
    preview));
}

/** `opts` is set when opened from a card type editor: onDone(deckId | null) after a save or delete, onBack() to return unchanged. */
async function editDeck(d, opts = {}) {
  const name = h('input', { type: 'text', value: d?.name || '', placeholder: 'e.g. Russian verbs of motion' });
  const lang = h('input', { type: 'text', value: d?.lang || '', placeholder: 'e.g. ru', autocapitalize: 'off', spellcheck: 'false', maxlength: 35 });
  const csv = h('textarea', { rows: 8, placeholder: 'front, back, note\nидти́, to go (on foot), Я иду́ домо́й.\n…' });
  const list = h('div', { class: 'list deck-cards' });
  const content = h('div', {}, field('Name', name),
    field('Language of the fronts', lang, 'A language code such as ru, de or ja, so card text is shown and read aloud in that language. Leave empty if it varies.'),
    field('Add cards', csv, 'One card per line: front, back, optional note. Comma or tab separated; quote fields containing commas. Paste from a spreadsheet works.'),
    h('div', { class: 'toolbar' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!name.value.trim()) return toast('Name is required');
          const code = lang.value.trim();
          if (code && !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(code)) return toast('Language should be a code such as ru or pt-BR');
          const row = { name: name.value.trim(), lang: code };
          try {
            let id = d?.id;
            if (id) await data.update('decks', id, row);
            else id = (await data.insert('decks', row)).id;
            if (csv.value.trim()) toast(`Added ${await data.importCards(id, csv.value)} cards`); else toast('Saved');
            if (opts.onDone) { await loadMeta(); opts.onDone(id); } else { closeSheet(); rerender(); }
          } catch (e) { toast(e.message); }
        },
      }, 'Save'),
      opts.onBack ? h('button', { class: 'btn', onclick: opts.onBack }, 'Back') : null,
      d ? h('button', {
        class: 'btn danger',
        onclick: opts.onDone ? async () => {
          if (!confirm(`Delete deck "${d.name}" and its ${d.cards} cards?`)) return;
          try { await data.remove('decks', d.id); await loadMeta(); } catch (e) { return fail(e); }
          toast('Deleted'); opts.onDone(null);
        } : () => deleteRow('decks', d, `deck "${d.name}" and its ${d.cards} cards`),
      }, 'Delete deck') : null),
    d ? h('div', { class: 'section-h' }, 'Cards') : null, d ? list : null);
  openSheet(d ? 'Edit deck' : 'New deck', content);
  if (d) {
    const cards = await data.deckCards(d.id);
    list.replaceChildren(...cards.slice(0, 500).map((c) => h('div', { class: 'row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, `${c.front} — ${c.back}`),
        h('div', { class: 'desc' }, c.due ? `next ${c.due <= Date.now() ? 'now' : `in ${ago(2 * Date.now() - c.due)}`}` : 'new')),
      h('button', { class: 'act', 'aria-label': 'Delete card', onclick: async (e) => { try { await data.remove('cards', c.id); e.target.closest('.row').remove(); } catch (ex) { fail(ex); } } }, '✕'))));
    if (!cards.length) list.append(h('div', { class: 'row' }, h('div', { class: 'desc' }, 'No cards yet.')));
  }
}

// ---------- routing ----------
function route() {
  const [, name = '', arg, id] = location.hash.replace(/^#/, '').split('/');
  return { name: name || 'feed', arg, id };
}
let routeCount = 0;
function onRoute() {
  const r = route();
  routeCount++;
  if (r.name !== 'feed' && feed.el?.isConnected) feed.scrollY = scrollY;
  const reading = r.name === 'read';
  document.body.classList.toggle('reading', reading);
  $('.topbar').hidden = reading;
  $('.tabbar').hidden = reading;
  document.querySelectorAll('.tabbar a').forEach((a) => (a.dataset.tab === r.name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  renderChips();
  closeSheet();
  if (reading) renderReader(Number(r.arg));
  else if (r.name === 'saved') renderSaved();
  else if (r.name === 'settings') {
    // Balance, Sources, Cards and Decks now live under Topics; anything unknown lands there too.
    const known = r.arg === 'domains' || r.arg === 'topics' || (r.arg === 'topic' && Number(r.id));
    if (!known) history.replaceState(null, '', '#/settings/topics');
    renderSettingsRoute();
  }
  else renderFeed();
}
window.addEventListener('hashchange', onRoute);
$('#refresh').onclick = () => { flushSeen(); if (route().name !== 'feed') location.hash = '#/'; else { feed.el = null; renderFeed(); } };

(async function init() {
  if (!data) return showSetup();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
  if (!(await Promise.race([data.session().catch(() => null), timeout]))) return showLogin();
  try { await loadMeta(); } catch (e) { view.replaceChildren(h('p', { class: 'status' }, `Couldn't connect: ${e.message}`)); return; }
  onRoute();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
