// Sift client — vanilla JS, no build step. Talks directly to Supabase.
import { createData } from './lib/data.js';
import { buildFeed, generateOne } from './lib/feed.js';
import { GENERATOR_KINDS, scheduleReview, applyReviewToDeck } from './lib/generators.js';
import { SOURCE_KINDS } from './lib/source-kinds.js';
import { installPack } from './lib/packs.js';
import { STAFF, keySigSteps } from './lib/theory.js';
import { sharesFromWeights, setShare, setGroupShare, toPercents, weightFromPercent } from './lib/balance.js';

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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
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
// The filter is a set of topic ids; an empty set means "all topics". Topics can carry a category (Music, News, …),
// and when any do, the chip row shows one chip per category instead of one per topic.
const loadFilter = () => { const v = store.get('filter', null); return new Set(Array.isArray(v) ? v : v ? [v] : []); };
let filter = loadFilter();
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const enabledTopics = () => meta.topics.filter((t) => t.enabled);
/** Group topics by category, in order of first appearance, with uncategorised topics last. */
function topicGroups(topics = enabledTopics()) {
  const map = new Map();
  for (const t of topics) {
    const k = (t.category || '').trim();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map].map(([raw, ts]) => ({ raw, name: raw || 'Other', topics: ts })).sort((a, b) => (a.raw === '') - (b.raw === ''));
}
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
}

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
    const groups = topicGroups(topics).map((g) => ({ ...g, shown: g.topics.filter((t) => !q || `${t.name} ${g.name}`.toLowerCase().includes(q)) })).filter((g) => g.shown.length);
    list.replaceChildren(...(groups.length ? groups.flatMap((g) => {
      const ids = g.topics.map((t) => t.id);
      const on = ids.filter((id) => draft.has(id)).length;
      return [
        h('div', { class: 'pick-group' }, h('span', {}, g.name), h('small', {}, `${on}/${ids.length}`),
          h('button', { class: 'link', onclick: () => { if (on === ids.length) ids.forEach((id) => draft.delete(id)); else ids.forEach((id) => draft.add(id)); draw(); } }, on === ids.length ? 'None' : 'All')),
        h('div', { class: 'list' }, g.shown.map((t) => {
          const box = h('input', { type: 'checkbox', class: 'tick', onchange: (e) => { if (e.target.checked) draft.add(t.id); else draft.delete(t.id); draw(); } });
          box.checked = draft.has(t.id);
          return h('label', { class: 'row pick' }, h('span', { class: 'dot', style: { '--c': t.color } }),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'desc' }, `${Math.round((t.weight / total) * 100)}% of feed`)), box);
        })),
      ];
    }) : [h('p', { class: 'status' }, 'No topics match.')]));
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
const feed = { state: null, list: null, sentinel: null, loading: false, done: false, itemIds: [], recentKeys: [], recentTopics: [], dirty: false, scrollY: 0, el: null };

function resetFeed() {
  feed.el = null;
  renderFeed();
}

function renderFeed() {
  if (feed.el && !feed.dirty) { view.replaceChildren(feed.el); requestAnimationFrame(() => scrollTo(0, feed.scrollY)); return; }
  Object.assign(feed, { state: null, loading: false, done: false, itemIds: [], recentKeys: [], recentTopics: [], dirty: false, scrollY: 0 });
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
      n: first ? 8 : 12, topicIds: [...filter], excludeItems: feed.itemIds, recentKeys: feed.recentKeys.slice(-60), recentTopics: feed.recentTopics.slice(-2),
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
        list.replaceChildren(h('div', { class: 'empty' },
          h('h3', {}, fresh ? 'Welcome to Sift' : 'Nothing here yet'),
          h('p', {}, fresh
            ? 'Your feed is empty because you have no topics yet. Add a starter pack, or create your own topic in Settings.'
            : 'Sources are fetched every hour. Add sources or card types in Settings, or use "Fetch all now" there.'),
          fresh ? h('button', { class: 'btn primary', onclick: () => { location.hash = '#/settings/topics'; } }, 'Set up topics') : null));
      } else feed.status.textContent = "You're all caught up.";
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
  if (c.kind === 'article') return renderArticle(c, card);

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
  card.append(metaRow(c, [c.generator]), ...body.filter(Boolean), h('div', { class: 'actions' }, h('span', { class: 'spacer' }), ...btns));
  return card;
}

