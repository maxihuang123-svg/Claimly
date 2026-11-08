import { Buffer } from 'node:buffer';
import { DurableObject } from 'cloudflare:workers';
import { accessGate, spaceOf } from '../calls/access.js';
import { createApp } from '../handler.js';
import { POLICY_V2 } from '../policies.js';
import { examplesFrom } from '../validation.js';
import { ENGINE_VERSION, EXAMPLES_CSV, JUDGE_CASES_CSV } from './generated.js';

// Cloudflare entry. The Worker checks the access code, serves public/ as static assets and
// sends /api/* and the claimants' reply forms (/reply/*) to a Durable Object. That object holds the app exactly as server.js does on
// Node: it replays every log into memory once, then appends. Its SQLite storage replaces the
// files under data/, and because it is a single instance, reads and writes stay consistent.
//
// There are two objects, two separate copies of the data: "main" for the team (ACCESS_CODE) and "judges"
// for the jury (JUDGE_CODE). The code is the same for both. The judges' copy starts from the practice and
// demo claims with policy v2 already released, only pretends to send emails, and can be reset by the team (POST /api/admin/reset-judges).

const CHUNK = 500_000; // characters per row, well under the 2 MB limit for one SQLite value

// A log (storage.js) kept as rows of text. A long line is split over several rows and
// joined again on read; rows written in one request are committed together.
function sqlLog(sql, name) {
  return {
    path: `sqlite:${name}`,
    read: () => sql.exec('SELECT text FROM lines WHERE log = ? ORDER BY id', name).toArray().map((row) => row.text).join(''),
    append(text) {
      for (let at = 0; at < text.length;) {
        let end = Math.min(at + CHUNK, text.length);
        // Never split a surrogate pair (an emoji, say): each half alone is not valid text.
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
        sql.exec('INSERT INTO lines (log, text) VALUES (?, ?)', name, text.slice(at, end));
        at = end;
      }
    },
  };
}

// Documents claimants uploaded, as base64 text under "document:<id>".
function sqlDocuments(sql) {
  return {
    read(id) {
      const text = sqlLog(sql, `document:${id}`).read();
      return text ? new Uint8Array(Buffer.from(text, 'base64')) : null;
    },
    save: (id, bytes) => sqlLog(sql, `document:${id}`).append(Buffer.from(bytes).toString('base64')),
  };
}

// Uploaded case files, one log each under "import:<name>".
function sqlImports(sql) {
  return {
    list: () => sql.exec("SELECT DISTINCT log FROM lines WHERE log LIKE 'import:%' ORDER BY log").toArray()
      .map(({ log }) => ({ name: log.slice('import:'.length), text: sqlLog(sql, log).read() })),
    save(name, text) {
      const log = `import:${name}`;
      if (sql.exec('SELECT 1 FROM lines WHERE log = ? LIMIT 1', log).toArray().length) throw new Error(`Import ${name} already exists.`);
      sqlLog(sql, log).append(text);
    },
  };
}

const codes = (env) => ({ main: env.ACCESS_CODE, judges: env.JUDGE_CODE });

export class Claims extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.open();
  }

  open() {
    const { sql } = this.ctx.storage;
    const judges = this.ctx.id.name === 'judges';
    sql.exec('CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY AUTOINCREMENT, log TEXT NOT NULL, text TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS lines_by_log ON lines (log, id)');
    this.app = createApp({
      imports: sqlImports(sql),
      documents: sqlDocuments(sql),
      logs: Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts'].map((name) => [name, sqlLog(sql, name)])),
      engineVersion: ENGINE_VERSION,
      examples: examplesFrom(EXAMPLES_CSV),
      baseCases: judges ? JUDGE_CASES_CSV : null,
      startPolicies: judges ? [POLICY_V2] : [],
      env: judges ? { ...this.env, EMAIL_DRY_RUN: 'true' } : this.env,
    });
  }

  async fetch(request) {
    // Only the Worker below can send this: it forwards nothing else outside /api/ and /reply/.
    if (new URL(request.url).pathname === '/__reset') {
      await this.ctx.storage.deleteAll();
      this.open();
      return new Response(JSON.stringify({ reset: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    // Code attempts come here too, so wrong guesses are counted once for the whole site,
    // not separately in each Worker instance.
    this.gate ??= accessGate(codes(this.env));
    return (await this.gate(request)) ?? this.app.handle(request);
  }
}

let gate;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const copy = (name) => env.CLAIMS.get(env.CLAIMS.idFromName(name));
    if (request.method === 'POST' && pathname === '/access') {
      // A code is a few bytes, so anything large is refused here, before it reaches the object.
      if (!(Number(request.headers.get('content-length')) <= 1024)) return new Response('Request is too large.', { status: 413 });
      return copy('main').fetch(request);
    }
    if (request.method === 'GET' && pathname === '/' && url.searchParams.has('code')) return copy('main').fetch(request);
    gate ??= accessGate(codes(env));
    const denied = await gate(request);
    if (denied) return denied;

    // A claimant opening a reply link has no cookie: those links come from the team's copy.
    const space = spaceOf(request.headers.get('cookie'), codes(env)) ?? 'main';
    if (request.method === 'POST' && pathname === '/api/admin/reset-judges') {
      if (space !== 'main') return new Response(JSON.stringify({ error: 'Only the team can reset the judges\' copy.' }), { status: 403 });
      return copy('judges').fetch(new Request('https://claimly.internal/__reset', { method: 'POST' }));
    }
    return pathname.startsWith('/api/') || pathname.startsWith('/reply/') ? copy(space).fetch(request) : env.ASSETS.fetch(request);
  },
};
