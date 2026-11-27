// One-off, run on bee: copy Sift's rows from bee-database (where the old Sift on bee keeps them) into the Sift app
// on Cloudflare, replacing what is there. Stop the old Sift first so nothing changes while this runs.
//   DB_TOKEN=… DB_URL=http://mcp-db:8000 SIFT_URL=https://apps.samjmerrick.com/sift RUNNER_TOKEN=… node scripts/export-bee.js
import { createDbClient } from '../bee/dbclient.js';
import { openBee } from '../bee/store.js';
import { pushAll, TABLES } from './import-rows.js';
import { PROJECT } from '../bee/records.js';

const { SIFT_URL, RUNNER_TOKEN } = process.env;
if (!SIFT_URL || !RUNNER_TOKEN) throw new Error('Set SIFT_URL and RUNNER_TOKEN');
const db = createDbClient();
const bee = await openBee(db);
const data = {};
for (const t of TABLES) if (t !== 'item_content') data[t] = bee.rows(t);
data.item_content = [];
for (let offset = 0; ; offset += 50) {
  const page = await db.call('list_records', { project: PROJECT, collection: 'item_content', include_metadata: true, limit: 50, offset });
  data.item_content.push(...page.results.map((r) => r.metadata));
  if (offset + 50 >= page.total || !page.results.length) break;
}
console.log(Object.fromEntries(TABLES.map((t) => [t, data[t].length])));
await pushAll(SIFT_URL, RUNNER_TOKEN, data);
await bee.close();