function renderArticle(c, card) {
  const url = safeUrl(c.url);
  const comments = safeUrl(c.comments_url);
  const summary = c.summary ? h('p', { class: 'summary', onclick: (e) => e.currentTarget.classList.toggle('open') }, c.summary) : null;
  const img = safeUrl(c.image) ? h('img', { class: 'thumb', src: c.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null;
  const btns = reactionButtons(c, {
    initialReaction: c.reaction, initialSaved: c.saved,
    onReact: (r) => data.reactItem(c.item_id, r),
    onSave: (s) => data.saveItem(c.item_id, s),
  });
  card.dataset.item = c.item_id;
  card.append(
    metaRow(c, [c.source, c.published_at && ago(c.published_at)]),
    h('div', { class: 'article-body' },
      h('div', {}, h('h3', {}, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, c.title)), summary),
      img),
    h('div', { class: 'actions' },
      c.score != null ? h('span', { class: 'act', title: 'Community score' }, icon('score'), compact(c.score)) : null,
      comments && comments !== url ? h('a', { class: 'act', href: comments, target: '_blank', rel: 'noopener noreferrer', title: 'Discussion' }, icon('comments'), c.comments != null ? compact(c.comments) : '') : null,
      h('span', { class: 'act', style: { cursor: 'default', paddingLeft: '4px' } }, c.domain || ''),
      h('span', { class: 'spacer' }), ...btns),
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
        h('div', { class: 'answer' }, h('div', { class: 'a-main' }, c.back), c.note ? h('div', { class: 'a-note' }, c.note) : null),
        h('div', { class: 'grade' },
          h('button', { class: 'again', onclick: () => grade('again') }, 'Again', h('small', {}, '< 10 min')),
          h('button', { class: 'good', onclick: () => grade('good') }, 'Good', h('small', {}, 'got it')),
          h('button', { onclick: () => grade('easy') }, 'Easy', h('small', {}, 'too easy'))),
      ),
    }, 'Show answer'));
    return [h('div', { class: 'label', style: { marginTop: '8px' } }, statusLabel), h('div', { class: 'big', lang: 'ru' }, c.front), area];
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

// ---------- saved ----------
async function renderSaved() {
  view.replaceChildren(h('div', { class: 'skeleton' }));
  try {
    const { items, cards } = await data.saved();
    const all = [
      ...items.map((r) => ({ at: r.saved_at, el: renderCard({ key: `item:${r.id}`, kind: 'article', item_id: r.id, topic_id: r.topic_id, title: r.title, summary: (r.summary || '').trim(), url: r.url, domain: r.domain, image: r.image, source: r.source_name, comments_url: r.comments_url, score: r.community_score, comments: r.comment_count, published_at: r.published_at, reaction: r.reaction, saved: true }) })),
      ...cards.map((c) => ({ at: c.saved_at, el: renderCard({ ...c.payload, topic_id: c.topic_id ?? c.payload.topic_id }, { savedId: c.id }) })),
    ].sort((a, b) => b.at - a.at);
    view.replaceChildren(all.length ? h('div', { class: 'feed saved-list' }, all.map((x) => x.el))
      : h('div', { class: 'empty' }, h('h3', {}, 'Nothing saved yet'), h('p', {}, 'Tap the bookmark on any card to keep it here.')));
  } catch (e) { view.replaceChildren(h('p', { class: 'status' }, e.message)); }
}

// ---------- settings ----------
const TABS = [['topics', 'Topics'], ['balance', 'Balance'], ['sources', 'Sources'], ['cards', 'Cards'], ['decks', 'Decks']];

let settingsTab = null;
async function renderSettings(tab = 'sources') {
  if (tab !== settingsTab) Object.values(BULK).forEach((b) => { b.select = false; b.sel.clear(); }); // selection never outlives its tab
  settingsTab = tab;
  await loadMeta().catch(() => {});
  const seg = h('div', { class: 'seg', role: 'tablist' }, TABS.map(([k, label]) => h('button', { 'aria-pressed': String(k === tab), onclick: () => { location.hash = `#/settings/${k}`; } }, label)));
  const body = h('div');
  const footer = h('div', { class: 'toolbar', style: { justifyContent: 'center', marginTop: '32px' } },
    h('button', { class: 'btn', onclick: async () => { await data.signOut(); location.reload(); } }, 'Sign out'));
  view.replaceChildren(seg, body, footer);
  try { await SETTINGS[tab](body); } catch (e) { body.replaceChildren(h('p', { class: 'status' }, e.message)); }
}
const rerender = async () => { // keeps the scroll position; filters and search live in BULK
  feed.dirty = true;
  const y = scrollY;
  await renderSettings(route().arg);
  scrollTo(0, y);
};

