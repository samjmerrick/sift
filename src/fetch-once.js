// Run a single fetch of all sources from the command line: `npm run fetch`
import { openDb } from './db.js';
import { fetchAll } from './fetcher.js';

const db = openDb();
const results = await fetchAll(db);
for (const [name, r] of Object.entries(results)) console.log(`${name.padEnd(28)} ${r.error ? `ERROR: ${r.error}` : `+${r.added}`}`);
