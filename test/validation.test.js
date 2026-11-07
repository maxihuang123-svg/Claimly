import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationStore } from '../validation.js';
import { POLICY_V1 } from '../policies.js';
import { parseCaseFile } from '../cases.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'impact-'));
  const store = new ValidationStore(join(dir, 'validation.jsonl'), 'engine-test');
  const items = parseCaseFile(readFileSync(new URL('../data/cases.csv', import.meta.url), 'utf8'), POLICY_V1);
  const candidate = structuredClone({ ...POLICY_V1, version: 'draft', change_note: 'Test change' });
  return { store, items, candidate };
}

test('identical rules leave all recommendations unchanged and snapshots survive restart', () => {
  const f = fixture();
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.equal(run.impact.changed, 0);
  assert.equal(run.impact.unchanged, f.items.length);
  assert.equal(run.impact.total, f.items.length);
  assert.deepEqual(run.impact.transitions, []);
  assert.equal(new ValidationStore(f.store.path, 'engine-test').events.at(-1).id, run.id);
  assert.equal(f.store.assertRelease(run.id, POLICY_V1, f.candidate, f.items, 'Approver').id, run.id);
  assert.equal('quality' in run, false);
  assert.equal('expectations' in run, false);
});

test('a changed threshold reports movements with no labels or quality gate', () => {
  const f = fixture();
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 1200;
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  const changes = run.claims.filter((r) => r.before.recommendation !== r.after.recommendation);
  assert.ok(changes.length);
  assert.equal(run.impact.changed, changes.length);
  assert.equal(run.impact.transitions.reduce((n, t) => n + t.count, 0), changes.length);
  assert.equal(run.impact.outcomes.reduce((n, r) => n + r.delta, 0), 0);
  for (const side of ['before', 'after']) assert.equal(run.impact.outcomes.reduce((n, r) => n + r[side], 0), f.items.length);
  assert.equal(f.store.assertRelease(run.id, POLICY_V1, f.candidate, f.items, 'A').id, run.id);
});

test('historical review source has no effect on impact, rechecks or run freshness', () => {
  const f = fixture();
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 1200;
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  for (const item of f.items) item.review = { reviewer: 'Someone', final_recommendation: 'human_review', note: 'Historic review' };
  const reviewedRun = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.deepEqual(run.impact, reviewedRun.impact);
  assert.deepEqual(run.claims.map((r) => r.needs_recheck), reviewedRun.claims.map((r) => r.needs_recheck));
  assert.equal(run.fingerprint, reviewedRun.fingerprint);
  assert.equal(f.store.assertRelease(run.id, POLICY_V1, f.candidate, f.items, 'A').id, run.id);
});

test('closed cases participate in simulations without being flagged for recheck', () => {
  const f = fixture();
  f.items[0].case.case_status = 'closed';
  f.items[0].case.quote_eur = 1300;
  const original = structuredClone(f.items);
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 1200;
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.equal(run.claims[0].after.recommendation, 'human_review');
  assert.equal(run.claims[0].changed, true);
  assert.equal(run.claims[0].needs_recheck, false);
  assert.deepEqual(f.items, original);
});

test('rechecks compare the selected policies rather than a recorded decision', () => {
  const f = fixture();
  f.items[0].automated.recommendation = 'human_review';
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.equal(run.claims[0].changed, false);
  assert.equal(run.claims[0].needs_recheck, false);
});

test('release still requires a current draft comparison and an approver', () => {
  const f = fixture();
  assert.throws(() => f.store.assertRelease(null, POLICY_V1, f.candidate, f.items, 'A'), /Compare/);
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.throws(() => f.store.assertRelease(run.id, POLICY_V1, f.candidate, f.items, ''), /approver/);
  const historical = f.store.run(POLICY_V1, POLICY_V1, f.items);
  assert.throws(() => f.store.assertRelease(historical.id, POLICY_V1, f.candidate, f.items, 'A'), /current draft/);
});

for (const change of ['draft', 'claims', 'engine', 'baseline']) {
  test(`${change} changes invalidate a release run`, () => {
    const f = fixture();
    const run = f.store.run(POLICY_V1, f.candidate, f.items);
    let baseline = POLICY_V1;
    if (change === 'draft') f.candidate.change_note = 'Another note';
    if (change === 'claims') f.items[0].case.quote_eur += 1;
    if (change === 'engine') f.store.engineVersion = 'updated';
    if (change === 'baseline') baseline = { ...POLICY_V1, version: 'v2' };
    assert.throws(() => f.store.assertRelease(run.id, baseline, f.candidate, f.items, 'A'), /stale/);
  });
}

