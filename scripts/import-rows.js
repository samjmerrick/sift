// One-off helpers for moving Sift's rows into the app on Cloudflare (POST /sift/_bee/import, with the runner token).
export const TABLES = ['topics', 'sources', 'generators', 'decks', 'cards', 'items', 'saved_cards', 'muted_domains', 'app_settings', 'item_content'];

/** Replace everything in the app with `data` ({ table: [rows] }). Sends in requests of about 150 KB. */
export async function pushAll(url, token, data, log = console.log) {
  const post = async (body) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/_bee/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`import: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  await post({ reset: true });
  for (const table of TABLES) {
    const rows = data[table] ?? [];
    let sent = 0;
    for (let batch = [], size = 0, i = 0; i <= rows.length; i++) {
      const row = rows[i];
      const bytes = row ? JSON.stringify(row).length : 0;
      if ((!row || size + bytes > 150_000 || batch.length >= 100) && batch.length) { await post({ table, rows: batch }); sent += batch.length; batch = []; size = 0; }
      if (row) { batch.push(row); size += bytes; }
    }
    log(`${table}: ${sent} rows`);
  }
}
