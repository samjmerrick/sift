// The queue between the Worker and the runner on bee. The Worker adds a job and waits for it; the runner claims
// jobs with a long poll, does the slow work (fetching feeds, reading articles) and posts the result.
const LEASE_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Queue a job and wait (politely: D1 allows 50 queries per request) for its result. */
export async function runJob(db, kind, input, { waitMs = 40_000 } = {}) {
  const { results } = await db.prepare('INSERT INTO jobs (kind, input, created_at) VALUES (?, ?, ?) RETURNING id')
    .bind(kind, JSON.stringify(input), iso()).all();
  const id = results[0].id;
  const until = Date.now() + waitMs;
  for (let delay = 400; Date.now() < until; delay = Math.min(delay * 1.5, 2500)) {
    await sleep(delay);
    const job = await db.prepare('SELECT status, result, error FROM jobs WHERE id = ?').bind(id).first();
    if (job.status === 'done') return { ok: true, result: JSON.parse(job.result) };
    if (job.status === 'failed') return { ok: false, error: job.error || 'The job failed' };
  }
  return { ok: false, error: 'Still working in the background (is the fetcher on bee running?). Try again shortly.', timedOut: true };
}

/** Claim the oldest waiting job (or one whose runner went quiet), waiting up to `waitMs` for one to appear. */
export async function claim(db, waitMs = 15_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const { results } = await db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?1
        WHERE id = (SELECT id FROM jobs WHERE (status = 'pending' OR (status = 'running' AND lease_until < ?2)) AND attempts < 3 ORDER BY id LIMIT 1)
        RETURNING id, kind, input`).bind(iso(Date.now() + LEASE_MS), iso()).all();
    if (results[0]) return { id: results[0].id, kind: results[0].kind, input: JSON.parse(results[0].input) };
    if (Date.now() + 1500 > until) return null;
    await sleep(1500);
  }
}

export async function finish(db, id, { result, error }) {
  await db.prepare(`UPDATE jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
    .bind(error ? 'failed' : 'done', error ? null : JSON.stringify(result ?? null), error ?? null, iso(), id).run();
}

/** Housekeeping: finished jobs older than a day, and jobs that ran out of attempts. */
export async function tidy(db) {
  await db.batch([
    db.prepare(`UPDATE jobs SET status = 'failed', error = 'The runner never finished this', finished_at = ?1 WHERE status = 'running' AND lease_until < ?1 AND attempts >= 3`).bind(iso()),
    db.prepare('DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?').bind(iso(Date.now() - 86400000)),
  ]);
}
