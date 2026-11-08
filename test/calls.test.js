import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCallApi } from '../calls/api.js';
import { ContactLog } from '../calls/contacts.js';
import { evaluate, normalizeCase } from '../engine.js';
import { POLICY_V1 } from '../policies.js';
import { canCall, missingItems } from '../public/missing.js';

const row = {
  case_id: 'T-1', case_status: 'open', claim_summary: '', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '500',
  incident_report_present: 'False', itemized_quote_present: 'True', injury_reported: 'False',
  liability_disputed: 'False', duplicate_flag: 'False', evidence_conflict: 'False',
};
const itemFor = (changes) => {
  const record = normalizeCase({ ...row, ...changes });
  return { case: record, automated: evaluate(record, POLICY_V1) };
};
const item = itemFor({});
const freshLog = () => new ContactLog(join(mkdtempSync(join(tmpdir(), 'contacts-')), 'contacts.jsonl'));

const ENV = { ELEVENLABS_API_KEY: 'key', ELEVENLABS_AGENT_ID: 'agent' };

// Answers ElevenLabs requests by path and records what was sent.
function fakeElevenLabs(routes) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    sent.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const body = routes[path];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, sent };
}

function setup(routes = {}, items = [item]) {
  const contacts = freshLog();
  const elevenLabs = fakeElevenLabs(routes);
  const handle = createCallApi({
    env: ENV,
    contacts,
    fetch: elevenLabs.fetch,
    findItem: (id) => items.find((candidate) => candidate.case.case_id === id) ?? null,
  });
  const call = async (method, path, body) => {
    const response = await handle(new Request(`http://localhost${path}`, {
      method, body: body && JSON.stringify(body), headers: body ? { 'Content-Type': 'application/json' } : {},
    }));
    return { status: response.status, body: await response.json() };
  };
  return { call, contacts, sent: elevenLabs.sent };
}

const SIGNED = { '/v1/convai/conversation/get-signed-url': { signed_url: 'wss://signed' } };
const startCall = { case_id: 'T-1' };

test('the agent asks only for what the request information rule found missing', () => {
  assert.deepEqual(missingItems(item), ['the incident report']);
  assert.deepEqual(missingItems(itemFor({ itemized_quote_present: '' })), ['the incident report', 'an itemized repair quote']);
  assert.deepEqual(missingItems(itemFor({ incident_report_present: 'True', repair_type: '' })), ['what is being repaired, and whether the car is electric']);
});

test('only open claims that need information can be called', () => {
  assert.equal(canCall(item), true);
  assert.equal(canCall(itemFor({ case_status: 'closed' })), false);
  assert.equal(canCall(itemFor({ incident_report_present: 'True' })), false); // routine
  assert.equal(canCall(itemFor({ injury_reported: 'True' })), false); // human review
});

test('the contact log keeps updates across a restart', () => {
  const log = freshLog();
  const contact = log.add({ case_id: 'T-1' });
  log.update(contact.id, { conversation_id: 'conv_1' });
  assert.equal(new ContactLog(log.path).get(contact.id).conversation_id, 'conv_1');
});

test('a closed claim is not called', async () => {
  const { call } = setup(SIGNED, [itemFor({ case_status: 'closed' })]);
  assert.equal((await call('POST', '/api/calls', startCall)).status, 400);
});

test('a call is recorded as started from the app, whatever the browser sends', async () => {
  const { call, contacts } = setup(SIGNED);
  const response = await call('POST', '/api/calls', { ...startCall, initiated_by: 'Someone else' });
  assert.equal(response.status, 201);
  assert.equal(contacts.get(response.body.contact.id).initiated_by, 'Claimly app');
});

test('the server, not the browser, decides what the agent is told', async () => {
  const { call, contacts } = setup(SIGNED);
  const response = await call('POST', '/api/calls', { ...startCall, missing_items: 'your bank details' });
  assert.equal(response.status, 201);
  assert.equal(response.body.signed_url, 'wss://signed');
  assert.deepEqual(response.body.dynamic_variables, {
    case_id: 'T-1', missing_items: 'the incident report', question: 'We still need the incident report. Can you help with that?',
  });
  assert.deepEqual(contacts.get(response.body.contact.id).missing_items, ['the incident report']);
});

test('a call that cannot start leaves no contact behind', async () => {
  const { call, contacts } = setup();
  const response = await call('POST', '/api/calls', startCall);
  assert.equal(response.status, 502);
  assert.equal(contacts.all().length, 0);
});

test('a finished call is stored and not fetched again', async () => {
  const { call, contacts, sent } = setup({
    '/v1/convai/conversations/conv_1': {
      status: 'done',
      analysis: { transcript_summary: 'Will send it Friday.', data_collection_results: { documents_expected_by: { value: 'Friday' } } },
      transcript: [{ role: 'agent', message: 'Hello' }, { role: 'user', message: null }],
    },
  });
  const contact = contacts.add({ case_id: 'T-1', conversation_id: 'conv_1' });
  const first = await call('GET', `/api/calls/result?id=${contact.id}`);
  assert.equal(first.body.contact.result.data.documents_expected_by.value, 'Friday');
  assert.equal(first.body.contact.result.transcript.length, 1);
  await call('GET', `/api/calls/result?id=${contact.id}`);
  assert.equal(sent.length, 1);
});

test('other paths are left to the main server', async () => {
  const handle = createCallApi({ env: ENV, contacts: freshLog(), findItem: () => null });
  assert.equal(await handle(new Request('http://localhost/api/cases')), null);
  assert.equal(await handle(new Request('http://localhost/api/callsx')), null);
});
