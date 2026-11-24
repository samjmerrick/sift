# Sift on the personal database (bee)

Sift can run as a claude.ai artifact on your data in the personal database (bee-database, `mcp.samjmerrick.com`),
instead of on Supabase and GitHub Pages.

- **The app** is `dist/sift.html` (`npm run build:live`): the same `public/` app, bundled with an in-memory backend
  (`preview/mock-backend.js`) that is filled from the personal database when the page opens. Every change is saved
  back as one record call through the artifact's **Personal database** connector, with your own sign-in
  (`live/sync.js`). A small pill at the bottom shows "Saving…" and any save that failed, with Retry.
- **Fetching** runs on bee (`bee/fetch.js`), because an artifact can't load other websites. Each run fetches every
  enabled source, fills in missing summaries, saves reader text for new articles, and drops old read articles
  (30 days after reading, 60 after fetching, never saved ones).
- **Storage**: one record per Sift row, in project `sift`, with the table as the collection (`topics`, `sources`,
  `items`, `cards`, ...) and the row in `metadata`. See `bee/records.js`.

## Setting it up on bee

Needs Node 22.13 or later (for `node:sqlite`) and the path of bee-database's SQLite file (in
`~/services/bee-database`).

```sh
git clone https://github.com/samjmerrick/sift ~/sift && cd ~/sift && npm ci --omit=dev
export BEE_DB=~/services/bee-database/<path to the .db file>
cp "$BEE_DB" "$BEE_DB.before-sift"     # a backup, just in case

# 1. Copy everything from Supabase (read-only there; safe to run again, nothing is added twice).
#    DATABASE_URL is the Supabase "Session pooler" connection string (Project → Connect).
DATABASE_URL='postgres://…' npm run bee:import

# 2. Fetch once by hand, then hourly from cron.
npm run bee:fetch
( crontab -l; echo "17 * * * * cd ~/sift && BEE_DB=$BEE_DB node bee/fetch.js >> ~/sift-fetch.log 2>&1" ) | crontab -
```

## What's different from the Supabase app

- No article thumbnails or YouTube embeds (artifacts block outside images and frames); YouTube items link out.
- No offline mode or home-screen install.
- **Fetch now**, **Fetch all now** and source **Preview** in Settings say that fetching runs on bee. A new source
  fills in at the next hourly run.
- Reader text is whatever bee saved; an article bee couldn't read offers the original link.
- New articles fetched while the page is open show up the next time the feed reloads (at most once a minute).

## Retiring Supabase

Once the artifact has worked for a while: unschedule the Supabase cron job
(`select cron.unschedule('sift-fetch');`), turn off GitHub Pages, and pause or delete the Supabase project.

## Testing

`npm run preview && npm run build:live && node test/live.e2e.mjs` imports the preview's sample data into a throwaway
copy of the bee-database schema, opens the live build with a stand-in connector, and checks that loading, saving,
cascading deletes, reloads and `bee/fetch.js` all work.
