import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCallApi } from './api.js';
import { ContactLog } from './contacts.js';

const MAX_JSON_BYTES = 64 * 1024;

// KEY=value lines. Real environment variables win, so a deploy can override the file.
export function readEnv(path) {
  const fromFile = existsSync(path) ? Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')])) : {};
  return { ...fromFile, ...process.env };
}

async function toWebRequest(request) {
  const url = `http://${request.headers.host ?? 'localhost'}${request.url}`;
  if (request.method === 'GET' || request.method === 'HEAD') return new Request(url, { method: request.method });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return new Request(url, { method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
}

// Mounts the callback API on the plain Node server. Returns a handler that answers /api/calls*
// and resolves to false for anything else.
export function callRoutes({ root, findItem }) {
  const env = readEnv(join(root, '.env.local'));
  const contacts = new ContactLog(resolve(env.CONTACTS_PATH ?? join(root, 'data/contacts.jsonl')));
  const handle = createCallApi({ env, findItem, contacts });

  return async (request, response) => {
    if (!request.url.startsWith('/api/calls')) return false;
    const answer = await handle(await toWebRequest(request));
    if (!answer) return false;
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
    return true;
  };
}
