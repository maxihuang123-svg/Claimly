import { DurableObject } from 'cloudflare:workers';
import { accessGate } from '../calls/access.js';
import { createApp } from '../handler.js';
import { examplesFrom } from '../validation.js';
import { ENGINE_VERSION, EXAMPLES_CSV } from './generated.js';

// Cloudflare entry. The Worker checks the access code, serves public/ as static assets and
// sends /api/* to one Durable Object. That object holds the app exactly as server.js does on
// Node: it replays every log into memory once, then appends. Its SQLite storage replaces the
// files under data/, and because it is a single instance, reads and writes stay consistent.

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

export class Claims extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec('CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY AUTOINCREMENT, log TEXT NOT NULL, text TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS lines_by_log ON lines (log, id)');
    this.app = createApp({
      imports: sqlImports(sql),
      logs: Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts'].map((name) => [name, sqlLog(sql, name)])),
      engineVersion: ENGINE_VERSION,
      examples: examplesFrom(EXAMPLES_CSV),
      env,
    });
  }

  async fetch(request) {
    // Code attempts come here too, so wrong guesses are counted once for the whole site,
    // not separately in each Worker instance.
    this.gate ??= accessGate(this.env.ACCESS_CODE);
    return (await this.gate(request)) ?? this.app.handle(request);
  }
}

let gate;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const app = () => env.CLAIMS.get(env.CLAIMS.idFromName('main')).fetch(request);
    if (request.method === 'POST' && pathname === '/access') {
      // A code is a few bytes, so anything large is refused here, before it reaches the object.
      if (!(Number(request.headers.get('content-length')) <= 1024)) return new Response('Request is too large.', { status: 413 });
      return app();
    }
    gate ??= accessGate(env.ACCESS_CODE);
    const denied = await gate(request);
    if (denied) return denied;
    return pathname.startsWith('/api/') ? app() : env.ASSETS.fetch(request);
  },
};
