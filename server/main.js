// Runs Sift: the web server, the timed fetch and a daily backup.
//   DATA_DIR            where sift.db, backups/ and the cookie secret live (default ./data)
//   SIFT_EMAILS         comma-separated addresses allowed to sign in
//   PB_URL              the platform's PocketBase (default http://pocketbase:8090)
//   PORT                default 8000
//   SIFT_FETCH_MINUTES  how often to fetch every source; default 60, 0 turns it off
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './index.js';
import { createAuth, sessionSecret } from './auth.js';
import { makeFetcher } from '../fetch/handlers.js';

const { DATA_DIR = 'data', SIFT_EMAILS = '', PB_URL = 'http://pocketbase:8090', PORT = '8000' } = process.env;
const FETCH_MINUTES = Number(process.env.SIFT_FETCH_MINUTES ?? 60);
const KEEP_BACKUPS = 3;

const backups = join(DATA_DIR, 'backups');
mkdirSync(backups, { recursive: true });
const db = openDb(join(DATA_DIR, 'sift.db'));
const auth = createAuth({ secret: sessionSecret(join(DATA_DIR, 'session-secret')), emails: SIFT_EMAILS.split(','), pbUrl: PB_URL });
const fetcher = makeFetcher(db);
const handle = createApp({ db, auth, fetcher });
if (!SIFT_EMAILS) console.warn('SIFT_EMAILS is empty: nobody can sign in');

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') return res.writeHead(200).end('ok');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 20_000_000) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    const out = await handle(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"message":"Something went wrong"}');
  }
});
server.listen(Number(PORT), () => console.log(`Sift on :${PORT}`));

/** One dated copy a day, keeping the newest few. */
function backup() {
  try {
    const file = join(backups, `sift-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.db`);
    if (!existsSync(file)) db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    for (const old of readdirSync(backups).filter((f) => /^sift-\d{8}\.db$/.test(f)).sort().slice(0, -KEEP_BACKUPS)) rmSync(join(backups, old));
  } catch (e) { console.error('backup failed', e); }
}
setTimeout(backup, 60_000);
setInterval(backup, 3600_000);

async function timed() {
  try {
    const { results, summaries, removed } = await fetcher.scheduled();
    const added = Object.values(results).reduce((s, r) => s + r.added, 0);
    const errors = Object.values(results).filter((r) => r.error).length;
    console.log(`${new Date().toISOString()} fetch: ${added} new from ${Object.keys(results).length} sources (${errors} failed), ${summaries} summaries, ${removed} removed`);
  } catch (e) { console.error('fetch failed', e); }
}
if (FETCH_MINUTES > 0) { setTimeout(timed, 30_000); setInterval(timed, FETCH_MINUTES * 60_000); }

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { db.close(); process.exit(0); });
