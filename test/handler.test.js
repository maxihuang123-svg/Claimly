import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../handler.js';
import { fileImports } from '../storage.js';

const practice = readFileSync(new URL('./practice_cases.csv', import.meta.url), 'utf8');

function appIn(dir) {
  const logs = Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts']
    .map((name) => [name, join(dir, `${name}.jsonl`)]));
  return createApp({ logs, imports: fileImports(join(dir, 'imports')), engineVersion: 'test', env: {} });
}

const post = (app, path, body, type = 'application/json') => app.handle(new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'Content-Type': type }, body,
}));

test('imports in the same millisecond are kept apart and replay after a restart', async (t) => {
  t.mock.method(Date, 'now', () => 1_000);
  const dir = mkdtempSync(join(tmpdir(), 'handler-'));
  const app = appIn(dir);
  const [header, first] = practice.split('\n');
  assert.equal((await post(app, '/api/import', `${header}\n${first}\n`, 'text/csv')).status, 200);
  const changed = first.replace(/,open,/, ',closed,');
  assert.equal((await post(app, '/api/import', `${header}\n${changed}\n`, 'text/csv')).status, 200);

  const restarted = appIn(dir);
  const caseId = first.split(',')[0];
  assert.equal(restarted.items.get(caseId).case.case_status, 'closed');
});

test('oversized bodies are refused', async () => {
  const app = appIn(mkdtempSync(join(tmpdir(), 'handler-')));
  const big = JSON.stringify({ case_id: 'x'.repeat(70 * 1024) });
  assert.equal((await post(app, '/api/reviews', big)).status, 400);
  assert.equal((await post(app, '/api/calls', big)).status, 413);
});
