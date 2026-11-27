# Sift on bee

Sift can run entirely on a home server next to [bee-database](https://github.com/samjmerrick/bee-database), at
`https://home.samjmerrick.com/sift`, set up the same way as [Nibble](https://github.com/samjmerrick/nibble): its own
container, data stored in bee-database through its MCP endpoint, and people signed in by bee-database. The Supabase +
GitHub Pages build described in the main README still works from the same `public/` code.

| Piece | Where |
|---|---|
| HTTP server: the app at `/sift`, the API it calls, sign-in check, hourly fetch | `bee/server.js` |
| Database client (MCP, service token) | `bee/dbclient.js` |
| Sift's rows in the database, mirrored in memory | `bee/store.js`, `bee/records.js` |
| Fetching and reader text | `bee/jobs.js`, `supabase/functions/_shared/` |
| One-off copy from Supabase | `bee/import-supabase.js` |

- **API**: the same calls as Supabase (the PostgREST subset and the `sift-fetch` function) that the app's
  supabase-js client makes, under `/sift/rest/v1` and `/sift/functions/v1`. Queries are answered from memory by the
  preview build's backend (`preview/mock-backend.js`).
- **Storage**: one record per row, in project `sift`, with the table as the collection and the row in `metadata`. Sift
  defines the project and collections on start. Records added or changed through the connector are picked up on the
  next request. Sift has no database file of its own.
- **Sign-in**: a signed-out visitor is sent to `/auth/web/login?next=/sift/`. Viewers of `sift` can read, editors can
  change things, admins can do both. bee-database must list `/sift` in `SSO_PATHS`.

## Running it

On the server, next to bee-database:

1. Let the database sign people in for Sift: set `SSO_PATHS=/nibble,/sift` in `bee-database/.env`, then
   `docker compose up -d mcp-db` there.
2. Start Sift:
   ```sh
   cd ~/services/sift
   cp .env.example .env && chmod 600 .env && nano .env    # DB_TOKEN = MCP_API_TOKEN from bee-database/.env
   docker compose up -d --build
   curl http://127.0.0.1:8767/health
   ```
3. Copy the data from Supabase, before using the app. Supabase is only read, and running it again adds nothing twice.
   `DATABASE_URL` is the "Session pooler" connection string (Supabase → Connect):
   ```sh
   read -rs DATABASE_URL && export DATABASE_URL
   docker compose exec -e DATABASE_URL sift node bee/import-supabase.js
   docker compose restart sift
   ```
4. In the Cloudflare tunnel, route `home.samjmerrick.com` path `^/sift(/.*)?$` to `http://sift:8000`, **above** the
   rule that sends the rest of the hostname to the database.

Then open `https://home.samjmerrick.com/sift` and add it to your home screen.

Settings (environment, in `.env`) are listed at the top of `bee/server.js`. `docker compose exec sift node bee/fetch.js`
fetches every source once, by hand.

## Moving from Supabase

After the import, and once the app works on bee: unschedule the Supabase cron job
(`select cron.unschedule('sift-fetch');`), pause or delete the Supabase project, and leave the repository variable
`DEPLOY_PAGES` unset so nothing is published to GitHub Pages.

## Testing

`test/bee.e2e.mjs` runs the importer, the server and the real app in Chromium against a throwaway bee-database; the
commands are at the top of the file.