function toggle(checked, onchange) {
  const input = h('input', { type: 'checkbox', onclick: (e) => e.stopPropagation(), onchange: (e) => onchange(e.target.checked) });
  input.checked = !!checked;
  return h('label', { class: 'toggle', onclick: (e) => e.stopPropagation() }, input, h('span'));
}
const rowEl = ({ dot, title, desc, err, right, onclick, check, label, off }) => h('div', {
  class: `row${off ? ' off' : ''}`, onclick, tabindex: 0,
  role: check == null ? 'button' : 'checkbox', 'aria-checked': check == null ? null : String(check), 'aria-label': label,
  onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onclick?.(e); } },
},
check == null ? null : tick(check),
dot ? h('span', { class: 'dot', style: { '--c': dot } }) : null,
h('div', { class: 'grow' }, h('div', { class: 'title' }, title), desc ? h('div', { class: `desc${err ? ' err' : ''}` }, desc) : null), right);

// ---------- bulk management (search, filters, collapsible groups, multi-select) ----------
const BULK = {}; // per-tab UI state; survives rerender() so filters and search stay put
const bulkState = (tab) => (BULK[tab] ||= { q: '', topic: '', kind: '', category: '', status: 'all', select: false, sel: new Set() });
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
 * A settings list with a sticky toolbar (search + filters), optional topic groups that collapse, and a
 * selection mode with a bulk action bar. `spec` describes the data; see SETTINGS.* for examples.
 */
