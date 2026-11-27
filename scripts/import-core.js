// Copy Sift's rows from the shared core database (the `sift` project's records) into the Sift app.
//   SIFT_URL=https://apps.samjmerrick.com/sift RUNNER_TOKEN=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/import-core.js
import { pushAll, TABLES } from './import-rows.js';

const { SIFT_URL, RUNNER_TOKEN, CLOUDFLARE_API_TOKEN: CF, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CORE_DB = '0a25647c-bde7-4780-811c-f38521e4e9fe' } = process.env;
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${CORE_DB}/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${CF}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: "SELECT collection, metadata FROM records WHERE project = 'sift'" }),
});
const body = await res.json();
if (!body.success) throw new Error(JSON.stringify(body.errors));
const data = Object.fromEntries(TABLES.map((t) => [t, []]));
for (const r of body.result[0].results) data[r.collection]?.push(typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);
await pushAll(SIFT_URL, RUNNER_TOKEN, data);
