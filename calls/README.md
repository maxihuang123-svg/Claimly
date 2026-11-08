# Claimant callback agent

Open claims the policy sends to `request_information` appear on the **Missing information** page. **Incoming call**
rings the device like a phone; answering it starts a browser voice call with an ElevenLabs agent that asks only for
what the request information rule found missing. It cannot decide or change the claim. What the claimant says is stored as an unconfirmed
contact note in `data/contacts.jsonl`, apart from the case and its review.

## Email

When an upload brings in an open claim that is missing information, the claimant gets an email once, with a link to a
short form that asks only for what is missing (`email.js`). **Send email** on the page sends it (again) by hand. On the form
a clear repair type or an uploaded document (PDF, JPEG or PNG, checked by its content) fills the field and the rules run
again, as after a call. Free text stays a note for a person. The form at `/reply/<token>` is the only page open without
the access code: the token is random, works for 7 days and only until the claimant answers.

Emails go through [Resend](https://resend.com). Without a domain of your own, Resend only delivers to the address the
Resend account is registered with, so for now every claim is emailed to `CLAIMANT_EMAIL`. Without both settings below,
nothing is emailed and imports work as before. At most 10 emails go out per import.

## Setup

In `.env.local` (git-ignored, read by the server only):

```sh
ELEVENLABS_API_KEY=sk_...   # permissions: ElevenAgents read + write
ACCESS_CODE=123456          # optional: asks for this code before anything opens (use it whenever the app is public)
RESEND_API_KEY=re_...       # optional: emails claimants (sending access is enough)
CLAIMANT_EMAIL=you@example.com  # where those emails go, the Resend account's own address
```

Then run `npm run agent` once. It creates the agent and adds `ELEVENLABS_AGENT_ID` to `.env.local`. Run it again to push
prompt changes from `agent-config.js`. Restart `npm start`.

The browser needs a microphone and loads the ElevenLabs client from esm.sh. On another device, such as a phone, the page
must be served over HTTPS for the microphone to work, for example through `cloudflared tunnel --url http://localhost:3000`.

## Layout

- `api.js`: the `/api/calls*` routes, on web `Request`/`Response`, mounted by `../src/handler.js` on Node and on Cloudflare.
- `email.js`: the emails, the claimant's form at `/reply/<token>` and uploaded documents (`/api/documents`).
- `contacts.js`: append-only contact log of calls and emails, on disk with Node and in Durable Object storage on Cloudflare.
- `access.js`: the optional access code. On Cloudflare it runs in the Worker, in front of everything.
- `agent-config.js`: the agent's prompt and the answers it collects.
- `../public/missing.js`: what the agent may ask for. Shared by server and browser.
- `../public/calls.js`, `phone.js`, `ringtone.js`, `calls.css`: the page and the call screen.