test('empty input has zero impact, with no invented results', () => {
  const f = fixture();
  const run = f.store.run(POLICY_V1, f.candidate, []);
  assert.equal(run.impact.total, 0);
  assert.equal(run.impact.changed, 0);
  assert.equal(run.impact.open_rechecks, 0);
});

test('saved runs are immutable snapshots when live inputs change', () => {
  const f = fixture();
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  const quote = run.claims[0].case.quote_eur;
  f.items[0].case.quote_eur = 99999;
  f.candidate.rules[0].title = 'Edited after the run';
  assert.equal(run.claims[0].case.quote_eur, quote);
  assert.notEqual(run.candidate.rules[0].title, f.candidate.rules[0].title);
});

test('all supplied examples are tested on both sides even without imported claims', () => {
  const f = fixture();
  const run = f.store.run(POLICY_V1, f.candidate, []);
  for (const side of ['before', 'after']) {
    assert.equal(run.labelled[side].total, 14);
    assert.equal(run.labelled[side].correct, 14);
    assert.equal(run.labelled[side].incorrect_routine, 0);
    assert.equal(run.labelled[side].source, 'supplied');
  }
});

test('relaxed policy exposes incorrect routine recommendations against reference labels', () => {
  const f = fixture();
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 2000;
  const run = f.store.run(POLICY_V1, f.candidate, f.items);
  assert.equal(run.labelled.before.correct, 14);
  assert.equal(run.labelled.after.correct, 13);
  assert.equal(run.labelled.after.incorrect_routine, 1);
  assert.equal(run.labelled.after.source, 'v1_reference');
  const miss = run.labelled.examples.find((e) => e.case.case_id === 'DEV-004');
  assert.equal(miss.after.expected, 'human_review');
  assert.equal(miss.after.actual.recommendation, 'routine_processing');
  assert.ok(miss.after.actual.explanation);
});

test('independent policy labels persist, invalidate old runs and do not rewrite history', () => {
  const f = fixture();
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 2000;
  const old = f.store.run(POLICY_V1, f.candidate, f.items);
  const expected = Object.fromEntries(old.labelled.examples.map((e) => [e.case.case_id, e.after.expected]));
  expected['DEV-004'] = 'routine_processing';
  f.store.saveLabels(f.candidate, expected);
  assert.throws(() => f.store.assertRelease(old.id, POLICY_V1, f.candidate, f.items, 'A'), /stale/);
  const restarted = new ValidationStore(f.store.path, 'engine-test');
  const run = restarted.run(POLICY_V1, f.candidate, f.items);
  assert.equal(run.labelled.after.source, 'confirmed');
  assert.equal(run.labelled.after.correct, 14);
  assert.equal(run.labelled.before.source, 'supplied');
  assert.equal(old.labelled.after.correct, 13);
  assert.equal(restarted.labelsFor({ ...f.candidate, version: 'v2' }).source, 'confirmed');
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 2200;
  assert.equal(restarted.labelsFor(f.candidate).source, 'v1_reference');
});

test('incomplete or invalid example labels are rejected without writing an event', () => {
  const f = fixture();
  for (const labels of [null, {}, { 'DEV-001': 'invalid' }]) {
    assert.throws(() => f.store.saveLabels(f.candidate, labels), /every labelled example/);
  }
  assert.equal(f.store.events.length, 0);
});

test('labels can be prepared and saved before the first run without generating predictions', () => {
  const f = fixture();
  f.candidate.rules[0].when_any.find((c) => c.field === 'quote_eur').value = 2000;
  const setup = f.store.preview(POLICY_V1, f.candidate, f.items).label_setup;
  assert.equal(setup.examples.length, 14);
  assert.equal(setup.examples.some((e) => 'actual' in e || 'after' in e), false);
  const expected = { ...setup.expected, 'DEV-004': 'routine_processing' };
  f.store.saveLabels(f.candidate, expected);
  assert.equal(f.store.events.filter((e) => e.type === 'run').length, 0);
  assert.notEqual(f.store.labelSetup(f.candidate).token, setup.token);
  assert.equal(f.store.run(POLICY_V1, f.candidate, f.items).labelled.after.correct, 14);
});
