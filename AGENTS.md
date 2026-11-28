# Sift

A self-hosted, LLM-free feed of articles and practice cards (PWA), served at `/sift/`. `README.md` explains what it does, how the feed is shared out and how to write starter packs.

## Commands

Node 22.13 or later (`node:sqlite`).

- `npm ci` — install
- `npm test` — all tests (in memory; no network or services needed)
- `SIFT_EMAILS=you@example.com PB_URL=<PocketBase URL> npm start` — run on :8000, data in `./data`

## Folders

- `server/` — web server. `main.js` (port, timers, backups), `index.js` (routes, static files), `auth.js` (sign-in), `rest.js` (PostgREST subset), `feed.js` (`feed_state`), `db.js` (SQLite), `import.js` (load exported rows).
- `fetch/` — feed fetching and article reading (`handlers.js` is what the server calls).
- `public/` — the front end: plain ES modules, no build step. `starters/` holds the starter packs.
- `migrations/` — SQL applied in name order at start.
- `test/` — `node --test`. `mock-backend.js` is the reference for what the API answers.

## Rules

- No LLM in the app: curation is rules, community scores and the user's own reactions.
- Never edit an applied migration; add a numbered file.
- Every table, column and operator the API accepts is whitelisted in `server/rest.js`; values are always bound parameters. A new column goes there and in `server/feed.js` if the feed needs it.
- Fetched HTML is untrusted: it goes through the sanitisers (`fetch/lib/reader.js`, `public/lib/sanitise.js`).
- The front end uses relative URLs, because the app lives under `/sift/`.
- When you add a file the app shell needs, add it to `SHELL` in `public/sw.js` and bump `CACHE`.
- `public/vendor/` is third-party code; don't edit it.
- Never commit `.env`, `data/` or exported rows.

## Deployment

The Dockerfile is the build. The host's apps platform (outside this repo) follows `main`: it builds it as the `sift` service behind Caddy, with `/data` mounted and sign-in through its shared PocketBase. **Merging to `main` therefore deploys**, within about 15 minutes. Check with the owner before merging or pushing there.
