import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REQUIRED_COLUMNS } from '../cases.js';
import { FIELDS } from '../engine.js';
import { describePolicy, POLICY_CHOICES, POLICY_V1, PolicyError, PolicyStore, validatePolicy } from '../policies.js';

const freshStore = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'policies-')), 'policies.jsonl');
  return { path, store: new PolicyStore(path) };
};
const edit = (changes) => ({ change_note: 'Raise the limit.', rules: POLICY_V1.rules, ...changes });
const errorsFor = (rules) => validatePolicy({ change_note: 'x', rules });
const [human, info, routine] = POLICY_V1.rules;

test('v1 is valid and is the current policy on a fresh store', () => {
  assert.deepEqual(validatePolicy(POLICY_V1), []);
  assert.equal(freshStore().store.current.version, 'v1');
});

test('every field a policy can test is a required CSV column', () => {
  for (const field of Object.keys(FIELDS)) assert.ok(REQUIRED_COLUMNS.includes(field), field);
});

test('v1 reads back as sentences', () => {
  const [first] = describePolicy(POLICY_V1).rules;
  assert.deepEqual(first.when_any.slice(0, 3).map((item) => item.text), [
    'Policy not active on the incident date', 'Claim type is not motor own damage', 'Quote is over €1,500',
  ]);
});

test('a draft starts from the current rules and only one can exist', () => {
  const { store } = freshStore();
  assert.deepEqual(store.startDraft().rules, POLICY_V1.rules);
  assert.throws(() => store.startDraft(), PolicyError);
});

test('a draft does not change the current policy until it is activated', () => {
  const { store } = freshStore();
  store.saveDraft(edit());
  assert.equal(store.current.version, 'v1');
  const policy = store.activateDraft();
  assert.equal(policy.version, 'v2');
  assert.equal(store.current.version, 'v2');
  assert.equal(store.draft, null);
  assert.equal(store.find('v1'), POLICY_V1);
});

test('an invalid draft can be saved but not activated', () => {
  const { store } = freshStore();
  store.saveDraft(edit({ change_note: '' }));
  assert.throws(() => store.activateDraft(), /change note/);
  assert.equal(store.current.version, 'v1');
});

test('discarding a draft keeps the current policy, and there must be a draft to act on', () => {
  const { store } = freshStore();
  assert.throws(() => store.activateDraft(), PolicyError);
  assert.throws(() => store.discardDraft(), PolicyError);
  store.saveDraft(edit());
  store.discardDraft();
  assert.equal(store.draft, null);
  assert.equal(store.current.version, 'v1');
});

test('versions and the draft survive a restart', () => {
  const { path, store } = freshStore();
  store.saveDraft(edit());
  store.activateDraft();
  store.saveDraft(edit({ change_note: 'Next' }));
  const reopened = new PolicyStore(path);
  assert.equal(reopened.current.version, 'v2');
  assert.equal(reopened.find('v2').change_note, 'Raise the limit.');
  assert.equal(reopened.draft.change_note, 'Next');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 3);
});

test('rule order protects blank handling', () => {
  assert.match(errorsFor([info, human, routine]).join(), /must come before/);
  assert.match(errorsFor([human, routine]).join(), /request information rule/);
  assert.match(errorsFor([info, routine]).join(), /human review rule/);
  assert.match(errorsFor([human, info]).join(), /last rule must be routine/);
  assert.match(errorsFor([human, info, { ...routine, when_any: human.when_any }]).join(), /last rule must be routine/);
  assert.match(errorsFor([human, routine, info, routine]).join(), /Only the last rule/);
});

test('rules and conditions are checked', () => {
  const conditions = (when_any) => errorsFor([{ ...human, when_any }, info, routine]).join();
  assert.match(conditions([]), /Rule 1: choose at least one check/);
  assert.match(errorsFor([{ ...human, title: ' ' }, info, routine]).join(), /Rule 1: add a title/);
  assert.match(conditions([{ field: 'claim_summary', op: '=', value: 'x' }]), /choose a field/);
  assert.match(conditions([{ field: 'quote_eur', op: '=', value: 1 }]), /cannot use/);
  assert.match(conditions([{ field: 'quote_eur', op: '>', value: null }]), /needs a number/);
  assert.match(conditions([{ field: 'quote_eur', op: '>', value: -1 }]), /needs a number/);
  assert.match(conditions([{ field: 'injury_reported', op: '=', value: 'true' }]), /needs a value/);
  assert.match(conditions([{ field: 'repair_type', op: '=', value: ' ' }]), /needs a value/);
});

test('a yes/no field cannot be checked both ways in one rule', () => {
  const both = { ...human, when_any: [...human.when_any, { field: 'policy_active_on_incident', op: '=', value: true }] };
  assert.match(errorsFor([both, info, routine]).join(), /Rule 1: Policy active on incident date is checked both ways/);
});

test('every v1 check is offered, and so is the repair type v1 ignores', () => {
  const offered = (rule) => POLICY_CHOICES[rule.outcome];
  for (const rule of [human, info]) {
    for (const item of rule.when_any) assert.ok(offered(rule).includes(item), item.field);
  }
  assert.ok(POLICY_CHOICES.human_review.some((item) => item.field === 'repair_type'));
});

test('a draft keeps one rule per outcome, without losing any check', () => {
  const { store } = freshStore();
  const extra = { ...info, title: 'Second', when_any: [{ field: 'duplicate_flag', op: '=', value: false }] };
  const draft = store.saveDraft({ change_note: 'x', rules: [human, info, extra, routine] });
  assert.deepEqual(draft.rules.map((rule) => rule.outcome), ['human_review', 'request_information', 'routine_processing']);
  assert.equal(draft.rules[1].when_any.length, 3);
  assert.equal(info.when_any.length, 2);
});

test('a malformed draft is refused', () => {
  assert.throws(() => freshStore().store.saveDraft({ rules: 'none' }), PolicyError);
});
