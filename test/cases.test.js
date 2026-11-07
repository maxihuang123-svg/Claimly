import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseFileError, parseCaseFile, REQUIRED_COLUMNS, reviewStillApplies } from '../cases.js';

const header = REQUIRED_COLUMNS.join(',');
const row = (id, quote = '500') => `${id},open,Summary,True,motor_own_damage,standard,${quote},True,True,False,False,False,False`;

test('a valid file gives evaluated cases, and extra columns are ignored', () => {
  const [item] = parseCaseFile(`${header},expected_v1\n${row('A')},routine_processing\n`);
  assert.equal(item.automated.recommendation, 'routine_processing');
});

test('bad files are rejected with a specific message', () => {
  assert.throws(() => parseCaseFile(''), CaseFileError);
  assert.throws(() => parseCaseFile(`${header}\n`), /no cases/);
  assert.throws(() => parseCaseFile(`case_id,quote_eur\nA,1\n`), /missing these columns: case_status/);
  assert.throws(() => parseCaseFile(`${header}\n${row('A')}\n${row('A')}\n`), /A appears more than once/);
  assert.throws(() => parseCaseFile(`${header}\n${row('')}\n`), /Row 1 has no case_id/);
  assert.throws(() => parseCaseFile(`${header}\nA,open\n`), /Row 1 has 2 values/);
});

test('a review lapses when the automated decision changes', () => {
  const [before] = parseCaseFile(`${header}\n${row('A')}\n`);
  const [after] = parseCaseFile(`${header}\n${row('A', '2000')}\n`);
  const [sameDecision] = parseCaseFile(`${header}\n${row('A', '600')}\n`);
  const review = { automated: before.automated };
  assert.equal(reviewStillApplies(review, after.automated), false);
  assert.equal(reviewStillApplies(review, sameDecision.automated), true);
});
