// One fetch run for Sift on bee, from the command line: every enabled source, missing summaries, housekeeping.
// bee/server.js already does this every hour, so this is for a manual run (or cron, if you don't run the server).
//
//   BEE_DB=/path/to/bee-database.db node bee/fetch.js
import { openBee } from './store.js';
import { fetchAll } from './jobs.js';

const bee = openBee();
try {
  const { results, summaries, removed } = await fetchAll(bee);
  let errors = 0;
  for (const [name, r] of Object.entries(results)) {
    if (r.error) errors++;
    console.log(`${name.padEnd(28)} ${r.error ? `ERROR: ${r.error}` : `+${r.added}`}`);
  }
  const added = Object.values(results).reduce((s, r) => s + r.added, 0);
  console.log(`${new Date().toISOString()}  ${added} new, ${summaries} summaries checked, ${removed} old removed`);
  if (errors && errors === Object.keys(results).length) process.exitCode = 1;
} finally {
  bee.close();
}