function manage(body, spec) {
  const st = bulkState(spec.tab);
  const { items, noun } = spec;
  const statuses = [['all', 'All', () => true], ...spec.statuses];
  const filterActive = () => !!(st.q.trim() || st.topic || st.kind || st.category || st.status !== 'all');
  let session = {}; // collapse overrides made while a filter is active; reset whenever the filters change
  const collapsedKey = `collapsed:${spec.tab}`;

  const matches = (it) => {
    if (st.topic && it.topic_id !== +st.topic) return false;
    if (st.kind && it.kind !== st.kind) return false;
    if (st.category && (it.category || '') !== st.category) return false;
    if (!statuses.find(([k]) => k === st.status)[2](it)) return false;
    const hay = `${spec.search(it)} ${spec.grouped ? topicById(it.topic_id).name : ''}`.toLowerCase();
    return st.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  };
  const shown = () => items.filter(matches);

  // ---- toolbar ----
  const search = h('input', { type: 'search', class: 'bulk-search', placeholder: `Search ${noun[1]}`, 'aria-label': `Search ${noun[1]}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  search.value = st.q;
  search.addEventListener('input', () => { st.q = search.value; filtersChanged(); });
  const selectBtn = h('button', { class: 'btn bulk-select', onclick: () => { st.select = !st.select; st.sel.clear(); paint(); } });
  const chip = (onclick) => h('button', { class: 'chip', onclick });
  const topicChip = spec.grouped ? chip(() => pickerSheet('Filter by topic', [['', 'All topics'], ...meta.topics.map((t) => [String(t.id), t.name, t.color])], st.topic,
    (v) => { st.topic = v; filtersChanged(); })) : null;
  const kindChip = spec.kinds ? chip(() => pickerSheet('Filter by type', [['', 'All types'], ...Object.entries(spec.kinds).map(([k, v]) => [k, v.label])], st.kind,
    (v) => { st.kind = v; filtersChanged(); })) : null;
  const catChip = spec.hasCategory ? chip(() => pickerSheet('Filter by category', [['', 'All categories'], ...[...new Set(items.map((t) => t.category).filter(Boolean))].sort().map((c) => [c, c])], st.category,
    (v) => { st.category = v; filtersChanged(); })) : null;
  const statusChips = statuses.map(([k, label]) => { const b = chip(() => { st.status = k; filtersChanged(); }); b.textContent = label; b.dataset.status = k; return b; });
  const chipsRow = h('div', { class: 'bulk-chips', role: 'group', 'aria-label': 'Filters' }, topicChip, kindChip, catChip, statusChips);
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

  function filtersChanged() { session = {}; paint(); }

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
  // Groups default to topics; a spec can supply its own (Topics groups by category).
  const groupDefs = () => (spec.groups ? spec.groups(items) : meta.topics.map((t) => ({ id: t.id, name: t.name, color: t.color, test: (x) => x.topic_id === t.id })));
  const addRowEl = (a) => (!st.select && a && !filterActive() ? rowEl({ title: h('span', { class: 'add-row' }, a.label), onclick: a.onclick }) : null);

  function groupEl(t, rows) {
    const stored = store.get(collapsedKey, {});
    // Many groups: start collapsed, but never hide matches while searching or filtering.
    const collapsed = filterActive() ? !!session[t.id] : (t.id in stored ? !!stored[t.id] : groupDefs().length > 5);
    const off = rows.filter((x) => x.enabled === false).length;
    const errs = spec.isError ? rows.filter(spec.isError).length : 0;
    const summary = [String(rows.length), off ? `${off} off` : null, errs ? `${errs} error${errs === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    const selected = rows.filter((x) => st.sel.has(x.id)).length;
    const flip = () => {
      if (filterActive()) session[t.id] = !collapsed;
      else store.set(collapsedKey, { ...stored, [t.id]: !collapsed });
      paint(true);
    };
    const setGroup = (on) => () => { rows.forEach((x) => (on ? st.sel.add(x.id) : st.sel.delete(x.id))); paint(true); };
    const a = spec.addRow?.(t);
    return h('section', { class: 'grp' },
      h('div', { class: 'grp-h' },
        h('button', { class: 'grp-toggle', 'aria-expanded': String(!collapsed), 'aria-label': `${t.name}, ${summary.replace(/ · /g, ', ')}`, onclick: flip },
          h('span', { class: 'chev', 'aria-hidden': 'true' }), t.color ? h('span', { class: 'dot', style: { '--c': t.color } }) : null,
          h('span', { class: 'grp-name' }, t.name), h('span', { class: 'grp-sum' }, summary + (st.select && selected ? ` · ${selected} selected` : ''))),
        st.select && rows.length ? h('span', { class: 'grp-sel' },
          h('button', { class: 'linkbtn', 'aria-label': `Select all in ${t.name}`, onclick: setGroup(true) }, 'All'),
          h('button', { class: 'linkbtn', 'aria-label': `Select none in ${t.name}`, onclick: setGroup(false) }, 'None')) : null),
      collapsed ? null : h('div', { class: 'list' }, rows.map(rowFor), addRowEl(a)));
  }

  function paint(keepScroll) {
    const rows = shown();
    const ids = new Set(rows.map((x) => x.id));
    for (const id of st.sel) if (!ids.has(id)) st.sel.delete(id); // selection only ever holds what is visible under the filters

    selectBtn.textContent = st.select ? 'Done' : 'Select';
    selectBtn.classList.toggle('primary', st.select);
    selectBtn.setAttribute('aria-pressed', String(st.select));
    selectBtn.setAttribute('aria-label', st.select ? 'Leave selection mode' : `Select ${noun[1]}`);
    const setChip = (el, label, on) => { if (el) { el.textContent = `${label} ▾`; el.setAttribute('aria-pressed', String(on)); } };
    setChip(topicChip, st.topic ? topicById(+st.topic).name : 'Topic', !!st.topic);
    setChip(kindChip, st.kind ? spec.kinds[st.kind]?.label || st.kind : 'Type', !!st.kind);
    setChip(catChip, st.category || 'Category', !!st.category);
    statusChips.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === st.status)));
    count.textContent = `${rows.length} of ${items.length} ${noun[1]}`;
    selAll.hidden = selNone.hidden = !st.select;
    selAll.disabled = !rows.length || st.sel.size === rows.length;
    selNone.disabled = !st.sel.size;
    bar.hidden = !st.select;
    barCount.textContent = st.sel.size;
    actionBtns.forEach((b) => { b.disabled = !st.sel.size; });

    const y = keepScroll ? scrollY : null;
    let content;
    if (!rows.length && items.length) {
      content = h('div', { class: 'empty small' }, h('p', {}, `No ${noun[1]} match.`),
        h('button', { class: 'btn', onclick: () => { Object.assign(st, { q: '', topic: '', kind: '', category: '', status: 'all' }); search.value = ''; filtersChanged(); } }, 'Clear search and filters'));
    } else if (spec.grouped || spec.groups) {
      const defs = groupDefs();
      if (spec.groups && defs.length === 1 && defs[0].flat) content = [h('div', { class: 'list' }, rows.map(rowFor))];
      else {
        content = defs.filter((g) => !st.topic || g.id === +st.topic).map((g) => [g, rows.filter(g.test)])
          .filter(([, r]) => r.length || (!filterActive() && !st.select && !spec.groups)).map(([g, r]) => groupEl(g, r));
      }
    } else {
      content = [h('div', { class: 'list' }, rows.map(rowFor), addRowEl(spec.addRow))];
    }
    if (spec.footer && !st.select && !filterActive()) content = [...[content].flat(), h('div', { class: 'list', style: { marginTop: '14px' } }, spec.footer())];
    list.replaceChildren(...[content].flat());
    list.classList.toggle('selecting', st.select);
    if (y != null) scrollTo(0, y);
  }
  paint();
}

