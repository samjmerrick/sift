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
  p.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && errors.push(`console: ${m.text()}`));
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
  for (const name of ['AI & machine learning', 'Russian', 'Guitar', 'Piano & music theory']) {
    await p.click(`.sheet .row:has-text("${name}") button`);
    await p.waitForSelector(`.sheet .row:has-text("${name}") button:has-text("Added")`);
  }
  const [counts] = await sql`select (select count(*) from topics)::int t, (select count(*) from cards)::int c, (select count(*) from generators)::int g`;
  assert(counts.t === 4 && counts.c === 90 && counts.g === 9, `starter packs install topics, deck and card types (${JSON.stringify(counts)})`);
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

  await p.click('.chip:has-text("Russian")');
  await p.waitForSelector('.k-flashcard .reveal');
  await p.click('.k-flashcard .reveal');
  await p.click('.k-flashcard .grade .good');
  await p.waitForSelector('.k-flashcard .graded');
  const [studied] = await sql`select count(*)::int n from cards where due is not null and introduced_at is not null`;
  assert(studied.n === 1, 'grading a flashcard schedules it in the database');

  await p.click('.chip:has-text("All")');
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
  await p.waitForSelector('.k-prompt, .k-quiz, .k-guitar_chord, .k-keyboard, .k-fretboard, .k-ear');
  await p.click('.card:not(.k-article):not(.k-flashcard) .act.save');
  await p.waitForSelector('.toast.show:has-text("Saved")');

  await p.click('a[data-tab=saved]');
  await p.waitForSelector('.saved-list .card');
  const savedCount = await p.$$eval('.saved-list .card', (c) => c.length);
  assert(savedCount === 2, `saved view shows the saved article and practice card (${savedCount})`);

  console.log('settings');
  await p.click('a[data-tab=settings]');
  await p.waitForSelector('.row');
  await shot('sources');
  await p.click('.list >> nth=0 >> text=+ Add source');
  await p.fill('.sheet .field:has-text("Feed URL") input', feedUrl);
  await p.click('.sheet button:has-text("Preview")');
  await p.waitForFunction(() => document.querySelector('.preview')?.textContent.match(/pass your filters|rror|failed/i), null, { timeout: 15000 })
    .catch(() => {});
  console.log('    preview says:', (await p.textContent('.preview')).slice(0, 160));
  assert((await p.textContent('.preview')).includes('Running a 7B model'), 'source preview runs the fetcher');
  await shot('preview');
  await p.click('.sheet .btn.primary');
  await p.waitForSelector('.toast.show:has-text("new from")');
  const [src] = await sql`select * from sources where config->>'url' = ${feedUrl}`;
  assert(src && src.name === '127.0.0.1' && src.enabled === true, 'new source saved with a default name, enabled');
  const [fetched] = await sql`select count(*)::int n from items where source_id = ${src.id}`;
  assert(fetched.n === 1, 'a new source is fetched immediately');
  await p.click('.row:has-text("127.0.0.1")');
  await p.click('.sheet button:has-text("Fetch now")');
  await p.waitForFunction(() => /^\d+ new$/.test(document.querySelector('.toast.show')?.textContent || ''));
  const toastText = await p.textContent('.toast');
  assert(toastText.includes('0 new'), `fetch now works and de-duplicates (toast: ${toastText})`);
  await p.click('.sheet-head [data-close]');

  await p.click('.seg button:has-text("Topics")');
  await p.waitForSelector('text=+ Add topic');
  await p.click('text=+ Add topic');
  await p.fill('.sheet input[type=text]', 'Chess');
  await p.click('.sheet .btn.primary');
  await p.waitForTimeout(500);
  const titles = await p.$$eval('.row .title', (t) => t.map((x) => x.textContent));
  assert(titles.indexOf('Chess') === 4, 'new topic is added at the end');

  await p.click('.seg button:has-text("Card types")');
  await p.waitForSelector('.section-h:has-text("Chess")');
  await p.click('.section-h:has-text("Chess") + .list >> text=+ Add card type');
  await p.selectOption('.sheet select >> nth=0', 'prompts');
  await p.fill('.sheet textarea', 'Learn the Italian opening\nDo 5 tactics puzzles');
  await p.click('.sheet .btn.primary');
  await p.waitForTimeout(500);
  const [gen] = await sql`select g.* from generators g join topics t on t.id = g.topic_id where t.name = 'Chess'`;
  assert(gen?.config?.lines?.includes('Italian'), 'card type created with its config');

  await p.click('.seg button:has-text("Decks")');
  await p.waitForSelector('text=+ New deck');
  await p.click('text=+ New deck');
  await p.fill('.sheet input[type=text]', 'Openings');
  await p.fill('.sheet textarea', 'e4 e5 Nf3 Nc6 Bc4, Italian Game\n"e4 c5", Sicilian Defence, "most popular reply to e4"');
  await p.click('.sheet .btn.primary');
  await p.waitForTimeout(600);
  const deckCards = await sql`select c.* from cards c join decks d on d.id = c.deck_id where d.name = 'Openings' order by position`;
  assert(deckCards.length === 2 && deckCards[1].note === 'most popular reply to e4', 'deck import parses CSV with quotes');
  await shot('decks');

  await p.click('a[data-tab=feed]');
  await p.click('.chip:has-text("Chess")');
  await p.waitForSelector('.k-prompt');
  assert(true, 'new topic and card type appear in the feed');

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
