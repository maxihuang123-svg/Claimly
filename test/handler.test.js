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

// The voice demo: the claim form left the repair type blank, the claimant says on the call that
// it is a standard repair, and the claim moves on without anyone touching it.
test('a clear answer on a call fills the blank field and the rules run again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'));
  const conversation = {
    status: 'done',
    analysis: { data_collection_results: { repair_type: { value: 'standard' } } },
    transcript: [{ role: 'user', message: 'Petrol car, just the rear bumper.' }],
  };
  const fetch = async (url) => new Response(JSON.stringify(url.includes('get-signed-url')
    ? { signed_url: 'wss://signed' } : conversation));
  const logs = Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts']
    .map((name) => [name, join(dir, `${name}.jsonl`)]));
  const app = createApp({ logs, imports: fileImports(join(dir, 'imports')), engineVersion: 'test', fetch,
    env: { ELEVENLABS_API_KEY: 'key', ELEVENLABS_AGENT_ID: 'agent' } });
  const header = practice.split('\n')[0].trim();
  const row = 'DEMO-1,open,"Rear bumper dented, repair type not stated.",True,motor_own_damage,,850,True,True,False,False,False,False';
  await post(app, '/api/import', `${header}\n${row}\n`, 'text/csv');
  assert.equal(app.items.get('DEMO-1').automated.recommendation, 'request_information');

  const { contact } = await (await post(app, '/api/calls', JSON.stringify({ case_id: 'DEMO-1' }))).json();
  await post(app, '/api/calls/connected', JSON.stringify({ id: contact.id, conversation_id: 'conv_1' }));
  const after = await (await app.handle(new Request(`http://localhost/api/calls/result?id=${contact.id}`))).json();

  assert.deepEqual(after.contact.applied.changes, { repair_type: 'standard' });
  assert.equal(after.contact.applied.after.recommendation, 'routine_processing');
  assert.equal(app.items.get('DEMO-1').case.repair_type, 'standard');
  assert.equal(app.items.get('DEMO-1').case.claim_summary, 'Rear bumper dented, repair type not stated.');
  assert.equal(appIn(dir).items.get('DEMO-1').automated.recommendation, 'routine_processing'); // after a restart
});

// The quick demo: the agent records the answer while the call is still going on, so the claim moves on
// before the claimant hangs up. The analysis after the call does not apply it a second time.
test('an answer recorded during the call updates the claim at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'));
  const conversation = { status: 'done', analysis: { data_collection_results: { repair_type: { value: 'ev_high_voltage_battery' } } }, transcript: [] };
  const fetch = async (url) => new Response(JSON.stringify(url.includes('get-signed-url') ? { signed_url: 'wss://signed' } : conversation));
  const logs = Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts']
    .map((name) => [name, join(dir, `${name}.jsonl`)]));
  const app = createApp({ logs, imports: fileImports(join(dir, 'imports')), engineVersion: 'test', fetch,
    env: { ELEVENLABS_API_KEY: 'key', ELEVENLABS_AGENT_ID: 'agent' } });
  const header = practice.split('\n')[0].trim();
  const row = 'DEMO-1,open,"Rear bumper dented, repair type not stated.",True,motor_own_damage,,850,True,True,False,False,False,False';
  await post(app, '/api/import', `${header}\n${row}\n`, 'text/csv');

  const started = await (await post(app, '/api/calls', JSON.stringify({ case_id: 'DEMO-1' }))).json();
  assert.equal(started.dynamic_variables.question, "One quick question: what's being repaired, and is the car electric?");
  const { id } = started.contact;
  assert.equal((await post(app, '/api/calls/answer', JSON.stringify({ id, repair_type: 'unknown' }))).status, 400);

  const answered = await (await post(app, '/api/calls/answer', JSON.stringify({ id, repair_type: 'standard' }))).json();
  assert.equal(answered.contact.applied.during, 'call');
  assert.equal(answered.contact.applied.after.recommendation, 'routine_processing');
  assert.equal(app.items.get('DEMO-1').automated.recommendation, 'routine_processing');

  // A second answer and the analysis afterwards leave it as it is.
  await post(app, '/api/calls/answer', JSON.stringify({ id, repair_type: 'ev_high_voltage_battery' }));
  await post(app, '/api/calls/connected', JSON.stringify({ id, conversation_id: 'conv_1' }));
  const after = await (await app.handle(new Request(`http://localhost/api/calls/result?id=${id}`))).json();
  assert.equal(after.contact.applied.during, 'call');
  assert.equal(app.items.get('DEMO-1').case.repair_type, 'standard');
});
