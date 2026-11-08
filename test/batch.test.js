import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { batchResults, RESULT_COLUMNS } from '../src/batch.js';
import { REQUIRED_COLUMNS } from '../src/cases.js';
import { parseCsv } from '../src/csv.js';

const BASE = {
  case_id: 'T-1', case_status: 'open', claim_summary: 'Test', policy_active_on_incident: 'True',
  claim_type: 'motor_own_damage', repair_type: 'standard', quote_eur: '500', incident_report_present: 'True',
  itemized_quote_present: 'True', injury_reported: 'False', liability_disputed: 'False', duplicate_flag: 'False',
  evidence_conflict: 'False',
};
const csvOf = (...rows) => [REQUIRED_COLUMNS.join(','), ...rows.map((row, index) => REQUIRED_COLUMNS
  .map((column) => ({ ...BASE, case_id: `T-${index + 1}`, ...row })[column]).join(','))].join('\n');
const results = (...rows) => batchResults(csvOf(...rows));

test('€1,200 stays within the v2 limit and €1,201 goes to human review', () => {
  const [at, over] = results({ quote_eur: '1200' }, { quote_eur: '1201' });
  assert.deepEqual([at.recommendation_v2, at.needs_recheck], ['routine_processing', false]);
  assert.deepEqual([over.recommendation_v1, over.recommendation_v2, over.needs_recheck], ['routine_processing', 'human_review', true]);
  assert.equal(over.rule_v2, 'v2.rule1');
});

test('an EV battery repair goes to human review under v2, ahead of a missing document', () => {
  const [row] = results({ repair_type: 'ev_high_voltage_battery', itemized_quote_present: 'False' });
  assert.deepEqual([row.recommendation_v1, row.recommendation_v2, row.needs_recheck], ['request_information', 'human_review', true]);
});

test('a closed claim keeps its v1 decision and never needs a recheck', () => {
  const [row] = results({ case_status: 'closed', quote_eur: '1400' });
  assert.equal(row.recommendation_v1, 'routine_processing');
  assert.equal(row.recommendation_v2, 'routine_processing');
  assert.equal(row.rule_v2, row.rule_v1);
  assert.equal(row.needs_recheck, false);
  assert.match(row.explanation, /^Closed claim/);
});

test('blank fields are absent facts: information is requested unless a known fact sends the claim to review', () => {
  const [blankQuote, blankButInjured] = results({ quote_eur: '' }, { quote_eur: '', injury_reported: 'True' });
  assert.equal(blankQuote.recommendation_v2, 'request_information');
  assert.equal(blankButInjured.recommendation_v2, 'human_review');
});

test('every labelled development case gets its expected v1 recommendation', () => {
  const text = readFileSync(new URL('./labelled_development_cases.csv', import.meta.url), 'utf8');
  const expected = Object.fromEntries(parseCsv(text).map((row) => [row.case_id.trim(), row.expected_v1.trim()]));
  for (const row of batchResults(text)) assert.equal(row.recommendation_v1, expected[row.case_id], row.case_id);
});

test('the command writes the results CSV in the required format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-'));
  const input = join(dir, 'claims.csv');
  const output = join(dir, 'out', 'results.csv');
  writeFileSync(input, csvOf({ quote_eur: '1300' }, { case_status: 'closed' }));
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/batch.js', import.meta.url)), input, output]);
  const [header, ...lines] = readFileSync(output, 'utf8').trim().split('\n');
  assert.equal(header, RESULT_COLUMNS.join(','));
  assert.match(lines[0], /^T-1,routine_processing,human_review,True,v1\.rule3,v2\.rule1,/);
  assert.match(lines[1], /^T-2,routine_processing,routine_processing,False,v1\.rule3,v1\.rule3,/);
});

test('text codes are read regardless of capitals', () => {
  const [row] = results({ case_status: 'Open', claim_type: 'Motor_Own_Damage', repair_type: 'STANDARD' });
  assert.deepEqual([row.recommendation_v1, row.recommendation_v2], ['routine_processing', 'routine_processing']);
  const [closed] = results({ case_status: 'CLOSED', quote_eur: '1300' });
  assert.equal(closed.needs_recheck, false);
});
