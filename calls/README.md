# Claimant callback agent

Open claims the policy sends to `request_information` appear on the **Missing information** page. **Incoming call**
rings the device like a phone; answering it starts a browser voice call with an ElevenLabs agent that asks only for
what the request information rule found missing. It cannot decide or change the claim. What the claimant says is stored as an unconfirmed
contact note in `data/contacts.jsonl`, apart from the case and its review.

## Setup

In `.env.local` (git-ignored, read by the server only):

```sh
ELEVENLABS_API_KEY=sk_...   # permissions: ElevenAgents read + write
ACCESS_CODE=123456          # optional: asks for this code before anything opens (use it whenever the app is public)
```

Then run `npm run agent` once. It creates the agent and adds `ELEVENLABS_AGENT_ID` to `.env.local`. Run it again to push
prompt changes from `agent-config.js`. Restart `npm start`.

The browser needs a microphone and loads the ElevenLabs client from esm.sh. On another device, such as a phone, the page
must be served over HTTPS for the microphone to work, for example through `cloudflared tunnel --url http://localhost:3000`.

## Layout

- `api.js`: the `/api/calls*` routes, on web `Request`/`Response`, mounted by `../handler.js` on Node and on Cloudflare.
- `contacts.js`: append-only contact log, on disk with Node and in Durable Object storage on Cloudflare.
- `access.js`: the optional access code. On Cloudflare it runs in the Worker, in front of everything.
- `agent-config.js`: the agent's prompt and the answers it collects.
- `../public/missing.js`: what the agent may ask for. Shared by server and browser.
- `../public/calls.js`, `phone.js`, `ringtone.js`, `calls.css`: the page and the call screen.
