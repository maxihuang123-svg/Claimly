# Claimly

Trustworthy motor claims triage: every claim gets an explainable next step under a versioned written policy, a person
decides wherever it matters, and when the rules change Claimly shows exactly which open claims need another look.
Built for the Taktile case at thinc! Munich 2026.

## Batch path (for scoring)

Needs Node 22 or later. No install step: the app has no runtime dependencies.

```sh
npm run batch -- claims.csv results.csv
# or: node batch.js claims.csv results.csv
```

`claims.csv` is in the provided case format. `results.csv` gets the columns `case_id, recommendation_v1,
recommendation_v2, needs_recheck, rule_v1, rule_v2, explanation`.

- Every claim is evaluated under policy v1 and v2 (both defined in [`policies.js`](policies.js)), with the same rules
  engine the web app uses ([`engine.js`](engine.js)), so the file and the screen always agree.
- v2 follows the change notice: the quote limit falls to €1,200 (exactly €1,200 is still within it), and an
  `ev_high_voltage_battery` repair goes to human review whatever the quote, ahead of missing documents.
- A closed claim keeps its v1 decision: `recommendation_v2` and `rule_v2` repeat v1, and `needs_recheck` is `False`.
- An open claim has `needs_recheck = True` when v2 recommends a different next step.
- Blank fields are absent facts and are never invented. A blank leads to *request information*, unless a known fact
  already sends the claim to human review.
- `rule_v1` / `rule_v2` name the deciding rule, for example `v2.rule1` (rule 1: human review, rule 2: request
  information, rule 3: routine processing). `explanation` gives the facts that decided it.

On the supplied data: all 14 labelled development cases get their expected v1 recommendation, and v2 changes 4 of the
12 practice cases (PRA-003 to PRA-006). `npm test` checks this, plus the €1,200 / €1,201 boundary, the EV priority,
closed claims and blank fields.

## The app

```sh
npm start                      # http://localhost:3000, data in data/
npm start -- test/practice_cases.csv   # start with the practice cases loaded
```

- **Claims review.** Import a CSV; each claim shows its recommendation, the rule and the checks behind it, and the
  evidence. A reviewer confirms or corrects it with a reason; the reviewer, the reason and the policy version are
  recorded next to the original recommendation, which is never overwritten.
- **Policies, Validation, Expected answers.** The policy owner edits rules as a draft, sees which past and pending
  claims would change and how the draft scores on the labelled examples, then activates it with their name. Open
  claims whose next step changes are flagged for a recheck; closed claims keep the decision they were made under.
- **Measurement.** Correct share, incorrect routine recommendations and unnecessary human reviews by policy version,
  with the changed cases shown separately. How quality is measured after launch, as reviewer corrections and real
  outcomes arrive: [`docs/post-launch-measurement-plan.md`](docs/post-launch-measurement-plan.md).
- **Missing information.** Claims that cannot move on are followed up with the claimant, asking only for what the
  rules found missing:
  - an **AI voice call (ElevenLabs)** that asks the one missing question and saves a clear answer to the claim
    during the call, after which the rules run again;
  - an **email** with a short form (and document upload) that updates the claim the same way.
- **Help** and a guided **Start tutorial** walkthrough.

### ElevenLabs

The callback assistant is an ElevenLabs Agent ([`calls/agent-config.js`](calls/agent-config.js), applied with
`npm run agent`), run in the browser through signed URLs so the API key stays on the server
([`calls/api.js`](calls/api.js)). It uses Flash v2 voice for low latency, a client tool (`record_repair_type`) that
writes the claimant's answer to the claim the moment it is clear, the end-call system tool, and data collection for
the call record (summary, transcript, notes for a person). The agent can never decide, promise payment or change a
claim fact itself: only a clear answer to a field the policy found blank is applied, and the written policy then
decides.

## How it is built

- Plain Node 22 ES modules, no framework and no runtime dependencies. Vanilla JS front end in [`public/`](public).
- One web handler ([`handler.js`](handler.js)) runs on Node ([`server.js`](server.js)) and on Cloudflare Workers
  with a SQLite Durable Object ([`worker/index.js`](worker/index.js), see [`CLOUDFLARE.md`](CLOUDFLARE.md)).
- Every store is an append-only log, so decisions, reviews and policy versions can always be replayed.
- ElevenLabs Agents for the voice call, Resend for email.
- Tests: `npm test`.