const SETTINGS = {
  async topics(body) {
    const topics = await data.topics();
    const total = topics.filter((t) => t.enabled).reduce((s, t) => s + t.weight, 0) || 1;
    const hasCategory = true;
    body.append(h('p', { class: 'intro' }, topics.length ? 'Topics are the channels in your feed. Set how much each one gets in Balance, and group them with a category so the feed\'s topic picker stays tidy.' : 'Topics are the channels in your feed. Start from a starter pack or add your own.'));
    manage(body, {
      tab: 'topics', noun: ['topic', 'topics'], items: topics, hasCategory,
      // Grouped by category, like the feed's topic picker; with no categories at all it is one flat list.
      groups: (all) => topicGroups(all).map((g) => ({ id: g.raw || '__other', name: g.name, flat: !g.raw, test: (x) => (x.category || '').trim() === g.raw })),
      search: (t) => `${t.name} ${t.category || ''}`,
      statuses: [['on', 'Shown', (t) => t.enabled], ['off', 'Hidden', (t) => !t.enabled]],
      row: (t) => ({
        dot: t.color, title: t.name,
        desc: t.enabled ? `${Math.round((t.weight / total) * 100)}% of feed · ${Math.round(t.curated_ratio * 100)}% articles when available` : 'Hidden',
      }),
      table: 'topics', onOpen: editTopic,
      footer: () => [
        rowEl({ title: h('span', { class: 'add-row' }, '+ Add topic'), onclick: () => editTopic(null) }),
        rowEl({ title: h('span', { class: 'add-row' }, '+ Add starter pack'), desc: 'Ready-made topics with sources and card types', onclick: openPackPicker }),
      ],
      on: { label: 'Show', done: 'Showing' }, off: { label: 'Hide', done: 'Hid' },
      actions: (ctx) => [
        ctx.enable(true), ctx.enable(false),
        {
          label: 'Set category…', run: (ids) => {
            const cats = [...new Set(topics.map((t) => (t.category || '').trim()).filter(Boolean))].sort();
            const input = h('input', { type: 'text', list: 'bulk-categories', placeholder: 'e.g. Learning', autocomplete: 'off' });
            openSheet('Set category', h('div', {},
              field(`Category for ${plural(ids.length, ctx.noun)}`, input, 'Leave empty to clear the category.'),
              h('datalist', { id: 'bulk-categories' }, cats.map((c) => h('option', { value: c }))),
              h('button', { class: 'btn primary', onclick: () => ctx.apply(() => data.updateMany('topics', ids, { category: input.value.trim() }), `Updated ${plural(ids.length, ctx.noun)}`) }, 'Apply')));
            input.focus();
          },
        },
        ctx.remove((n) => `Delete ${n}? This also deletes all their sources and card types.`),
      ],
    });
  },
  async balance(body) {
    const topics = (await data.topics()).filter((t) => t.enabled);
    if (!topics.length) { body.append(h('p', { class: 'intro' }, 'No visible topics yet. Add a topic or a starter pack first.')); return; }
    const initial = sharesFromWeights(topics.map((t) => t.weight));
    const initialPct = toPercents(initial);
    let shares = initial.slice();
    const locked = topics.map(() => false);
    const groups = topicGroups(topics).map((g) => ({ ...g, idx: g.topics.map((t) => topics.indexOf(t)) }));
    const categorised = groups.some((g) => g.raw);

    const stack = h('div', { class: 'stack', role: 'img', 'aria-label': 'Share of feed by topic' }, topics.map((t) => h('span', { style: { '--c': t.color } })));
    const save = h('button', { class: 'btn primary' }, 'Save');
    const state = h('span', { class: 'sub' });
    const refs = topics.map((t, i) => {
      const range = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': `${t.name} share`, oninput: () => change(setShare(shares, locked, i, +range.value)) });
      const num = h('input', { type: 'number', min: 0, max: 100, step: 1, inputmode: 'numeric', 'aria-label': `${t.name} percent`, onchange: () => change(setShare(shares, locked, i, +num.value)) });
      const lock = h('button', { class: 'act lock', 'aria-label': `Lock ${t.name}`, 'aria-pressed': 'false', title: 'Lock this share', onclick: () => { locked[i] = !locked[i]; lock.setAttribute('aria-pressed', String(locked[i])); draw(); } }, icon('lock'));
      return { range, num, lock };
    });
    const groupRefs = groups.map((g) => {
      const range = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': `${g.name} share`, oninput: () => change(setGroupShare(shares, locked, g.idx, +range.value)) });
      const out = h('b', {});
      return { range, out };
    });
    const change = (next) => { shares = next; draw(); };
    const draw = () => {
      const pct = toPercents(shares);
      topics.forEach((t, i) => {
        const r = refs[i];
        r.range.value = shares[i]; r.num.value = pct[i];
        r.range.disabled = locked[i];
        r.lock.setAttribute('aria-pressed', String(locked[i]));
        stack.children[i].style.flexGrow = String(shares[i]);
        stack.children[i].title = `${t.name} ${pct[i]}%`;
      });
      groups.forEach((g, gi) => {
        const sum = g.idx.reduce((a, i) => a + shares[i], 0);
        groupRefs[gi].range.value = sum; groupRefs[gi].out.textContent = `${Math.round(sum)}%`;
        groupRefs[gi].range.disabled = g.idx.every((i) => locked[i]);
      });
      const dirty = pct.some((v, i) => v !== initialPct[i]);
      save.disabled = !dirty;
      state.textContent = dirty ? 'Unsaved changes' : 'Saved';
    };
    save.onclick = async () => {
      save.disabled = true;
      const pct = toPercents(shares);
      try {
        await Promise.all(topics.map((t, i) => (Math.abs(weightFromPercent(pct[i]) - t.weight) > 0.005 ? data.update('topics', t.id, { weight: weightFromPercent(pct[i]) }) : null)));
        toast('Balance saved'); rerender();
      } catch (e) { fail(e); save.disabled = false; }
    };
    const even = () => {
      const lockedSum = shares.reduce((a, v, i) => a + (locked[i] ? v : 0), 0);
      const free = locked.filter((l) => !l).length;
      if (free) change(shares.map((v, i) => (locked[i] ? v : (100 - lockedSum) / free)));
    };

    body.append(
      h('p', { class: 'intro' }, 'How much of your feed each topic gets. The shares always add up to 100%: move one and the others give way in proportion. Lock a topic to hold its share. A topic with nothing left to show is skipped, so real shares can drift a little.'),
      stack,
      ...groups.flatMap((g, gi) => [
        categorised ? h('div', { class: 'bal-group' }, h('span', {}, g.name), groupRefs[gi].out, groupRefs[gi].range) : null,
        h('div', { class: 'list' }, g.topics.map((t) => {
          const i = topics.indexOf(t);
          return h('div', { class: 'bal-row' },
            h('div', { class: 'bal-top' }, h('span', { class: 'dot', style: { '--c': t.color } }), h('span', { class: 'grow title' }, t.name), refs[i].lock,
              h('label', { class: 'pct' }, refs[i].num, '%')),
            refs[i].range);
        })),
      ]),
      h('div', { class: 'toolbar' }, save, h('button', { class: 'btn', onclick: even }, 'Even out'),
        h('button', { class: 'btn', onclick: () => { shares = initial.slice(); locked.fill(false); draw(); } }, 'Reset'), state),
    );
    draw();
  },
  async sources(body) {
    const sources = await data.sourceStats();
    body.append(h('p', { class: 'intro' }, 'Where articles come from. Strict sources and score thresholds keep the feed useful.'));
    manage(body, {
      tab: 'sources', noun: ['source', 'sources'], items: sources, grouped: true, kinds: meta.source_kinds,
      search: (s) => `${s.name} ${s.config?.url || ''} ${s.include || ''}`,
      isError: (s) => !!s.last_error,
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
      addRow: (t) => ({ label: '+ Add source', onclick: () => editSource({ topic_id: t.id, kind: 'rss', config: {}, weight: 1, enabled: true }) }),
      on: { label: 'Turn on', done: 'Turned on' }, off: { label: 'Turn off', done: 'Turned off' },
      actions: (ctx) => [
        ctx.enable(true), ctx.enable(false),
        {
          label: 'Move to topic…', run: (ids) => pickerSheet(`Move ${plural(ids.length, ctx.noun)} to`, meta.topics.map((t) => [t.id, t.name, t.color]), null,
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
    });
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
    body.append(h('div', { class: 'toolbar' }, fetchBtn));
  },
  async cards(body) {
    const gens = await data.generators();
    body.append(h('p', { class: 'intro' }, 'Practice cards made from code and your own decks and lists. They keep the feed going when articles run out.'));
    manage(body, {
      tab: 'cards', noun: ['card type', 'card types'], items: gens, grouped: true, kinds: meta.generator_kinds,
      search: (g) => `${g.name} ${meta.generator_kinds[g.kind]?.label || g.kind}`,
      statuses: [['on', 'On', (g) => g.enabled], ['off', 'Off', (g) => !g.enabled]],
      row: (g) => ({ title: g.name, desc: `${meta.generator_kinds[g.kind]?.label || g.kind} · weight ${(+g.weight).toFixed(1)}` }),
      table: 'generators', onOpen: editGenerator,
      addRow: (t) => ({ label: '+ Add card type', onclick: () => editGenerator({ topic_id: t.id, kind: 'prompts', config: {}, weight: 1, enabled: true }) }),
      on: { label: 'Turn on', done: 'Turned on' }, off: { label: 'Turn off', done: 'Turned off' },
      actions: (ctx) => [ctx.enable(true), ctx.enable(false), ctx.remove((n) => `Delete ${n}?`)],
    });
  },
  async decks(body) {
    const decks = await data.deckStats();
    body.append(
      h('p', { class: 'intro' }, 'Flashcard decks for spaced repetition. Show one in the feed by adding a "Flashcards" card type.'),
      h('div', { class: 'list' },
        decks.map((d) => rowEl({ title: d.name, desc: `${d.cards} cards · ${d.studied || 0} studied · ${d.due_now || 0} due now`, onclick: () => editDeck(d) })),
        rowEl({ title: h('span', { class: 'add-row' }, '+ New deck'), onclick: () => editDeck(null) })),
    );
  },
};

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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label), input, help ? h('small', {}, help) : null);
}
function topicSelect(value) {
  const sel = h('select', {}, meta.topics.map((t) => h('option', { value: t.id }, t.name)));
  sel.value = value;
  return sel;
}

