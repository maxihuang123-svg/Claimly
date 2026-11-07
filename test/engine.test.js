import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCsv } from '../csv.js';
import { evaluate, normalizeCase } from '../engine.js';
import { POLICY_V1 } from '../policies.js';

const labelled = parseCsv(readFileSync(new URL('./labelled_development_cases.csv', import.meta.url), 'utf8'));
const base = {
  case_id: 'T-1', case_status: 'open', claim_summary: '', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '500',
  incident_report_present: 'True', itemized_quote_present: 'True', injury_reported: 'False',
  liability_disputed: 'False', duplicate_flag: 'False', evidence_conflict: 'False',
};
const run = (overrides) => evaluate(normalizeCase({ ...base, ...overrides }), POLICY_V1);

test('reads all 14 labelled cases', () => assert.equal(labelled.length, 14));

for (const row of labelled) {
  test(`${row.case_id} gives ${row.expected_v1}`, () => {
    assert.equal(evaluate(normalizeCase(row), POLICY_V1).recommendation, row.expected_v1);
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

test('the reason and evidence read as one decision', () => {
  const result = run({ quote_eur: '1800' });
  assert.equal(result.reason, 'The €1,800 repair quote exceeds the €1,500 limit.');
  assert.deepEqual(result.evidence, [{ label: 'Quote', value: '€1,800', blank: false }]);
  assert.equal(result.priority_note, null);
});

test('an unknown value says Not provided, and a known false stays distinct', () => {
  const blank = run({ incident_report_present: '' });
  assert.equal(blank.recommendation, 'request_information');
  assert.equal(blank.reason, 'Not provided: incident report.');
  assert.deepEqual(blank.evidence, [{ label: 'Incident report', value: 'Not provided', blank: true }]);

  const missing = run({ incident_report_present: 'False' });
  assert.equal(missing.reason, 'The incident report is missing.');
  assert.deepEqual(missing.evidence, [{ label: 'Incident report', value: 'Missing', blank: false }]);

  const injury = run({ injury_reported: '' }).rules[0].checks.find((check) => check.field === 'injury_reported');
  assert.equal(injury.value, 'Not provided');
  assert.equal(run({}).rules[0].checks.find((check) => check.field === 'injury_reported').value, 'No');
});

test('a known trigger keeps its reason, and the blank is noted beside it', () => {
  const result = run({ quote_eur: '1800', injury_reported: '' });
  assert.equal(result.recommendation, 'human_review');
  assert.equal(result.reason, 'The €1,800 repair quote exceeds the €1,500 limit.');
  assert.match(result.priority_note, /^Not provided: injury reported\. Rule 1 takes priority/);
});

test('a blank field does not hide a known trigger', () => {
  assert.equal(run({ quote_eur: '', evidence_conflict: 'True' }).recommendation, 'human_review');
});

test('csv parser keeps commas inside quoted fields', () => {
  const [row] = parseCsv('a,b\r\n"x, ""y""",2\r\n');
  assert.deepEqual(row, { a: 'x, "y"', b: '2' });
});

const withRules = (rules) => ({ version: 'v2', rules });
const evPolicy = withRules([
  { ...POLICY_V1.rules[0], when_any: [...POLICY_V1.rules[0].when_any, { field: 'repair_type', op: '=', value: 'ev_high_voltage_battery' }] },
  POLICY_V1.rules[1],
  POLICY_V1.rules[2],
]);
const runPolicy = (policy, overrides) => evaluate(normalizeCase({ ...base, ...overrides }), policy);

test('a new policy can test a field v1 ignores, and names itself in the result', () => {
  const result = runPolicy(evPolicy, { repair_type: 'ev_high_voltage_battery' });
  assert.equal(result.recommendation, 'human_review');
  assert.equal(result.policy_version, 'v2');
  assert.equal(result.rule_id, 'v2.rule1');
  assert.deepEqual(result.triggers, ['repair_type']);
  assert.match(result.explanation, /Repair type is EV high voltage battery/);
});

test('a blank is not read as a value in any policy version', () => {
  assert.equal(runPolicy(evPolicy, { repair_type: '' }).recommendation, 'request_information');
  assert.equal(runPolicy(evPolicy, { repair_type: '', injury_reported: 'True' }).recommendation, 'human_review');
});

test('the blank check still applies when a policy has several request information rules', () => {
  const rule = (field) => ({ title: 'Ask', outcome: 'request_information', when_any: [{ field, op: '=', value: false }] });
  const policy = withRules([POLICY_V1.rules[0], rule('incident_report_present'), rule('itemized_quote_present'), POLICY_V1.rules[2]]);
  const result = runPolicy(policy, { itemized_quote_present: 'False' });
  assert.equal(result.rule_id, 'v2.rule3');
  assert.equal(runPolicy(policy, {}).recommendation, 'routine_processing');
  assert.equal(runPolicy(policy, { duplicate_flag: '' }).rule_id, 'v2.rule2');
});
