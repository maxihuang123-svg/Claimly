import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { accessGate } from './calls/access.js';
import { readEnv } from './env.js';
import { createDemoWorkspace } from './demo-workspace.js';
import { fileDocuments, fileImports } from './storage.js';
import { hash } from './validation.js';

// Runs the app on Node with files under data/. The routes live in handler.js, which
// worker/index.js also runs on Cloudflare.
const root = dirname(fileURLToPath(import.meta.url));
const env = readEnv(join(root, '.env.local'));
const dataPath = (name, variable) => resolve(env[variable] ?? join(root, 'data', name));
const casesPath = resolve(process.argv[2] ?? join(root, 'data/cases.csv'));
const port = Number(env.PORT ?? 3000);

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/measurement.js': ['measurement.js', 'text/javascript; charset=utf-8'],
  '/validation.js': ['validation.js', 'text/javascript; charset=utf-8'],
  '/labels.js': ['labels.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/calls.js': ['calls.js', 'text/javascript; charset=utf-8'],
  '/calls.css': ['calls.css', 'text/css; charset=utf-8'],
  '/ringtone.js': ['ringtone.js', 'text/javascript; charset=utf-8'],
  '/ringtone.mp3': ['ringtone.mp3', 'audio/mpeg'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/missing.js': ['missing.js', 'text/javascript; charset=utf-8'],
  '/logo.png': ['logo.png', 'image/png'],
  '/help.js': ['help.js', 'text/javascript; charset=utf-8'],
  '/tour.js': ['tour.js', 'text/javascript; charset=utf-8'],
  '/tour.css': ['tour.css', 'text/css; charset=utf-8'],
};

const app = createDemoWorkspace({
  baseCases: existsSync(casesPath) ? readFileSync(casesPath, 'utf8') : null,
  imports: fileImports(dataPath('imports', 'IMPORTS_DIR')),
  documents: fileDocuments(dataPath('documents', 'DOCUMENTS_DIR')),
  logs: {
    reviews: dataPath('reviews.jsonl', 'REVIEWS_PATH'),
    policies: dataPath('policies.jsonl', 'POLICIES_PATH'),
    validation: dataPath('validation.jsonl', 'VALIDATION_PATH'),
    outcomes: dataPath('outcomes.jsonl', 'OUTCOMES_PATH'),
    contacts: dataPath('contacts.jsonl', 'CONTACTS_PATH'),
  },
  engineVersion: hash(['engine.js', 'cases.js', 'validation.js'].map((file) => readFileSync(join(root, file), 'utf8'))),
  env,
}, readFileSync(join(root, 'demo/practice_cases.csv'), 'utf8'));
const gate = accessGate(env.ACCESS_CODE);

// The body stays a stream: each route reads it with its own size limit (body.js).
function toWebRequest(request) {
  const url = `http://${request.headers.host ?? 'localhost'}${request.url}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
  });
}

async function send(response, answer) {
  const headers = {};
  answer.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(answer.status, headers);
  response.end(Buffer.from(await answer.arrayBuffer()));
}

async function route(incoming, response) {
  const request = toWebRequest(incoming);
  const denied = await gate(request);
  if (denied) return send(response, denied);

  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/api/space') {
    return send(response, new Response(JSON.stringify({ space: 'local' }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  if (request.method === 'GET' && STATIC_FILES[pathname]) {
    const [file, type] = STATIC_FILES[pathname];
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    response.end(readFileSync(join(root, 'public', file)));
    return;
  }
  return send(response, await app.handle(request));
}

createServer((request, response) => {
  route(request, response).catch((error) => {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'The server could not complete that request.' }));
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Claimly: http://localhost:${port}`);
  console.log(`${app.items.size} cases loaded`);
  console.log(`Current policy: ${app.policies.current.version}`);
});