/** Build inputs from a kind's field schema. Returns { el, read() }. */
function schemaFields(fields, config) {
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
        input = h('select', {}, h('option', { value: '' }, '— choose a deck —'), meta.decks.map((d) => h('option', { value: d.id }, `${d.name} (${d.cards})`)));
        input.value = v ?? ''; getters[f.key] = () => Number(input.value) || null; break;
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
async function deleteRow(table, row, what) {
  if (!confirm(`Delete ${what}?`)) return;
  try { await data.remove(table, row.id); } catch (e) { return fail(e); }
  closeSheet(); toast('Deleted'); rerender();
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
  const active = meta.topics.filter((x) => x.enabled);
  // A new topic starts with an average share; fine-tune it in Balance.
  t ||= { name: '', color: '#64748b', weight: active.length ? Math.round((active.reduce((a, x) => a + x.weight, 0) / active.length) * 100) / 100 : 2, curated_ratio: 0.5, enabled: true, category: '' };
  const name = h('input', { type: 'text', value: t.name, placeholder: 'e.g. Chess' });
  const category = h('input', { type: 'text', value: t.category || '', placeholder: 'e.g. Music, News, Tech', list: 'category-options', autocapitalize: 'words' });
  const options = h('datalist', { id: 'category-options' }, [...new Set(meta.topics.map((x) => (x.category || '').trim()).filter(Boolean))].map((c) => h('option', { value: c })));
  const color = h('input', { type: 'color', value: t.color });
  const rOut = h('b', {}, `${Math.round(t.curated_ratio * 100)}%`);
  const ratio = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: t.curated_ratio, oninput: () => { rOut.textContent = `${Math.round(ratio.value * 100)}%`; } });
  const total = active.reduce((a, x) => a + x.weight, 0) || 1;
  const share = t.id && t.enabled ? `${Math.round((t.weight / total) * 100)}% of your feed` : null;
  openSheet(t.id ? 'Edit topic' : 'New topic', h('div', {},
    field('Name', name), field('Category', h('div', {}, category, options), 'Groups topics in the feed\'s topic filter. Leave empty for none.'), field('Colour', color),
    share ? h('div', { class: 'field' }, h('span', {}, 'Share of feed'), h('div', { class: 'sub' }, share, ' · ', h('button', { class: 'link', onclick: () => { location.hash = '#/settings/balance'; } }, 'change in Balance'))) : null,
    field(h('span', {}, 'Articles vs practice cards: ', rOut), ratio, 'Chance each slot is an article when unread articles exist; otherwise it is a practice card.'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: () => name.value.trim() ? saveRow('topics', t, { name: name.value.trim(), category: category.value.trim(), color: color.value, weight: t.weight, curated_ratio: +ratio.value, enabled: t.enabled }) : toast('Name is required') }, 'Save'),
      t.id ? h('button', { class: 'btn danger', onclick: () => deleteRow('topics', t, `"${t.name}" and all its sources and card types`) }, 'Delete') : null)));
}

