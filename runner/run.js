// The fetcher for Sift on Cloudflare. It asks the app for work (a long poll), does it here (fetching feeds and
// articles needs more CPU than a Worker gets on the free plan), and sends the results back. It also fetches every
// source on a timer.
//
//   SIFT_URL           the app's address, e.g. https://apps.samjmerrick.com/sift
//   RUNNER_TOKEN       the app's runner secret (the same value as the app's RUNNER_TOKEN secret)
//   SIFT_FETCH_MINUTES how often to fetch every source; default 60, 0 turns it off
import { makeHandlers } from './handlers.js';
import { fetchAll } from './jobs.js';
import { openRemote } from './store.js';

const { SIFT_URL, RUNNER_TOKEN } = process.env;
if (!SIFT_URL || !RUNNER_TOKEN) { console.error('Set SIFT_URL and RUNNER_TOKEN'); process.exit(1); }
const FETCH_MINUTES = process.env.SIFT_FETCH_MINUTES == null ? 60 : Number(process.env.SIFT_FETCH_MINUTES);
const store = openRemote({ url: SIFT_URL, token: RUNNER_TOKEN });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One piece of work at a time, so the in-memory rows never interleave.
let chain = Promise.resolve();
const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

const handlers = makeHandlers(store);

async function work() {
  for (let failures = 0; ;) {
    try {
      const job = await store.call('/_bee/jobs?wait=15');
      failures = 0;
      if (!job) continue;
      try {
        const result = await exclusive(() => handlers[job.kind]?.(job.input) ?? Promise.reject(new Error(`unknown job ${job.kind}`)));
        await store.call(`/_bee/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ result }) });
      } catch (e) {
        console.error(`job ${job.id} (${job.kind}) failed:`, e);
        await store.call(`/_bee/jobs/${job.id}`, { method: 'POST', body: JSON.stringify({ error: String(e?.message || e).slice(0, 500) }) }).catch(() => {});
      }
    } catch (e) {
      console.warn(`waiting for the app (${e.message})`);
      await sleep(Math.min(2000 * ++failures, 30_000));
    }
  }
}

async function hourly() {
  try {
    const { results, summaries, removed } = await exclusive(async () => { await store.load(); return fetchAll(store); });
    const added = Object.values(results).reduce((s, r) => s + r.added, 0);
    const errors = Object.values(results).filter((r) => r.error).length;
    console.log(`${new Date().toISOString()} fetch: ${added} new from ${Object.keys(results).length} sources (${errors} failed), ${summaries} summaries, ${removed} removed`);
  } catch (e) { console.error('fetch failed', e); }
}

console.log(`Sift runner for ${SIFT_URL}`);
work();
if (FETCH_MINUTES > 0) { setTimeout(hourly, 30_000); setInterval(hourly, FETCH_MINUTES * 60_000); }
