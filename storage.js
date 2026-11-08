import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every store is an append-only log of JSON lines: it reads the whole log once, then
// appends. A log is { path, read(), append(text) }, so the same store runs on files
// (Node) or on Durable Object SQLite (Cloudflare, worker/index.js).

export function fileLog(path) {
  return {
    path,
    read: () => (existsSync(path) ? readFileSync(path, 'utf8') : ''),
    clear() {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    },
    append(text) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, text);
    },
  };
}

// Stores take a file path or a log.
export const asLog = (target) => (typeof target === 'string' ? fileLog(target) : target);

// Uploaded case files, kept as they arrived. A store is { list(), save(name, text) },
// where list() returns [{ name, text }] in name order.
export function fileImports(dir) {
  return {
    list: () => (existsSync(dir)
      ? readdirSync(dir).filter((name) => name.endsWith('.csv')).sort()
        .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
      : []),
    clear() {
      if (existsSync(dir)) for (const name of readdirSync(dir).filter((name) => name.endsWith('.csv'))) rmSync(join(dir, name));
    },
    save(name, text) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text, { flag: 'wx' }); // never overwrite an earlier import
    },
  };
}

// Documents claimants uploaded (calls/email.js). A store is { save(id, bytes), read(id) }; read returns null when unknown.
export function fileDocuments(dir) {
  return {
    read: (id) => (/^[\w-]+$/.test(id) && existsSync(join(dir, id)) ? new Uint8Array(readFileSync(join(dir, id))) : null),
    save(id, bytes) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, id), bytes, { flag: 'wx' });
    },
  };
}
