import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate, normalizeCase } from '../src/engine.js';
import { POLICY_V1 } from '../src/policies.js';
import { ReviewError, ReviewLog } from '../src/reviews.js';

const record = normalizeCase({
  case_id: 'T-1', case_status: 'open', claim_summary: '', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '2000',
  incident_report_present: 'True', itemized_quote_present: 'True', injury_reported: 'False',
  liability_disputed: 'False', duplicate_flag: 'False', evidence_conflict: 'False',
});
const item = { case: record, automated: evaluate(record, POLICY_V1) };
const freshLog = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'reviews-')), 'reviews.jsonl');
  return { path, log: new ReviewLog(path) };
};

const routineRecord = { ...record, quote_eur: 500 };
const routineItem = { case: routineRecord, automated: evaluate(routineRecord, POLICY_V1) };
const resolve = { reviewer: 'A', final_recommendation: 'routine_processing', reason_code: 'resolved_after_review' };

const confirm = { reviewer: 'A', reason_code: 'evidence_supports' };

test('a confirmation records its reviewer and reason', () => {
  const { log } = freshLog();
  const saved = log.record(routineItem, { ...confirm, final_recommendation: 'routine_processing' });
  assert.equal(saved.outcome, 'confirmed');
  assert.equal(saved.reviewer, 'A');
  assert.equal(saved.reason_code, 'evidence_supports');
});

test('a confirmation needs a reason, and it must be a confirmation reason', () => {
  const { log } = freshLog();
  const decision = { reviewer: 'A', final_recommendation: 'routine_processing' };
  assert.throws(() => log.record(routineItem, decision), /Choose a reason/);
  assert.throws(() => log.record(routineItem, { ...decision, reason_code: 'policy_gap' }), /does not apply/);
});

test('a change cannot use a confirmation reason', () => {
  const { log } = freshLog();
  assert.throws(() => log.record(item, { ...resolve, reason_code: 'evidence_supports' }), /does not apply/);
});

test('a review needs a reviewer', () => {
  const { log } = freshLog();
  assert.throws(() => log.record(item, { ...resolve, reviewer: undefined }), /reviewer/);
  assert.throws(() => log.record(item, { ...resolve, reviewer: '  ' }), /reviewer/);
});

test('a case in human review cannot be sent to human review again', () => {
  const { log } = freshLog();
  assert.throws(() => log.record(item, { ...confirm, final_recommendation: 'human_review' }), /already in human review/);
});

test('history keeps every review and undo, in order, across a restart', () => {
  const { path, log } = freshLog();
  log.record(item, resolve);
  log.retract('T-1', 'B');
  const events = new ReviewLog(path).history('T-1');
  assert.deepEqual(events.map((event) => event.event), ['review', 'retraction']);
  assert.equal(events[1].reviewer, 'B');
  assert.deepEqual(log.history('unknown'), []);
});

test('settling a correct escalation is not counted as an automation error', () => {
  const { log } = freshLog();
  assert.equal(log.record(item, resolve).outcome, 'resolved');
  assert.equal(log.record(item, { ...resolve, reason_code: 'policy_gap' }).outcome, 'changed');
});

test('a change needs a reason, and Other needs a note', () => {
  const { log } = freshLog();
  const change = { reviewer: 'A', final_recommendation: 'routine_processing' };
  assert.throws(() => log.record(item, change), ReviewError);
  assert.throws(() => log.record(item, { ...change, reason_code: 'other' }), ReviewError);
  assert.equal(log.record(item, { ...change, reason_code: 'policy_gap' }).outcome, 'changed');
});

test('the automated decision is snapshotted from the server, not the request', () => {
  const { log } = freshLog();
  const saved = log.record(item, { ...resolve, automated: { rule_id: 'forged' } });
  assert.equal(saved.automated.rule_id, 'v1.rule1');
});

test('undo restores the previous review and the log survives a restart', () => {
  const { path, log } = freshLog();
  const first = log.record(item, resolve);
  const second = log.record(item, { reviewer: 'A', final_recommendation: 'routine_processing', reason_code: 'policy_gap' });
  assert.equal(second.supersedes, first.review_id);
  log.retract('T-1', 'A');
  assert.equal(log.current('T-1').review_id, first.review_id);
  assert.equal(new ReviewLog(path).current('T-1').review_id, first.review_id);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 3);
});

test('automatically routed cases can be corrected to human review with a durable audit trail', () => {
  for (const source of [routineRecord, { ...routineRecord, itemized_quote_present: false }]) {
    const routed = { case: source, automated: evaluate(source, POLICY_V1) };
    assert.notEqual(routed.automated.recommendation, 'human_review');
    const { path, log } = freshLog();
    log.record(routed, {
      reviewer: 'Test reviewer', final_recommendation: 'human_review',
      reason_code: 'policy_gap', note: 'Specialist assessment required.',
    });
    const saved = new ReviewLog(path).current(source.case_id);
    assert.equal(saved.final_recommendation, 'human_review');
    assert.equal(saved.automated.recommendation, routed.automated.recommendation);
    assert.equal(saved.automated.policy_version, POLICY_V1.version);
    assert.equal(saved.reviewer, 'Test reviewer');
    assert.equal(saved.reason_code, 'policy_gap');
    assert.equal(saved.note, 'Specialist assessment required.');
    assert.equal(saved.outcome, 'changed');
  }
});
