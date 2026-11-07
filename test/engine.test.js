import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCsv } from '../csv.js';
import { evaluate, normalizeCase } from '../engine.js';

const labelled = parseCsv(readFileSync(new URL('./labelled_development_cases.csv', import.meta.url), 'utf8'));
const base = {
  case_id: 'T-1', case_status: 'open', claim_summary: '', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '500',
  incident_report_present: 'True', itemized_quote_present: 'True', injury_reported: 'False',
  liability_disputed: 'False', duplicate_flag: 'False', evidence_conflict: 'False',
};
const run = (overrides) => evaluate(normalizeCase({ ...base, ...overrides }));

test('reads all 14 labelled cases', () => assert.equal(labelled.length, 14));

for (const row of labelled) {
  test(`${row.case_id} gives ${row.expected_v1}`, () => {
    assert.equal(evaluate(normalizeCase(row)).recommendation, row.expected_v1);
  });
}

test('the quote limit is inclusive', () => {
  assert.equal(run({ quote_eur: '1500' }).recommendation, 'routine_processing');
  assert.equal(run({ quote_eur: '1501' }).recommendation, 'human_review');
});

test('a known review trigger beats a missing document, and the trace shows both', () => {
  const result = run({ injury_reported: 'True', incident_report_present: 'False' });
  assert.equal(result.rule_id, 'v1.rule1');
  assert.deepEqual(result.triggers, ['injury_reported']);
  assert.equal(result.rules[1].would_also_match, true);
  assert.match(result.explanation, /Rule 1 takes priority/);
});

test('blank fields are never read as a value', () => {
  for (const field of ['quote_eur', 'policy_active_on_incident', 'injury_reported', 'claim_type', 'repair_type']) {
    assert.equal(run({ [field]: '' }).recommendation, 'request_information', field);
  }
});

test('an unreadable value is treated as blank', () => {
  assert.equal(run({ quote_eur: 'illegible' }).recommendation, 'request_information');
  assert.equal(run({ duplicate_flag: 'maybe' }).recommendation, 'request_information');
});

test('a blank field does not hide a known trigger', () => {
  assert.equal(run({ quote_eur: '', evidence_conflict: 'True' }).recommendation, 'human_review');
});

test('csv parser keeps commas inside quoted fields', () => {
  const [row] = parseCsv('a,b\r\n"x, ""y""",2\r\n');
  assert.deepEqual(row, { a: 'x, "y"', b: '2' });
});
