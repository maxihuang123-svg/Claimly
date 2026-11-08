import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quality, OutcomeStore, measurementPayload } from '../src/measurement.js';
import { ValidationStore } from '../src/validation.js';
import { POLICY_V1 } from '../src/policies.js';
const row = (actual, expected) => ({ after: { actual: { recommendation: actual }, expected, correct: actual === expected } });
test('quality uses an explicit denominator and separates expensive errors from escalations', () => {
  const rows = [row('routine_processing', 'human_review'), row('human_review', 'request_information'), row('human_review', 'human_review')];
  const q = quality(rows, 'after');
  assert.deepEqual(q.incorrect_routine, { count: 1, total: 3, rate: 1 / 3 });
  assert.equal(q.unnecessary_human.count, 1);
  assert.equal(q.correct.count, 1);
  assert.equal(quality([], 'after').correct.rate, null);
});
test('outcomes require independent evidence, preserve original decisions and append revisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  const store = new OutcomeStore(join(dir, 'outcomes.jsonl'));
  const item = { case: { case_id: 'A', case_status: 'open' }, automated: { recommendation: 'routine_processing', policy_version: 'v1' } };
  assert.throws(() => store.record(item, { expected: 'human_review' }), /assessor/);
  assert.throws(() => store.record(item, { expected: 'paid', assessor: 'A', evidence: 'Report' }), /next step/);
  store.record(item, { expected: 'human_review', assessor: 'A', evidence: 'Independent audit of injury evidence' });
  item.automated = { recommendation: 'human_review', policy_version: 'v2' };
  assert.equal(store.events[0].automated.policy_version, 'v1');
  store.record(item, { expected: 'human_review', assessor: 'B', evidence: 'Reassessment' });
  const reopened = new OutcomeStore(store.path);
  assert.equal(reopened.events.length, 2);
  const validation = new ValidationStore(join(dir, 'validation.jsonl'), 'test');
  const payload = measurementPayload([item], POLICY_V1, POLICY_V1, validation, reopened);
  assert.equal(payload.outcomes.length, 1);
  assert.equal(payload.outcome_events, 2);
  assert.equal(payload.outcome_versions[0].version, 'v2');
});
test('live measurement separates changed labels, missing facts and resolved escalations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  const v = new ValidationStore(join(dir, 'validation.jsonl'), 'test');
  const candidate = structuredClone(POLICY_V1); candidate.version = 'v2';
  candidate.rules[0].when_any.find(c => c.field === 'quote_eur').value = 2000;
  const items = [{ case: { case_id: 'A', quote_eur: null }, automated: { recommendation: 'human_review' }, needs_recheck: true,
    review: { outcome: 'resolved', reason_code: 'resolved_after_review' } }];
  const p = measurementPayload(items, POLICY_V1, candidate, v, new OutcomeStore(join(dir, 'outcomes.jsonl')));
  assert.equal(p.quality[0].before.correct.count, 14);
  assert.equal(p.quality[0].after.incorrect_routine.count, 1);
  assert.equal(p.quality[1].after.correct.total, 1);
  assert.equal(p.quality[2].after.correct.count, 13);
  assert.equal(p.operations.overrides, 0);
  assert.equal(p.operations.resolved_escalations, 1);
  assert.equal(p.operations.missing_facts, 1);
  assert.equal(p.operations.rechecks, 1);
  assert.equal(p.label_sources.after, 'v1_reference');
});

test('outcome snapshots stay immutable when the caller edits facts or recommendation in memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'measure-'));
  const store = new OutcomeStore(join(dir, 'outcomes.jsonl'));
  const item = { case: { case_id: 'A', quote_eur: 100 }, automated: { policy_version: 'v1', recommendation: 'routine_processing' } };
  store.record(item, { expected: 'routine_processing', assessor: 'Assessor', evidence: 'Audit record' });
  item.case.quote_eur = 2000;
  item.automated.policy_version = 'v2';
  assert.equal(store.events[0].facts.quote_eur, 100);
  assert.equal(store.events[0].automated.policy_version, 'v1');
});
