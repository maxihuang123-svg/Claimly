# Running on Cloudflare

The same app runs on Node (`npm start`, files under `data/`) and on Cloudflare (`npm run deploy`).

- `handler.js` has every `/api/*` route as a web `Request` → `Response` handler.
- `server.js` runs it on Node and serves `public/`.
- `worker/index.js` runs it on Cloudflare. The Worker checks the access code, serves `public/` as static assets and
  sends `/api/*` to one Durable Object, which holds the app in memory like the Node process does.
- Every store (reviews, policies, validation, outcomes, contacts, imported CSV files) is an append-only log
  (`storage.js`). On Node a log is a file. In the Durable Object it is rows in its SQLite storage.

## First deploy

Needs Node 22 or later (Wrangler does not run on Node 20).

```sh
npm install
npx wrangler login
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ACCESS_CODE        # optional, but use it: the URL is public
npm run deploy
```

It prints a `https://claims-review.<account>.workers.dev` URL. The site starts with no cases: import
`test/practice_cases.csv` from the Claims page. `ELEVENLABS_AGENT_ID` is in `wrangler.toml`.

## Local check of the Worker

Put `ELEVENLABS_API_KEY=...` and `ACCESS_CODE=...` in `.dev.vars` (git-ignored), then `npm run dev:worker`
and open http://localhost:8787. Its data is kept in `.wrangler/state`.

## Limits

- One Durable Object handles every request, one at a time. That is plenty for a team and a demo.
- Code attempts go through the Durable Object, so the limit of 10 wrong codes a minute is shared by the whole site.
- Data on Cloudflare and in `data/` are separate. Nothing is copied between them.
