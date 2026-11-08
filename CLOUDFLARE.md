# Running on Cloudflare

The same app runs on Node (`npm start`, files under `data/`) and on Cloudflare (`npm run deploy`).

- `src/handler.js` has every `/api/*` route as a web `Request` → `Response` handler.
- `src/server.js` runs it on Node and serves `public/`.
- `worker/index.js` runs it on Cloudflare. The Worker checks the access code, serves `public/` as static assets and
  sends `/api/*` and the claimants' reply forms (`/reply/*`) to one Durable Object, which holds the app in memory like the Node process does.
- Every store (reviews, policies, validation, outcomes, contacts, imported CSV files, uploaded documents) is an
  append-only log (`src/storage.js`). On Node a log is a file. In the Durable Object it is rows in its SQLite storage.

## First deploy

Needs Node 22 or later (Wrangler does not run on Node 20).

```sh
npm install
npx wrangler login
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ACCESS_CODE        # optional, but use it: the URL is public
npx wrangler secret put RESEND_API_KEY     # optional: emails claimants (calls/README.md)
npx wrangler secret put CLAIMANT_EMAIL
npx wrangler secret put JUDGE_CODE         # optional: a separate copy of the data for the jury
npx wrangler secret put DEMO_CODE          # optional: a resettable copy for testing and recording
npm run deploy
```

It prints a `https://claimly.<account>.workers.dev` URL. The site starts with no cases: import
`test/practice_cases.csv` from the Claims page. `ELEVENLABS_AGENT_ID` is in `wrangler.toml`.

## Local check of the Worker

Put `ELEVENLABS_API_KEY=...` and `ACCESS_CODE=...` in `.dev.vars` (git-ignored), then `npm run dev:worker`
and open http://localhost:8787. Its data is kept in `.wrangler/state`.

## Judges' copy

With `JUDGE_CODE` set, that code opens a second Durable Object ("judges") with its own data. It starts from
`test/practice_cases.csv` and `demo/voice_demo_cases.csv`, emails there are recorded but not sent, and the team resets it
with `POST /api/admin/reset-judges` (team cookie only). The code is shared, so every deploy updates both copies.
A link like `https://<worker>/?code=<code>` logs in with one click.

`DEMO_CODE` opens a third copy ("demo") that starts the same way. Its sidebar has a **Reset demo** button that
puts it back to the start, so every test or recording begins with the same claims.

## Limits

- One Durable Object handles every request, one at a time. That is plenty for a team and a demo.
- Code attempts go through the Durable Object, so the limit of 10 wrong codes a minute is shared by the whole site.
- Data on Cloudflare and in `data/` are separate. Nothing is copied between them.
