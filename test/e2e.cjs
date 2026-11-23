// End-to-end browser test against the dev server (scripts/dev.js), using the real supabase-js client.
// Not part of `npm test` (needs Chromium + a running dev server):
//   RESET_DB=1 npm run dev &   then   node test/e2e.cjs [screenshot-dir]
const { chromium, devices } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres');

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const OUT = process.argv[2];
const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sift_dev', { onnotice: () => {} });
const assert = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); console.log(`  ✓ ${msg}`); };
// Filter the feed through the topic picker: tick the named topics, or everything when `names` is null.
const pickTopics = async (p, names) => {
  await p.click('#topics-btn');
  await p.waitForSelector('.pick-quick');
  if (names) {
    await p.click('.pick-quick .chip:has-text("Clear")');
    for (const n of [].concat(names)) await p.check(`.row.pick:has(.title:text-is("${n}")) input.tick`);
  } else await p.click('.pick-quick .chip:has-text("Select all")');
  await p.click('.pick-foot .btn.primary');
  await p.waitForSelector('#sheet', { state: 'hidden' });
};

(async () => {
  // A local feed for "add source" / "preview" / "fetch now".
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/atom.xml'), 'utf8').replaceAll('RECENT', new Date(Date.now() - 3600e3).toISOString());
  const feedServer = http.createServer((_, res) => res.writeHead(200, { 'Content-Type': 'application/xml' }).end(fixture)).listen(0);
  const feedUrl = `http://127.0.0.1:${feedServer.address().port}/feed.xml`;

  // Sample articles (live feeds aren't needed for the UI test).
  const addSamples = async () => {
  await sql`delete from items where url like 'https://sample.test/%'`;
  const samples = [
    ['Simon Willison', 'Notes on prompt caching for long agent sessions', 'A short description from the feed itself appears here, clamped to a few lines so cards stay bite-sized.', null, 3],
    ['Hacker News: AI', 'A visual guide to how transformers pay attention', "Summary pulled from the page's description.", 642, 9],
    ['Russian With Max', 'Verbs of motion finally clicked for me', 'The video description is used as the summary.', null, 20],
    ['Nahre Sol', 'How I practise sight-reading 10 minutes a day', '', null, 15],
  ];
  for (const [i, [source, title, summary, score, hrs]] of samples.entries()) {
    await sql`insert into items (source_id, topic_id, url, title, title_key, summary, domain, community_score, published_at)
      select id, topic_id, ${`https://sample.test/${i}`}, ${`[Sample] ${title}`}, ${title.toLowerCase()}, ${summary}, 'sample.test', ${score},
             now() - ${`${hrs} hours`}::interval from sources where name = ${source}`;
  }
  };

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: OUT ? 2 : 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/favicon|net::ERR_/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const shot = (name) => OUT && p.screenshot({ path: path.join(OUT, `e2e-${name}.png`) });

  console.log('auth');
  await p.goto(BASE);
  await p.waitForSelector('form.login');
  assert(true, 'signed-out visitor sees the sign-in form');
  await p.fill('input[type=email]', 'me@example.com');
  await p.fill('input[type=password]', 'pw');
  await p.click('button[type=submit]');
  await p.waitForSelector('.empty h3:has-text("Welcome")');
  assert(true, 'a fresh install has an empty feed that points at setup');
  await shot('welcome');
  await p.click('.empty button:has-text("Set up topics")');
  await p.waitForSelector('text=+ Add starter pack');
  await p.click('text=+ Add starter pack');
  await p.waitForSelector('.sheet .row:has-text("Russian")');
  await p.waitForTimeout(500); await shot('packs');
  for (const name of ['AI', 'Russian', 'Guitar', 'Piano & music theory']) {
    await p.click(`.sheet .row:has-text("${name}") button`);
    await p.waitForSelector(`.sheet .row:has-text("${name}") button:has-text("Added")`);
  }
  const [counts] = await sql`select (select count(*) from topics)::int t, (select count(*) from cards)::int c, (select count(*) from generators)::int g`;
  assert(counts.t === 7 && counts.c === 90 && counts.g === 9, `starter packs install topics, deck and card types (${JSON.stringify(counts)})`);
  const split = await sql`select name, kind from topics order by position`;
  assert(split.map((r) => `${r.name}:${r.kind}`).join() === 'AI:articles,Russian:articles,Russian practice:cards,Guitar:articles,Guitar practice:cards,Piano:articles,Piano practice:cards',
    `a pack install results in split topics in order (${split.map((r) => r.name).join(', ')})`);
  assert((await sql`select count(*)::int n from sources where topic_id in (select id from topics where kind = 'cards')`)[0].n === 0
    && (await sql`select count(*)::int n from generators where topic_id in (select id from topics where kind = 'articles')`)[0].n === 0, 'sources only on article topics, card types only on card topics');
  await p.click('.sheet-head [data-close]');
  await addSamples();
  await p.click('a[data-tab=feed]');
  await p.click('#refresh');
  await p.waitForSelector('.card');
  assert(true, 'the feed fills once topics exist');
  await p.waitForTimeout(400);
  await shot('feed');

  console.log('feed');
  const kinds = new Set();
  for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 3000); await p.waitForTimeout(250); }
  for (const k of await p.$$eval('.card', (cs) => cs.map((c) => c.className.replace('card k-', '')))) kinds.add(k);
  const count = await p.$$eval('.card', (c) => c.length);
  assert(count >= 40, `infinite scroll keeps loading (${count} cards)`);
  assert(kinds.has('article') && kinds.has('flashcard') && kinds.size >= 6, `mixes card kinds: ${[...kinds].join(', ')}`);

  console.log('feed type filter');
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(400);
  assert(await p.isVisible('#typebar') && (await p.$$eval('#typebar button', (b) => b.map((x) => x.textContent))).join() === 'All,Articles,Cards', 'the feed shows an All / Articles / Cards bar under the header');
  assert((await p.getAttribute('#typebar button[data-type=all]', 'aria-pressed')) === 'true', 'the feed starts on All');
  const clearsHeader = await p.evaluate(() => document.querySelector('.card').getBoundingClientRect().top >= document.getElementById('typebar').getBoundingClientRect().bottom - 1);
  assert(clearsHeader, 'the bar does not cover the first card');
  await shot('feed-filter');
  const settled = () => p.waitForFunction(() => !document.querySelector('.skeleton') && document.querySelectorAll('.card').length > 0);
  const cardKinds = () => p.$$eval('.card', (cs) => cs.map((c) => c.classList.contains('k-article') ? 'article' : 'generated'));
  await p.click('#typebar button[data-type=articles]'); await settled();
  let ks = await cardKinds();
  assert(ks.length >= 4 && ks.every((k) => k === 'article'), `Articles shows only article cards (${ks.length})`);
  await p.click('#typebar button[data-type=cards]'); await settled();
  ks = await cardKinds();
  assert(ks.length >= 8 && ks.every((k) => k === 'generated'), `Cards shows only generated cards (${ks.length})`);
  await p.click('#typebar button[data-type=all]'); await settled();
  await p.waitForTimeout(300);
  ks = await cardKinds();
  assert(new Set(ks).size === 2, 'All shows both');
  await pickTopics(p, 'Russian practice');
  await p.click('#typebar button[data-type=articles]');
  await p.waitForSelector('.empty h3:has-text("No article topics in your filter")');
  assert(true, 'an empty filtered feed explains itself');
  await p.click('.empty button:has-text("Show everything")');
  await settled();
  await pickTopics(p, null);
  await settled();
  for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(150); }
  await p.waitForTimeout(400);
  assert((await p.getAttribute('#typebar', 'data-hidden')) !== null && (await p.$eval('#typebar', (e) => getComputedStyle(e).visibility)) === 'hidden', 'the bar hides after scrolling down');
  await p.mouse.wheel(0, -120); await p.waitForTimeout(400);
  assert((await p.getAttribute('#typebar', 'data-hidden')) === null && await p.isVisible('#typebar'), 'the bar reappears on scrolling up');
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);

  await pickTopics(p, 'Russian practice');
  await p.waitForSelector('.k-flashcard .reveal');
  const fcLangs = await p.$$eval('.k-flashcard .big', (els) => els.map((el) => el.getAttribute('lang')));
  assert(fcLangs.length && fcLangs.every((l) => l === 'ru'), `Russian flashcard fronts are tagged with their deck's language (${fcLangs.join(', ')})`);
  await p.click('.k-flashcard .reveal');
  await p.click('.k-flashcard .grade .good');
  await p.waitForSelector('.k-flashcard .graded');
  const [studied] = await sql`select count(*)::int n from cards where due is not null and introduced_at is not null`;
  assert(studied.n === 1, 'grading a flashcard schedules it in the database');

  await pickTopics(p, null);
  await p.waitForSelector('.k-article');
  const itemId = await p.$eval('.k-article', (el) => Number(el.dataset.item));
  await p.click(`.k-article[data-item="${itemId}"] .act.up`);
  await p.click(`.k-article[data-item="${itemId}"] .act.save`);
  await p.waitForTimeout(1500); // also long enough to be marked seen
  await p.waitForSelector('.toast.show:has-text("Saved")');
  const [item] = await sql`select reaction, saved_at, seen_at from items where id = ${itemId}`;
  assert(item.reaction === 1 && item.saved_at, '👍 and save are stored');
  await p.click('#refresh'); // flushes the seen queue
  await p.waitForTimeout(800);
  const [seen] = await sql`select count(*)::int n from items where seen_at is not null`;
  assert(seen.n >= 1, `articles on screen are marked seen (${seen.n})`);
  for (let i = 0; i < 12 && !(await p.$('.card:not(.k-article):not(.k-flashcard)')); i++) { await p.mouse.wheel(0, 2500); await p.waitForTimeout(300); }
  await p.waitForSelector('.card:not(.k-article):not(.k-flashcard) .act.save');
  await p.click('.card:not(.k-article):not(.k-flashcard) .act.save');
  await p.waitForSelector('.toast.show:has-text("Saved")');

  await p.click('a[data-tab=saved]');
  await p.waitForSelector('.saved-list .card');
  assert(!(await p.isVisible('#typebar')), 'the type bar is hidden outside the feed');
  const savedCount = await p.$$eval('.saved-list .card', (c) => c.length);
  assert(savedCount === 2, `saved view shows the saved article and practice card (${savedCount})`);

  console.log('hide + reader');
  await p.click('a[data-tab=feed]');
  await p.waitForSelector('.k-article');
  const hideId = await p.$eval('.k-article[data-source]', (el) => el.dataset.source);
  await p.click(`.k-article[data-source="${hideId}"] .act.more`);
  await p.click('#sheet .row:has-text("Hide source")');
  await p.waitForSelector('.toast.show:has-text("Hidden")');
  assert((await p.$$(`.k-article[data-source="${hideId}"]`)).length === 0, 'hiding a source clears its cards at once');
  await p.click('.toast button:has-text("Undo")');
  await p.waitForTimeout(400);
  assert((await sql`select enabled from sources where id = ${hideId}`)[0].enabled, 'undo re-enables the source');
  await sql`update items set seen_at = null where url like 'https://sample.test/%'`;
  await p.click('#refresh');
  await p.waitForSelector('.k-article');
  const sample = await sql`select id from items where url = 'https://sample.test/0'`;
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, sample[0].id);
  await p.waitForSelector('.reader-fail, .reader-body, .reader-skel');
  assert(await p.isHidden('.tabbar'), 'reader view opens (tab bar hidden)');
  await shot('reader');
  // Share: the system share sheet when there is one, else the link is copied.
  await p.evaluate(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d; }; });
  await p.click('.reader-bar [aria-label="Share"]');
  assert((await p.evaluate(() => window.__shared?.url)) === 'https://sample.test/0', 'Share hands the original link to the share sheet');
  await p.evaluate(() => { delete navigator.share; Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await p.click('.reader-bar [aria-label="Share"]');
  await p.waitForSelector('.toast.show:has-text("Link copied")');
  assert((await p.evaluate(() => window.__copied)) === 'https://sample.test/0', 'without a share sheet, Share copies the link');
  await p.click('.reader-back');
  await p.waitForSelector('.feed .card');

  console.log('card type menu');
  await p.waitForSelector('.card[data-generator]');
  const genId = await p.$eval('.card[data-generator]', (el) => el.dataset.generator);
  const [w0] = await sql`select weight from generators where id = ${genId}`;
  await p.click(`.card[data-generator="${genId}"] .act.more`);
  await p.click('#sheet .row:has-text("Show less of this card type")');
  await p.waitForSelector('.toast.show:has-text("Less")');
  await p.waitForTimeout(300);
  const [w1] = await sql`select weight from generators where id = ${genId}`;
  assert(Number(w1.weight) < Number(w0.weight), 'show less lowers the card type weight');
  await p.click(`.card[data-generator="${genId}"] .act.more`);
  await p.click('#sheet .row:has-text("Hide card type")');
  await p.waitForSelector('.toast.show:has-text("Hidden")');
  assert((await p.$$(`.card[data-generator="${genId}"]`)).length === 0, 'hiding a card type clears its cards at once');
  assert((await sql`select enabled from generators where id = ${genId}`)[0].enabled === false, 'card type disabled in the DB');
  await p.click('.toast button:has-text("Undo")');
  await p.waitForTimeout(400);
  assert((await sql`select enabled from generators where id = ${genId}`)[0].enabled === true, 'undo re-enables the card type');

  console.log('feed menu: edit and hide topic');
  await p.click('.card[data-generator] .act.more >> nth=0');
  await p.click('#sheet .row:has-text("Edit card type")');
  await p.waitForSelector('#sheet-title:has-text("Edit card type")');
  assert(p.url().includes('#/settings/topic/'), 'Edit card type… opens the editor on that topic’s page');
  await p.click('.sheet-head [data-close]');
  await p.click('a[data-tab=feed]');
  await p.waitForSelector('.k-article');
  const srcCardId = await p.$eval('.k-article[data-source]', (el) => el.dataset.source);
  await p.click(`.k-article[data-source="${srcCardId}"] .act.more >> nth=0`);
  await p.click('#sheet .row:has-text("Edit source")');
  await p.waitForSelector('#sheet-title:has-text("Edit source")');
  assert(p.url().includes('#/settings/topic/'), 'Edit source… opens the editor on that topic’s page');
  await p.click('.sheet-head [data-close]');
  await p.click('a[data-tab=feed]');
  await p.waitForSelector('.k-article');
  const hidTopic = await p.$eval('.k-article[data-topic]', (el) => el.dataset.topic);
  const hidSource = await p.$eval(`.k-article[data-topic="${hidTopic}"]`, (el) => el.dataset.source);
  await p.click(`.k-article[data-source="${hidSource}"] .act.more >> nth=0`);
  await p.click('#sheet .row:has-text("Hide topic")');
  await p.waitForSelector('.toast.show:has-text("Hidden")');
  await p.waitForTimeout(400);
  const visibleW = (await sql`select weight from topics where enabled order by position`).map((r) => Number(r.weight));
  assert(visibleW.length === 6 && Math.abs(visibleW[5] - 0.6554) < 1e-3, 'hiding a topic from the feed rebalances the remaining weights');
  await p.click('.toast button:has-text("Undo")');
  await p.waitForTimeout(500);
  assert((await sql`select count(*)::int n from topics where enabled`)[0].n === 7 && Math.abs((await sql`select weight from topics where enabled order by position desc limit 1`)[0].weight - 0.5243) < 1e-3, 'undo restores the topic and its weight');

  console.log('settings: topics as a stack rank');
  await p.click('a[data-tab=settings]');
  await p.waitForSelector('.rank-list .row');
  assert((await p.$$('#view .seg:not(.falloff) button')).length === 2 && (await p.$$eval('#view .seg:not(.falloff) button', (b) => b.map((x) => x.textContent))).join() === 'Topics,Domains', 'Settings has only the Topics and Domains tabs');
  const rankNames = () => p.$$eval('.rank-list .row .title', (t) => t.map((x) => x.firstChild.textContent));
  const dbRank = async () => (await sql`select name, position, weight from topics where enabled order by position`).map((r) => ({ ...r, weight: Number(r.weight) }));
  const waitSaved = () => p.waitForSelector('.rank-status:text-is("Saved")');
  const initial = await rankNames();
  assert(initial.length === 7, `topics are listed in rank order (${initial.join(' > ')})`);
  const descs = await p.$$eval('.rank-list .row .desc', (d) => d.map((x) => x.textContent));
  assert(/^Articles · \d+ sources$/.test(descs[0]) && descs.some((d) => /^Cards · \d+ card types$/.test(d)), `rows describe their kind and count (${descs[0]} / ${descs[2]})`);
  const pcts = await p.$$eval('.rank-pct', (e) => e.map((x) => parseInt(x.textContent)));
  assert(pcts.reduce((a, b) => a + b, 0) === 100 && pcts[0] > pcts[6], `live shares add up to 100% and fall down the list (${pcts.join(', ')})`);
  assert((await p.getAttribute('.falloff button:has-text("Smooth")', 'aria-pressed')) === 'true', 'Smooth is the default falloff');
  await p.waitForSelector('.toast.show', { state: 'hidden' }).catch(() => {});
  await shot('topics-rank');

  // Reorder with the arrows.
  const first = initial[0];
  await p.click(`button[aria-label="Move ${first} down"]`);
  await p.waitForFunction((n) => document.querySelectorAll('.rank-list .row .title')[1]?.firstChild.textContent === n, first);
  await waitSaved();
  let rows = await dbRank();
  assert(rows[1].name === first && rows.every((r, i) => r.position === i), 'moving a topic down saves positions 0..n-1');
  const expectW = (ratio) => rows.every((r, i) => Math.abs(r.weight - Math.round(2 * ratio ** i * 1e4) / 1e4) < 1e-4);
  assert(expectW(0.8), 'weights follow rank with the Smooth falloff (2, 1.6, 1.28, …)');
  assert((await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === `Move ${first} down`, 'focus stays on the arrow just used');
  await p.click(`button[aria-label="Move ${first} up"]`);
  await waitSaved();
  assert((await dbRank())[0].name === first, 'the arrows move it back up');
  assert(await p.isDisabled(`button[aria-label="Move ${first} up"]`), 'the top topic cannot move up');

  // Falloff presets.
  await p.click('.falloff button:has-text("Steep")');
  await p.waitForFunction(() => document.querySelector('.rank-status')?.textContent === 'Saved');
  rows = await dbRank();
  assert(expectW(0.7), 'the Steep preset rewrites the weights');
  assert(Number((await sql`select value from app_settings where key = 'falloff'`)[0].value) === 0.7, 'the falloff is stored in app_settings');
  const steep = await p.$$eval('.rank-pct', (e) => e.map((x) => parseInt(x.textContent)));
  assert(steep[0] > pcts[0], `Steep gives the top topic a bigger share (${steep[0]}% vs ${pcts[0]}%)`);
  await p.click('.falloff button:has-text("Even")');
  await p.waitForFunction(() => /^(\d+)%$/.test(document.querySelector('.rank-pct').textContent) && (() => { const v = [...document.querySelectorAll('.rank-pct')].map((x) => parseInt(x.textContent)); return Math.max(...v) - Math.min(...v) <= 1; })());
  await waitSaved();
  rows = await dbRank();
  assert(expectW(1) && Number((await sql`select value from app_settings where key = 'falloff'`)[0].value) === 1, 'Even gives every topic the same weight');
  await p.click('.falloff button:has-text("Smooth")');
  await p.waitForFunction(() => document.querySelectorAll('.rank-pct')[0].textContent !== document.querySelectorAll('.rank-pct')[1].textContent);
  await waitSaved();
  rows = await dbRank();
  assert(expectW(0.8), 'back to Smooth');

  // Drag the first topic's handle below the second with the mouse.
  const before = await rankNames();
  const hb = await p.locator('.rank-list .row').nth(0).locator('.rank-handle').boundingBox();
  const r1 = await p.locator('.rank-list .row').nth(1).boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await p.mouse.down();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 20, { steps: 3 });
  await p.mouse.move(hb.x + hb.width / 2, r1.y + r1.height * 0.9, { steps: 6 });
  await p.mouse.up();
  await p.waitForFunction((n) => document.querySelectorAll('.rank-list .row .title')[1]?.firstChild.textContent === n, before[0]);
  await waitSaved();
  rows = await dbRank();
  assert(rows[0].name === before[1] && rows[1].name === before[0] && expectW(0.8), 'dragging a handle reorders and saves positions and weights');
  assert(p.url().endsWith('#/settings/topics'), 'a drag does not open the topic page');

  console.log('settings: topic page');
  await p.click(`.rank-list .row[data-id="${(await sql`select id from topics where name = 'Russian'`)[0].id}"] .title`);
  await p.waitForSelector('.page-title:text-is("Russian")');
  assert(p.url().includes('#/settings/topic/'), 'tapping a row opens its topic page');
  await p.waitForFunction(() => document.querySelectorAll('.bulk-toolbar').length === 2).catch(() => {});
  assert((await p.$$('.bulk-toolbar')).length === 1 && (await p.$$eval('.section-h', (h) => h.map((x) => x.textContent))).join() === 'Topic settings,Sources', 'an articles topic page has only the Sources section');
  const russianSources = await sql`select name from sources where topic_id = (select id from topics where name = 'Russian')`;
  assert((await p.$$eval('.bulk-list .row .title', (t) => t.map((x) => x.textContent))).includes(russianSources[0].name), 'sources of this topic are listed');
  assert(!(await p.$('.bulk-chips .chip:has-text("Topic")')), 'there is no topic filter on a topic page');
  await shot('topic-page');
  await p.click('.row:has(.title:text-is("Russian")) .btn:has-text("Edit")');
  assert((await p.textContent('.sheet .kind-fixed')) === 'Articles' && !(await p.$('.sheet [role=radiogroup]')) && !(await p.$('.sheet input[type=range]')), 'an existing topic shows its kind read-only and has no articles ratio');
  await p.click('.sheet-head [data-close]');
  await p.click('.reader-back');
  await p.waitForSelector('.rank-list');
  await p.click(`.rank-list .row[data-id="${(await sql`select id from topics where name = 'Russian practice'`)[0].id}"] .title`);
  await p.waitForSelector('.page-title:text-is("Russian practice")');
  await p.waitForSelector('.bulk-toolbar');
  assert((await p.$$('.bulk-toolbar')).length === 1 && (await p.$$eval('.section-h', (h) => h.map((x) => x.textContent))).join() === 'Topic settings,Card types', 'a cards topic page has only the Card types section');
  await p.click('.bulk-list >> text=+ Add card type');
  assert((await p.$$eval('.sheet select', (ss) => ss.find((s) => s.closest('.field')?.textContent.startsWith('Topic'))?.innerText.split('\n').sort().join())) === 'Guitar practice,Piano practice,Russian practice', 'a card type can only be placed in card topics');
  await p.click('.sheet-head [data-close]');
  await shot('card-topic-page');
  await p.click('.reader-back');
  await p.waitForSelector('.rank-list');

  await p.click('.rank-list .row:has-text("AI") .title');
  await p.waitForSelector('.page-title:text-is("AI")');
  await p.waitForSelector('.bulk-toolbar');
  await p.click('.list >> nth=1 >> text=+ Add source');
  await p.fill('.sheet .field:has-text("Feed URL") input', feedUrl);
  await p.click('.sheet button:has-text("Preview")');
  await p.waitForFunction(() => document.querySelector('.preview')?.textContent.match(/pass your filters|rror|failed/i), null, { timeout: 15000 })
    .catch(() => {});
  console.log('    preview says:', (await p.textContent('.preview')).slice(0, 160));
  assert((await p.textContent('.preview')).includes('Running a 7B model'), 'source preview runs the fetcher');
  await shot('preview');
  await p.click('.sheet .btn.primary');
  await p.waitForSelector('.toast.show:has-text("new from")');
  const [src] = await sql`select s.*, t.name as topic from sources s join topics t on t.id = s.topic_id where config->>'url' = ${feedUrl}`;
  assert(src && src.name === '127.0.0.1' && src.enabled === true && src.topic === 'AI', 'new source saved in this topic with a default name, enabled');
  const [fetched] = await sql`select count(*)::int n from items where source_id = ${src.id}`;
  assert(fetched.n === 1, 'a new source is fetched immediately');
  assert(p.url().includes('#/settings/topic/') && (await p.isVisible('.page-title:text-is("AI")')), 'saving stays on the topic page');
  await p.click('.row:has-text("127.0.0.1")');
  await p.click('.sheet button:has-text("Fetch now")');
  await p.waitForFunction(() => /^\d+ new$/.test(document.querySelector('.toast.show')?.textContent || ''));
  const toastText = await p.textContent('.toast');
  assert(toastText.includes('0 new'), `fetch now works and de-duplicates (toast: ${toastText})`);
  await p.click('.sheet-head [data-close]');

  console.log('bulk management');
  const sourceBox = '.bulk-toolbar >> nth=0';
  await p.fill('.bulk-search >> nth=0', 'hacker');
  const hackerIds = (await sql`select s.id from sources s join topics t on t.id = s.topic_id where t.name = 'AI' and s.name ilike '%hacker%'`).map((r) => r.id);
  await p.waitForFunction((n) => document.querySelector('.bulk-count')?.textContent.startsWith(n + ' of'), hackerIds.length);
  assert(hackerIds.length >= 1, 'search narrows the source list');
  await p.click('.bulk-select >> nth=0');
  await p.click('text=Select all shown >> nth=0');
  assert((await p.textContent('.bulk-bar-n')).startsWith(`${hackerIds.length} selected`), 'select all shown selects the matches');
  await p.click('.bulk-actions >> text=Move to topic…');
  assert((await p.$$eval('#sheet .row .title', (t) => t.map((x) => x.textContent))).sort().join() === 'AI,Guitar,Piano,Russian', `Move to topic lists only article topics (${(await p.$$eval('#sheet .row .title', (t) => t.map((x) => x.textContent))).join()})`);
  await p.click('.sheet-head [data-close]');
  await shot('bulk-select');
  await p.click('.bulk-actions >> text=Turn off');
  await p.waitForSelector('.toast.show:has-text("Turned off")');
  await p.waitForTimeout(400);
  const [offN] = await sql`select count(*)::int n from sources where id = any(${hackerIds}) and not enabled`;
  assert(offN.n === hackerIds.length, 'bulk turn off updates every selected source');
  assert((await p.inputValue('.bulk-search >> nth=0')) === 'hacker' && !(await p.$('.bulk-bar:not([hidden])')), 'search is kept and selection mode ends after a bulk action');
  await p.click('.bulk-select >> nth=0');
  await p.click('text=Select all shown >> nth=0');
  await p.click('.bulk-actions >> text=Turn on');
  await p.waitForTimeout(600);
  const [offAfter] = await sql`select count(*)::int n from sources where id = any(${hackerIds}) and not enabled`;
  assert(offAfter.n === 0, 'bulk turn on restores them');
  await p.fill('.bulk-search >> nth=0', '');

  console.log('domains');
  await p.click('a[data-tab=settings]');
  await p.click('.seg button:has-text("Domains")');
  await p.waitForSelector('.row[data-domain="sample.test"]');
  const domDesc = await p.textContent('.row[data-domain="sample.test"] .desc');
  assert(/\d+ unread · 4 total · 👍\d+ 👎\d+/.test(domDesc), `domains tab lists a domain with counts (${domDesc})`);
  await shot('domains');
  await p.click('button[aria-label="Mute sample.test"]');
  await p.waitForSelector('button[aria-label="Unmute sample.test"]');
  assert((await sql`select count(*)::int n from muted_domains where domain = 'sample.test'`)[0].n === 1, 'muting a domain is stored');
  await p.click('.bulk-chips .chip:has-text("Muted")');
  assert((await p.$$('.row[data-domain]')).length === 1, 'the Muted filter lists only muted domains');
  await p.fill('.bulk-search', 'nothing-like-this');
  await p.waitForSelector('text=No domains match.');
  await p.fill('.bulk-search', '');
  await p.click('button[aria-label="Unmute sample.test"]');
  await p.waitForSelector('.empty:has-text("No domains match")');
  assert((await sql`select count(*)::int n from muted_domains`)[0].n === 0, 'unmuting a domain is stored');
  await p.click('.bulk-chips .chip:has-text("All")');

  console.log('new topic and card type');
  await p.click('.seg button:has-text("Topics")');
  await p.waitForSelector('text=+ Add topic');
  await p.click('text=+ Add topic');
  assert((await p.$$eval('.sheet [role=radio]', (b) => b.map((x) => x.textContent))).join() === 'Articles,Practice cards' && (await p.getAttribute('.sheet [data-kind=articles]', 'aria-checked')) === 'true' && !(await p.$('.sheet input[type=range]')), 'a new topic chooses Articles or Practice cards, with no ratio field');
  await p.fill('.sheet input[type=text]', 'Chess');
  await p.click('.sheet [data-kind=cards]');
  assert((await p.textContent('.sheet small')).includes('Flashcards'), 'the kind choice explains itself');
  await shot('new-topic');
  await p.click('.sheet .btn.primary');
  await p.waitForFunction(() => [...document.querySelectorAll('.rank-list .row .title')].some((t) => t.firstChild.textContent === 'Chess'));
  const titles = await rankNames();
  assert(titles.indexOf('Chess') === 7, 'new topic joins the bottom of the rank');
  rows = await dbRank();
  assert(rows[7].name === 'Chess' && expectW(0.8), 'adding a topic rebalances the weights');
  await p.click('.rank-list .row:has-text("Chess") .title');
  await p.waitForSelector('.page-title:text-is("Chess")');
  await p.waitForSelector('.bulk-toolbar');
  assert((await p.$$eval('.section-h', (h) => h.map((x) => x.textContent))).join() === 'Topic settings,Card types', 'the new cards topic has only Card types');
  await p.click('.bulk-list >> text=+ Add card type');
  await p.selectOption('.sheet select >> nth=0', 'prompts');
  await p.fill('.sheet textarea', 'Learn the Italian opening\nDo 5 tactics puzzles');
  await p.click('.sheet .btn.primary');
  await p.waitForTimeout(500);
  const [gen] = await sql`select g.* from generators g join topics t on t.id = g.topic_id where t.name = 'Chess'`;
  assert(gen?.config?.lines?.includes('Italian'), 'card type created with its config');

  console.log('decks from the card type editor');
  assert((await p.$$('.seg button:has-text("Decks")')).length === 0, 'there is no separate Decks tab');
  await p.click('.bulk-list >> text=+ Add card type');
  await p.selectOption('.sheet select >> nth=0', 'flashcards');
  assert(await p.isDisabled('.sheet .deck-edit'), 'Edit deck is disabled until a deck is chosen');
  await p.fill('.sheet .field:has-text("Name") input[type=text]', 'Opening cards'); // survives the round trip to the deck editor
  await p.click('.sheet .deck-new');
  await p.waitForSelector('#sheet-title:has-text("New deck")');
  await p.fill('.sheet input[type=text]', 'Openings');
  await p.fill('.sheet textarea', 'e4 e5 Nf3 Nc6 Bc4, Italian Game\n"e4 c5", Sicilian Defence, "most popular reply to e4"');
  await p.click('.sheet .btn.primary');
  await p.waitForSelector('#sheet-title:has-text("New card type")');
  const deckCards = await sql`select c.* from cards c join decks d on d.id = c.deck_id where d.name = 'Openings' order by position`;
  assert(deckCards.length === 2 && deckCards[1].note === 'most popular reply to e4', 'deck import parses CSV with quotes');
  const [openings] = await sql`select id from decks where name = 'Openings'`;
  assert((await p.inputValue('.sheet .deck-pick select')) === String(openings.id), 'the new deck is selected when the card type editor reopens');
  assert((await p.inputValue('.sheet .field:has-text("Name") input[type=text]')) === 'Opening cards', 'the unsaved name is kept');
  await shot('card-type-deck');
  await p.click('.sheet .deck-edit');
  await p.waitForSelector('#sheet-title:has-text("Edit deck")');
  await p.waitForSelector('.deck-cards .row:has-text("Italian Game")');
  await p.fill('.sheet textarea', "d4 d5 c4, Queen's Gambit");
  await p.click('.sheet .btn.primary');
  await p.waitForSelector('#sheet-title:has-text("New card type")');
  assert((await sql`select count(*)::int n from cards where deck_id = ${openings.id}`)[0].n === 3, 'editing a deck from the card type editor adds cards');
  await p.click('.sheet .btn.primary:has-text("Save")');
  await p.waitForSelector('.toast.show:has-text("Saved")');
  const [fc] = await sql`select g.* from generators g where g.kind = 'flashcards' and g.name = 'Opening cards'`;
  assert(fc && fc.config.deck_id === Number(openings.id), 'the flashcards card type points at the new deck');

  // A notes card type on the same deck, then removing a scratch deck and returning to the editor.
  await p.click('.bulk-list >> text=+ Add card type');
  await p.selectOption('.sheet select >> nth=0', 'notes');
  await p.selectOption('.sheet .deck-pick select', String(openings.id));
  await p.click('.sheet .btn.primary:has-text("Save")');
  await p.waitForSelector('.toast.show:has-text("Saved")');
  const [nt] = await sql`select * from generators where kind = 'notes'`;
  assert(nt && nt.config.deck_id === Number(openings.id) && Object.keys(nt.config).length === 1, 'a notes card type is saved with just its deck');
  await p.click('.row:has-text("Notes (reading)")');
  await p.click('.sheet .deck-new');
  await p.fill('.sheet input[type=text]', 'Scratch');
  await p.click('.sheet .btn.primary');
  await p.waitForSelector('#sheet-title:has-text("Edit card type")');
  await p.click('.sheet .deck-edit');
  await p.waitForSelector('#sheet-title:has-text("Edit deck")');
  p.once('dialog', (d) => d.accept());
  await p.click('.sheet .btn.danger:has-text("Delete deck")');
  await p.waitForSelector('#sheet-title:has-text("Edit card type")');
  assert((await p.inputValue('.sheet .deck-pick select')) === '' && (await sql`select count(*)::int n from decks where name = 'Scratch'`)[0].n === 0, 'deleting a deck returns to the card type editor with no deck chosen');
  await p.click('.sheet-head [data-close]');

  console.log('hide, show and delete a topic');
  await p.click('.topic-flip');
  await p.waitForSelector('.topic-flip:has-text("Show topic")');
  assert((await sql`select enabled from topics where name = 'Chess'`)[0].enabled === false, 'Hide topic hides it');
  assert((await dbRank()).length === 7 && expectW(0.8), 'hiding a topic rebalances the rest');
  await p.click('.reader-back');
  await p.waitForSelector('.hidden-list .row:has-text("Chess")');
  assert((await rankNames()).indexOf('Chess') === -1, 'a hidden topic leaves the rank');
  await p.waitForSelector('.toast.show', { state: 'hidden' }).catch(() => {});
  await p.locator('.hidden-list').scrollIntoViewIfNeeded();
  await p.evaluate(() => scrollBy(0, 200)); await p.waitForTimeout(200);
  await shot('topics-hidden');
  await p.click('.hidden-list .row:has-text("Chess") button:has-text("Show")');
  await p.waitForFunction(() => [...document.querySelectorAll('.rank-list .row .title')].some((t) => t.firstChild.textContent === 'Chess'));
  assert((await rankNames()).indexOf('Chess') === 7 && (await dbRank())[7].name === 'Chess', 'Show puts it back at the bottom of the rank');
  await p.evaluate(() => { location.hash = '#/settings/topic/999999'; });
  await p.waitForSelector('text=That topic no longer exists.');
  await p.evaluate(() => { location.hash = '#/settings/topics'; });
  await p.waitForSelector('.rank-list');

  await p.click('text=+ Add topic');
  await p.fill('.sheet input[type=text]', 'Scratch topic');
  await p.click('.sheet .btn.primary');
  await p.click('.rank-list .row:has-text("Scratch topic") .title');
  await p.waitForSelector('.page-title:text-is("Scratch topic")');
  await p.waitForSelector('.bulk-toolbar');
  assert((await p.$$eval('.section-h', (h) => h.map((x) => x.textContent))).join() === 'Topic settings,Sources' && (await sql`select kind from topics where name = 'Scratch topic'`)[0].kind === 'articles', 'a new articles topic has only the Sources section');
  await p.click('.bulk-list >> text=+ Add source');
  assert((await p.$$eval('.sheet select', (ss) => ss.find((s) => s.closest('.field')?.textContent.startsWith('Topic'))?.innerText.split('\n').sort().join())) === 'AI,Guitar,Piano,Russian,Scratch topic', 'a source can only be placed in article topics');
  await p.click('.sheet-head [data-close]');
  p.once('dialog', (d) => d.accept());
  await p.click('.btn.danger:has-text("Delete topic")');
  await p.waitForSelector('.rank-list');
  assert((await sql`select count(*)::int n from topics where name = 'Scratch topic'`)[0].n === 0 && expectW(0.8) && (await rankNames()).length === 8, 'Delete topic removes it, returns to Topics and rebalances');

  console.log('old routes');
  for (const old of ['sources', 'cards', 'balance', 'decks', 'nonsense']) {
    await p.evaluate((o) => { location.hash = `#/settings/${o}`; }, old);
    await p.waitForSelector('.rank-list');
    assert(p.url().endsWith('#/settings/topics'), `#/settings/${old} lands on Topics`);
  }

  await p.click('a[data-tab=feed]');
  await pickTopics(p, 'Chess');
  await p.waitForSelector('.k-prompt');
  assert(true, 'new topic and card type appear in the feed');
  await p.waitForSelector('.k-note .note-title');
  assert((await p.textContent('.k-note .meta')).includes('Openings'), 'a notes card shows the deck name and its text');
  await p.waitForSelector('.k-note .act.save');
  await shot('notes-card');

  await p.click('a[data-tab=settings]');
  await p.click('button:has-text("Sign out")');
  await p.waitForSelector('form.login');
  assert(true, 'sign out returns to the sign-in form');

  assert(errors.length === 0, `no browser errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  feedServer.close();
  await sql.end();
  console.log('E2E PASSED');
})().catch(async (e) => { console.error(e.message); process.exit(1); });