function editSource(s) {
  const name = h('input', { type: 'text', value: s.name || '', placeholder: 'e.g. r/learnpython' });
  const topic = topicSelect(s.topic_id);
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
  const topic = topicSelect(g.topic_id);
  const kind = h('select', {}, Object.entries(meta.generator_kinds).map(([k, v]) => h('option', { value: k }, v.label)));
  kind.value = g.kind;
  const name = h('input', { type: 'text', value: g.name || '' });
  const weight = h('input', { type: 'number', step: 0.1, value: g.weight ?? 1, inputmode: 'decimal' });
  const kindBox = h('div');
  const preview = h('div', { class: 'preview' });
  let form;
  const renderKind = () => {
    const k = meta.generator_kinds[kind.value];
    form = schemaFields(k.fields, kind.value === g.kind ? g.config || {} : {});
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

async function editDeck(d) {
  const name = h('input', { type: 'text', value: d?.name || '', placeholder: 'e.g. Russian verbs of motion' });
  const csv = h('textarea', { rows: 8, placeholder: 'front, back, note\nидти́, to go (on foot), Я иду́ домо́й.\n…' });
  const list = h('div', { class: 'list deck-cards' });
  const content = h('div', {}, field('Name', name),
    field('Add cards', csv, 'One card per line: front, back, optional note. Comma or tab separated; quote fields containing commas. Paste from a spreadsheet works.'),
    h('div', { class: 'toolbar' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!name.value.trim()) return toast('Name is required');
          try {
            let id = d?.id;
            if (id) await data.update('decks', id, { name: name.value.trim() });
            else id = (await data.insert('decks', { name: name.value.trim() })).id;
            if (csv.value.trim()) toast(`Added ${await data.importCards(id, csv.value)} cards`); else toast('Saved');
            closeSheet(); rerender();
          } catch (e) { toast(e.message); }
        },
      }, 'Save'),
      d ? h('button', { class: 'btn danger', onclick: () => deleteRow('decks', d, `deck "${d.name}" and its ${d.cards} cards`) }, 'Delete deck') : null),
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
  const [, name = '', arg] = location.hash.replace(/^#/, '').split('/');
  return { name: name || 'feed', arg };
}
function onRoute() {
  const r = route();
  if (r.name !== 'feed' && feed.el?.isConnected) feed.scrollY = scrollY;
  document.querySelectorAll('.tabbar a').forEach((a) => (a.dataset.tab === r.name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  renderChips();
  closeSheet();
  if (r.name === 'saved') renderSaved();
  else if (r.name === 'settings') renderSettings(TABS.some(([k]) => k === r.arg) ? r.arg : 'sources');
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
