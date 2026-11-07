import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { conditionText, evaluate, normalizeCase, RECOMMENDATIONS } from './engine.js';
import { PolicyError, POLICY_V1, validatePolicy } from './policies.js';
import { parseCsv } from './csv.js';

const developmentExamples = () => parseCsv(readFileSync(new URL('./test/labelled_development_cases.csv', import.meta.url), 'utf8'))
  .map((row) => ({ case: normalizeCase(row), expected: row.expected_v1 }));

export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const rulesHash = (policy) => hash(policy.rules);
const signature = (result) => hash([result.recommendation, result.triggers, result.explanation]);

// Outcomes identify the three ordered rules in the existing policy schema.
export function policyDiff(baseline, candidate) {
  const changes = [];
  for (const outcome of new Set([...baseline.rules, ...candidate.rules].map((r) => r.outcome))) {
    const before = baseline.rules.find((r) => r.outcome === outcome);
    const after = candidate.rules.find((r) => r.outcome === outcome);
    const removed = (before?.when_any ?? []).filter((c) => !(after?.when_any ?? []).some((d) => hash(c) === hash(d)));
    const added = (after?.when_any ?? []).filter((c) => !(before?.when_any ?? []).some((d) => hash(c) === hash(d)));
    for (const c of removed) changes.push({ kind: 'Removed', outcome, field: c.field, text: conditionText(c) });
    for (const c of added) changes.push({ kind: 'Added', outcome, field: c.field, text: conditionText(c) });
  }
  if (baseline.rules.map((r) => r.outcome).join() !== candidate.rules.map((r) => r.outcome).join()) {
    changes.push({ kind: 'Changed', text: 'Rule priority changed', field: null });
  }
  return changes;
}

// Counts describe policy effects, never accuracy against an assumed answer.
export function impactSummary(claims) {
  const outcomes = RECOMMENDATIONS.map((outcome) => {
    const before = claims.filter((c) => c.before.recommendation === outcome).length;
    const after = claims.filter((c) => c.after.recommendation === outcome).length;
    return { outcome, before, after, delta: after - before };
  });
  const transitions = [];
  for (const from of RECOMMENDATIONS) for (const to of RECOMMENDATIONS) {
    if (from === to) continue;
    const ids = claims.filter((c) => c.before.recommendation === from && c.after.recommendation === to).map((c) => c.case.case_id);
    if (ids.length) transitions.push({ from, to, count: ids.length, case_ids: ids });
  }
  return { total: claims.length, changed: claims.filter((c) => c.changed).length,
    unchanged: claims.filter((c) => !c.changed).length,
    reason_only: claims.filter((c) => !c.changed && c.reason_changed).length,
    open_rechecks: claims.filter((c) => c.needs_recheck).length,
    closed: claims.filter((c) => c.case.case_status === 'closed').length, outcomes, transitions };
}

export class ValidationStore {
  constructor(path, engineVersion, examples = developmentExamples()) {
    this.path = path;
    this.engineVersion = engineVersion;
    this.examples = examples;
    // Older quality runs remain in the audit file; only impact runs are used by this workflow.
    this.events = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  write(event) {
    const entry = structuredClone({ id: randomUUID(), created_at: new Date().toISOString(), ...event });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.events.push(entry);
    return entry;
  }
  fingerprint(baseline, candidate, items) {
    return hash({ mode: 'impact', baseline, candidate, cases: items.map((item) => item.case), engine: this.engineVersion,
      examples: this.examples, labels: [this.labelsFor(baseline), this.labelsFor(candidate)] });
  }
  labelsFor(policy) {
    const saved = this.events.findLast((e) => e.type === 'labels' && e.rules_hash === rulesHash(policy) && e.examples_hash === hash(this.examples));
    return { source: saved ? 'confirmed' : rulesHash(policy) === rulesHash(POLICY_V1) ? 'supplied' : 'v1_reference',
      expected: saved?.expected ?? Object.fromEntries(this.examples.map((e) => [e.case.case_id, e.expected])) };
  }
  labelSetup(policy) {
    const labels = this.labelsFor(policy);
    return { ...labels, examples: this.examples.map((e) => e.case),
      token: hash([rulesHash(policy), this.examples, labels]) };
  }
  saveLabels(policy, expected) {
    const ids = this.examples.map((e) => e.case.case_id);
    if (!expected || typeof expected !== 'object' || Object.keys(expected).length !== ids.length || ids.some((id) => !RECOMMENDATIONS.includes(expected[id]))) {
      throw new PolicyError('Choose an expected recommendation for every labelled example.');
    }
    return this.write({ type: 'labels', rules_hash: rulesHash(policy), examples_hash: hash(this.examples), policy_version: policy.version, expected });
  }
  labelledResults(baseline, candidate) {
    const labels = { before: this.labelsFor(baseline), after: this.labelsFor(candidate) };
    const examples = this.examples.map((example) => {
      const result = { case: example.case };
      for (const [side, policy] of [['before', baseline], ['after', candidate]]) {
        const actual = evaluate(example.case, policy), expected = labels[side].expected[example.case.case_id];
        result[side] = { actual, expected, correct: actual.recommendation === expected,
          incorrect_routine: actual.recommendation === 'routine_processing' && expected !== 'routine_processing' };
      }
      return result;
    });
    const summary = Object.fromEntries(['before', 'after'].map((side) => [side, {
      source: labels[side].source, total: examples.length, correct: examples.filter((e) => e[side].correct).length,
      incorrect_routine: examples.filter((e) => e[side].incorrect_routine).length,
      unnecessary_human: examples.filter((e) => e[side].actual.recommendation === 'human_review' && e[side].expected !== 'human_review').length,
      wrong: examples.filter((e) => !e[side].correct).length,
    }]));
    return { ...summary, examples, examples_hash: hash(this.examples) };
  }
  preview(baseline, candidate, items = []) {
    return { changes: policyDiff(baseline, candidate), total: items.length, label_setup: this.labelSetup(candidate) };
  }
  run(baseline, candidate, items, reviewer) {
    for (const policy of [baseline, candidate]) {
      const errors = validatePolicy(policy);
      if (errors.length) throw new PolicyError(errors.join(' '));
    }
    const claims = items.map((item) => {
      const before = evaluate(item.case, baseline), after = evaluate(item.case, candidate);
      return { ...item, before, after, changed: before.recommendation !== after.recommendation,
        reason_changed: signature(before) !== signature(after),
        needs_recheck: item.case.case_status === 'open' && signature(before) !== signature(after) };
    });
    return this.write({ type: 'run', mode: 'impact', reviewer: String(reviewer ?? '').trim() || null,
      baseline, candidate, engine_version: this.engineVersion,
      fingerprint: this.fingerprint(baseline, candidate, items),
      claims, changes: policyDiff(baseline, candidate), impact: impactSummary(claims), labelled: this.labelledResults(baseline, candidate) });
  }
  assertRelease(runId, baseline, candidate, items, approver) {
    const run = this.events.find((e) => e.type === 'run' && e.mode === 'impact' && e.id === runId);
    if (!run || run.candidate.version !== 'draft') throw new PolicyError('Compare the current draft before activation.');
    if (!String(approver ?? '').trim()) throw new PolicyError('Add the approver name.');
    if (run.fingerprint !== this.fingerprint(baseline, candidate, items)) throw new PolicyError('Comparison is stale. The policy or claim facts changed. Run the comparison again.');
    return run;
  }
}
