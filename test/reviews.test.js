import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate, normalizeCase } from '../engine.js';
import { ReviewError, ReviewLog } from '../reviews.js';

const record = normalizeCase({
  case_id: 'T-1', case_status: 'open', claim_summary: '', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '2000',
  incident_report_present: 'True', itemized_quote_present: 'True', injury_reported: 'False',
  liability_disputed: 'False', duplicate_flag: 'False', evidence_conflict: 'False',
});
const item = { case: record, automated: evaluate(record) };
const freshLog = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'reviews-')), 'reviews.jsonl');
  return { path, log: new ReviewLog(path) };
};

const routineRecord = { ...record, quote_eur: 500 };
const routineItem = { case: routineRecord, automated: evaluate(routineRecord) };
const resolve = { reviewer: 'A', final_recommendation: 'routine_processing', reason_code: 'resolved_after_review' };

test('a confirmation needs no reason', () => {
  const { log } = freshLog();
  const saved = log.record(routineItem, { reviewer: 'A', final_recommendation: 'routine_processing' });
  assert.equal(saved.outcome, 'confirmed');
  assert.equal(saved.reason_code, null);
});

test('a case in human review cannot be sent to human review again', () => {
  const { log } = freshLog();
  assert.throws(() => log.record(item, { reviewer: 'A', final_recommendation: 'human_review' }), /already in human review/);
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
