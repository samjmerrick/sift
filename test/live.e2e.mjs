// End-to-end check of the live artifact build (dist/sift.html) and the bee scripts, on a throwaway copy of the
// personal database's schema. The artifact's "Personal database" connector is stood in for by a Node function
// with the same tools (query_sql, store, update, delete) over that SQLite file.
//
//   npm run preview && npm run build:live && node test/live.e2e.mjs
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const { chromium } = createRequire(import.meta.url)('playwright'); // pre-installed globally, as for test/e2e.cjs

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'sift-live-'));
const dbPath = join(dir, 'bee.db');
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(readFileSync(join(root, 'test/fixtures/bee-schema.sql'), 'utf8'));
const env = { ...process.env, BEE_DB: dbPath };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 1. Sample data: the preview build's in-memory tables, imported with bee/import-supabase.js --json.
await page.goto(`file://${root}dist/sift-preview.local.html`);
await page.waitForFunction(() => window.SIFT_PREVIEW?.db?.tables?.items?.length > 0);
const tables = await page.evaluate(() => window.SIFT_PREVIEW.db.tables);
writeFileSync(join(dir, 'seed.json'), JSON.stringify(tables));
console.log(execFileSync('node', [join(root, 'bee/import-supabase.js'), '--json', join(dir, 'seed.json')], { env, encoding: 'utf8' }));
const again = execFileSync('node', [join(root, 'bee/import-supabase.js'), '--json', join(dir, 'seed.json')], { env, encoding: 'utf8' });
assert.match(again, /topics\s+0 added/, 'a second import adds nothing');

// 2. The fake connector.
const meta = (collection, field, value) => sqlite.prepare(
  `SELECT id, metadata FROM records WHERE project='sift' AND collection=? AND json_extract(metadata, '$.' || ?) = ?`).all(collection, field, value);
let calls = 0;
function tool(name, input) {
  calls++;
  const now = new Date().toISOString();
  if (name === 'query_sql') {
    assert.match(input.sql, /^\s*SELECT/i);
    const stmt = sqlite.prepare(input.sql);
    const rows = stmt.all(...(input.params || []));
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.map((r) => columns.map((c) => r[c])), truncated: false };
  }
  if (name === 'store') {
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    sqlite.prepare('INSERT INTO records (id, project, collection, title, content, tags, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.project, input.collection, input.title || '', input.content, JSON.stringify(input.tags || []), JSON.stringify(input.metadata || {}), now, now);
    return { id, project: input.project, collection: input.collection, title: input.title };
  }
  if (name === 'update') {
    const r = sqlite.prepare('SELECT metadata FROM records WHERE id = ?').get(input.id);
    if (!r) throw new Error(`No record ${input.id}`);
    const m = JSON.parse(r.metadata);
    for (const [k, v] of Object.entries(input.metadata || {})) if (v === null) delete m[k]; else m[k] = v;
    sqlite.prepare('UPDATE records SET metadata = ?, title = coalesce(?, title), content = coalesce(?, content), updated_at = ? WHERE id = ?')
      .run(JSON.stringify(m), input.title ?? null, input.content ?? null, now, input.id);
    return { id: input.id };
  }
  if (name === 'delete') { sqlite.prepare('DELETE FROM records WHERE id = ?').run(input.id); return { deleted: true }; }
  throw new Error(`unknown tool ${name}`);
}
await page.exposeFunction('__beeTool', (name, input) => {
  try { return { ok: tool(name, input) }; } catch (e) { return { error: e.message }; }
});
await page.addInitScript(() => {
  const mcp = {
    async callTool(server, name, input) {
      if (server !== 'Personal database') throw Object.assign(new Error('not connected'), { code: 'server_not_connected' });
      const r = await window.__beeTool(name, input);
      if (r.error) throw Object.assign(new Error(r.error), { code: 'tool_error' });
      return { payload: r.ok };
    },
  };
  window.claude = { use: async (n) => (n === 'mcp' ? mcp : null) };
});

// 3. Open the live build: the feed loads from the database.
const live = `file://${root}dist/sift.local.html`;
await page.goto(live);
await page.waitForSelector('.card', { timeout: 15000 });
const firstTitle = await page.locator('.card h3').first().textContent();
console.log('feed loaded; first card:', firstTitle?.trim().slice(0, 60), '| connector calls:', calls);

