import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accessGate } from '../calls/access.js';
import { createApp } from '../src/handler.js';
import { fileDocuments, fileImports } from '../src/storage.js';

const demo = readFileSync(new URL('../demo/voice_demo_cases.csv', import.meta.url), 'utf8');
const header = demo.split('\n')[0].trim();
const ENV = { RESEND_API_KEY: 'key', CLAIMANT_EMAIL: 'claimant@example.com' };
const PDF = new TextEncoder().encode('%PDF-1.4\n%demo\n');

// An app with Resend replaced by a recorder: every batch it was asked to send.
function appIn(dir, env = ENV, status = 200) {
  const batches = [];
  const fetch = async (url, init) => {
    batches.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: [] }), { status });
  };
  const logs = Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts']
    .map((name) => [name, join(dir, `${name}.jsonl`)]));
  const app = createApp({ logs, imports: fileImports(join(dir, 'imports')), documents: fileDocuments(join(dir, 'documents')),
    engineVersion: 'test', env, fetch });
  return { app, batches };
}

const request = (app, path, init = {}) => app.handle(new Request(`https://claimly.test${path}`, init));
const importCsv = (app, text) => request(app, '/api/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
const emails = async (app) => (await (await request(app, '/api/calls')).json()).contacts.filter((c) => c.channel === 'email');
const linkIn = (email) => new URL(email.text.match(/https:\S+/)[0]).pathname;
const submit = (app, path, entries) => {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  return request(app, path, { method: 'POST', body: form });
};

test('an import emails each claim that is missing information, once', async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')));
  const data = await (await importCsv(app, demo)).json();
  assert.equal(data.summary.emailed, 3);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].url, 'https://api.resend.com/emails/batch');
  assert.deepEqual(batches[0].body.map((email) => email.to), [['claimant@example.com'], ['claimant@example.com'], ['claimant@example.com']]);
  assert.match(batches[0].body[0].subject, /DEMO-101/);
  assert.match(batches[0].body[0].text, /https:\/\/claimly\.test\/reply\/[\w-]{32}/);

  // The same file again changes nothing, so nobody is emailed twice.
  assert.equal((await (await importCsv(app, demo)).json()).summary.emailed, 0);
  assert.equal(batches.length, 1);
});

test('without Resend set up an import still works and sends nothing', async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')), {});
  const data = await (await importCsv(app, demo)).json();
  assert.equal(data.summary.added, 3);
  assert.equal(data.summary.emailed, 0);
  assert.equal(batches.length, 0);
  const response = await request(app, '/api/emails', { method: 'POST', body: JSON.stringify({ case_id: 'DEMO-101' }) });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /RESEND_API_KEY/);
});

test('a failed send is kept with its error', async () => {
  const { app } = appIn(mkdtempSync(join(tmpdir(), 'email-')), ENV, 422);
  await importCsv(app, demo);
  const [email] = await emails(app);
  assert.match(email.error, /Resend 422/);
});

test('the claimant picks a standard repair on the form and the claim moves on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'email-'));
  const { app, batches } = appIn(dir);
  await importCsv(app, demo);
  const path = linkIn(batches[0].body.find((email) => email.subject.includes('DEMO-101')));

  const form = await request(app, path);
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.match(html, /name="repair_type" value="standard"/);
  assert.doesNotMatch(html, /type="file"/, 'only what is missing is asked for');

  const answered = await submit(app, path, [['repair_type', 'standard'], ['repair_description', 'rear bumper'], ['quote_eur', '1']]);
  assert.equal(answered.status, 303);
  assert.equal(app.items.get('DEMO-101').case.repair_type, 'standard');

  const email = (await emails(app)).find((contact) => contact.case_id === 'DEMO-101');
  assert.equal(email.applied.before.recommendation, 'request_information');
  assert.equal(email.applied.after.recommendation, 'routine_processing');
  assert.deepEqual(email.reply.notes, { repair_description: 'rear bumper' }, 'fields that were not missing are ignored');

  // The link now only says thank you, and a second answer changes nothing.
  assert.match(await (await request(app, path)).text(), /We received your answer/);
  await submit(app, path, [['repair_type', 'ev_high_voltage_battery']]);
  assert.equal(app.items.get('DEMO-101').case.repair_type, 'standard');

  // It survives a restart, like every other update.
  assert.equal(appIn(dir).app.items.get('DEMO-101').automated.recommendation, 'routine_processing');
});

test('"not sure" is kept as an answer but leaves the claim as it is', async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')));
  await importCsv(app, demo);
  await submit(app, linkIn(batches[0].body[0]), [['repair_type', 'unknown']]);
  const [email] = await emails(app);
  assert.equal(email.applied, undefined);
  assert.equal(email.reply.answers.repair_type, 'unknown');
  assert.equal(app.items.get(email.case_id).automated.recommendation, 'request_information');
});

test('an empty form is asked again', async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')));
  await importCsv(app, demo);
  const response = await submit(app, linkIn(batches[0].body[0]), [['repair_type', '']]);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /answer at least one question/);
});

test('an uploaded incident report fills the missing document and can be opened by the claims team', async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')));
  const row = 'DOC-1,open,"Rear bumper dented in a car park.",True,motor_own_damage,standard,850,False,True,False,False,False,False';
  await importCsv(app, `${header}\n${row}\n`);
  const path = linkIn(batches[0].body[0]);
  assert.match(await (await request(app, path)).text(), /name="incident_report_present"/);

  const notPdf = await submit(app, path, [['incident_report_present', new Blob(['<script>alert(1)</script>'], { type: 'application/pdf' }), 'report.pdf']]);
  assert.equal(notPdf.status, 400, 'a file is checked by its content, not its name or type');

  await submit(app, path, [['incident_report_present', new File([PDF], 'report.pdf', { type: 'application/pdf' })]]);
  assert.equal(app.items.get('DOC-1').case.incident_report_present, true);
  const [email] = await emails(app);
  assert.equal(email.applied.after.recommendation, 'routine_processing');

  const document = await request(app, `/api/documents?id=${email.reply.documents[0].id}`);
  assert.equal(document.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(new Uint8Array(await document.arrayBuffer()), PDF);
});

test('unknown and expired links show a page, not the form', async (t) => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')));
  await importCsv(app, demo);
  assert.equal((await request(app, `/reply/${'x'.repeat(32)}`)).status, 404);
  const path = linkIn(batches[0].body[0]);
  const later = Date.now() + 8 * 86_400_000;
  t.mock.method(Date, 'now', () => later);
  assert.equal((await request(app, path)).status, 410);
  assert.equal((await submit(app, path, [['repair_type', 'standard']])).status, 410);
});

test('the reply form is open without the access code; the claims team pages are not', async () => {
  const gate = accessGate('123456');
  assert.equal(await gate(new Request('https://claimly.test/reply/abc')), null);
  assert.equal((await gate(new Request('https://claimly.test/api/documents?id=abc'))).status, 401);
  assert.equal((await gate(new Request('https://claimly.test/api/emails', { method: 'POST' }))).status, 401);
});

test("in the judges' copy emails are recorded as sent without reaching Resend", async () => {
  const { app, batches } = appIn(mkdtempSync(join(tmpdir(), 'email-')), { EMAIL_DRY_RUN: 'true' });
  assert.equal((await (await importCsv(app, demo)).json()).summary.emailed, 3);
  assert.equal(batches.length, 0);
  const [email] = await emails(app);
  assert.equal(email.simulated, true);
  assert.ok(email.sent_at);
  assert.equal((await request(app, `/reply/${email.token}`)).status, 200);
});
