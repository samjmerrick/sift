# Sift on the personal database (bee)

Sift's backend can be your personal database (bee-database, the SQLite store behind `mcp.samjmerrick.com`)
instead of Supabase. The app itself stays on GitHub Pages, unchanged; it just talks to a small server on bee.

- **`bee/server.js`** answers the same HTTP calls as Supabase (the PostgREST subset, password sign-in and the
  `sift-fetch` function) that the app's supabase-js client makes, so `public/` needs no changes: point
  `supabaseUrl` at this server. It keeps the rows in memory for queries (the same in-memory backend as the preview
  build, `preview/mock-backend.js`) and writes every change straight to the SQLite file. Writes made by anything
  else, such as Claude through the Personal database connector, are picked up on the next request. It fetches
  every source hourly, and Settings → Fetch now, Preview and the reader work as before.
- **Storage**: one record per Sift row, in project `sift`, with the table as the collection (`topics`, `sources`,
  `items`, `cards`, ...) and the row itself in `metadata` (`bee/records.js`). So the data is also searchable and
  queryable through the connector, like everything else in the personal database.
- **Sign-in** is one password (`SIFT_PASSWORD`, optionally with `SIFT_EMAIL`). Sessions are signed tokens; ten
  wrong passwords lock sign-in for 15 minutes.

## Setting it up on bee

Needs Node 22.13 or later (for `node:sqlite`) and the path of bee-database's SQLite file (on bee:
`~/services/bee-database/data/mcp.db`). Bee has no system Node; it uses the official tarball in `~/.local/node`
(put `~/.local/node/bin` first on `PATH`, and use `/home/sam/.local/node/bin/node` in the systemd unit).

If cloudflared runs in Docker, point the tunnel at the host's address on the container network (for example
`http://172.19.0.1:8787`), not `localhost`, which is the container itself.

```sh
git clone https://github.com/samjmerrick/sift ~/sift && cd ~/sift && npm ci --omit=dev
export BEE_DB=~/services/bee-database/<path to the .db file>
cp "$BEE_DB" "$BEE_DB.before-sift"     # a backup, just in case

# 1. Copy everything from Supabase. Read-only there, and safe to run again (nothing is added twice).
#    DATABASE_URL is the Supabase "Session pooler" connection string (Project → Connect).
DATABASE_URL='postgres://…' npm run bee:import

# 2. Run the server (as a service, so it survives reboots; see below).
BEE_DB=$BEE_DB SIFT_PASSWORD='…' SIFT_EMAIL='you@example.com' SIFT_ORIGIN='https://samjmerrick.github.io' npm run bee:server
curl localhost:8787/health
```

3. **Give it an HTTPS address.** The GitHub Pages app is served over HTTPS, so the API must be too. Add a hostname
   to the tunnel that already serves `mcp.samjmerrick.com`, for example `sift-api.samjmerrick.com` →
   `http://localhost:8787`.
4. **Point the app at it.** In the repository's Settings → Secrets and variables → Actions → Variables, set
   `SUPABASE_URL` to that address (e.g. `https://sift-api.samjmerrick.com`) and `SUPABASE_ANON_KEY` to any
   non-empty value (e.g. `bee`; it isn't used). Re-run the Deploy workflow. Then sign in on your phone with
   `SIFT_EMAIL` and `SIFT_PASSWORD`.

A systemd unit, as `~/.config/systemd/user/sift.service` (then `systemctl --user enable --now sift`):

```ini
[Unit]
Description=Sift API on the personal database
After=network-online.target

[Service]
WorkingDirectory=%h/sift
Environment=BEE_DB=%h/services/bee-database/<path to the .db file>
Environment=SIFT_EMAIL=you@example.com
Environment=SIFT_ORIGIN=https://samjmerrick.github.io
EnvironmentFile=%h/.config/sift.env
ExecStart=/usr/bin/env node bee/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

with `SIFT_PASSWORD=…` in `~/.config/sift.env` (`chmod 600`). For the unit to run while you're logged out:
`loginctl enable-linger $USER`.

Other settings: `PORT` (default 8787), `SIFT_FETCH_MINUTES` (default 60; 0 turns the hourly fetch off, and then
`node bee/fetch.js` from cron does the same job).

## Retiring Supabase

Once the app has worked on bee for a while: unschedule the Supabase cron job
(`select cron.unschedule('sift-fetch');`), then pause or delete the Supabase project. Nothing here deletes
anything in Supabase.

## Testing

`npm run preview && node test/bee.e2e.mjs` imports the preview's sample data into a throwaway copy of the
bee-database schema, starts `bee/server.js`, and runs the real app in Chromium against it: sign-in and access
control, the feed, saving reactions and seen state, adding and fetching a source, the reader, updates and cascading
deletes, outside writes being picked up, reload, and `bee/fetch.js`.