// Seeing a card is saved (seen_at), and so is a thumbs-up.
await page.mouse.wheel(0, 3000);
await page.waitForTimeout(1500);
const up = page.locator('button[aria-label="More like this"]').first();
if (await up.count()) { await up.click(); await page.waitForTimeout(800); }
await page.waitForFunction(() => window.SIFT_LIVE.sync.pending === 0, null, { timeout: 15000 });
const seen = sqlite.prepare("SELECT count(*) AS n FROM records WHERE collection='items' AND json_extract(metadata,'$.seen_at') IS NOT NULL").get().n;
const liked = sqlite.prepare("SELECT count(*) AS n FROM records WHERE collection='items' AND json_extract(metadata,'$.reaction') = 1").get().n;
console.log('items marked seen in the database:', seen, '| liked:', liked);
assert.ok(seen > 0, 'seen_at reaches the database');

// 4. Settings → add a starter pack: new topics, sources and generators are stored as records.
const topicsBefore = sqlite.prepare("SELECT count(*) AS n FROM records WHERE collection='topics'").get().n;
await page.evaluate(async () => {
  const client = window.supabase.createClient('https://live.sift.local', 'live');
  await client.from('topics').insert({ name: 'Live test topic', color: '#123456', position: 99, kind: 'articles' });
  await client.from('muted_domains').insert({ domain: 'example-muted.com' });
});
await page.waitForFunction(() => window.SIFT_LIVE.sync.pending === 0, null, { timeout: 15000 });
assert.equal(sqlite.prepare("SELECT count(*) AS n FROM records WHERE collection='topics'").get().n, topicsBefore + 1);
const stored = meta('topics', 'name', 'Live test topic')[0];
assert.ok(stored, 'new topic stored');
const newId = JSON.parse(stored.metadata).id;
assert.ok(newId > 0, 'new topic keeps a numeric id');

// Update then delete it (and a topic with sources and items: the cascade deletes their records too).
await page.evaluate(async (id) => {
  const client = window.supabase.createClient('https://live.sift.local', 'live');
  await client.from('topics').update({ name: 'Renamed live topic' }).eq('id', id);
}, newId);
await page.waitForFunction(() => window.SIFT_LIVE.sync.pending === 0);
assert.equal(JSON.parse(meta('topics', 'id', newId)[0].metadata).name, 'Renamed live topic');
const victim = JSON.parse(sqlite.prepare("SELECT metadata FROM records WHERE collection='topics' AND json_extract(metadata,'$.kind')='articles' ORDER BY n LIMIT 1").get().metadata);
const victimItems = meta('items', 'topic_id', victim.id).length;
await page.evaluate(async (ids) => {
  const client = window.supabase.createClient('https://live.sift.local', 'live');
  await client.from('topics').delete().in('id', ids);
}, [newId, victim.id]);
await page.waitForFunction(() => window.SIFT_LIVE.sync.pending === 0, null, { timeout: 30000 });
assert.equal(meta('topics', 'id', newId).length, 0);
assert.equal(meta('items', 'topic_id', victim.id).length, 0, `cascade removed ${victimItems} items`);
console.log(`deleted topic "${victim.name}" and its ${victimItems} articles from the database`);

// 5. Reload: what was saved comes back.
await page.goto(live);
await page.waitForSelector('.card', { timeout: 15000 });
const reloaded = await page.evaluate(() => ({
  muted: window.SIFT_LIVE.db.tables.muted_domains.map((m) => m.domain),
  topics: window.SIFT_LIVE.db.tables.topics.length,
  seen: window.SIFT_LIVE.db.tables.items.filter((i) => i.seen_at).length,
}));
console.log('after reload:', reloaded);
assert.ok(reloaded.muted.includes('example-muted.com'));
assert.ok(reloaded.seen > 0);

// 6. Settings and the reader open without errors.
await page.goto(`${live}#/settings`);
await page.waitForTimeout(1500);
await page.screenshot({ path: join(dir, 'settings.png') });

// 7. bee/fetch.js runs against the same file (sources may fail offline; it must record that, not crash).
let out = '';
try { out = execFileSync('node', [join(root, 'bee/fetch.js')], { env: { ...env, SIFT_READER_PER_RUN: '3' }, encoding: 'utf8', timeout: 240000 }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
console.log(out.split('\n').slice(-4).join('\n'));
assert.match(out, /new, .* summaries checked/);

console.log('page errors:', errors.length ? errors : 'none', '| dir:', dir);
assert.equal(errors.length, 0);
await browser.close();
console.log('live e2e passed');
