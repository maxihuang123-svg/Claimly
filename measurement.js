import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './validation.js';
import { RECOMMENDATIONS } from './engine.js';
import { ReviewError } from './reviews.js';

export const ratio = (count, total) => ({ count, total, rate: total ? count / total : null });
export function quality(rows, side) {
  return {
    correct: ratio(rows.filter(r => r[side].correct).length, rows.length),
    incorrect_routine: ratio(rows.filter(r => r[side].actual.recommendation === 'routine_processing' && r[side].expected !== 'routine_processing').length, rows.length),
    unnecessary_human: ratio(rows.filter(r => r[side].actual.recommendation === 'human_review' && r[side].expected !== 'human_review').length, rows.length),
  };
}
export class OutcomeStore {
  constructor(path) {
    this.path = path;
    this.events = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  record(item, input) {
    const assessor = String(input.assessor ?? '').trim();
    const evidence = String(input.evidence ?? '').trim();
    if (!assessor || !evidence) throw new ReviewError('Add the assessor and independent evidence for this outcome.');
    if (!RECOMMENDATIONS.includes(input.expected)) throw new ReviewError('Choose the correct next step at the time of triage.');
    const event = structuredClone({ id: randomUUID(), created_at: new Date().toISOString(), case_id: item.case.case_id,
      assessor, evidence, expected: input.expected, automated: item.automated, facts: item.case });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    this.events.push(event);
    return event;
  }
}
export function measurementPayload(items, baseline, candidate, validation, outcomes) {
  const labelled = validation.labelledResults(baseline, candidate);
  const changed = labelled.examples.filter(r => r.before.actual.recommendation !== r.after.actual.recommendation || r.before.expected !== r.after.expected);
  const groups = [['All examples', labelled.examples], ['Affected by change', changed], ['Unaffected examples', labelled.examples.filter(r => !changed.includes(r))]];
  const reviews = items.filter(i => i.review);
  const latest = new Map();
  for (const event of outcomes.events) latest.set(event.case_id, event);
  // Outcomes remain attached to the decision and facts assessed, even after a later policy change.
  const resolved = [...latest.values()].map(e => ({ ...e, correct: e.automated.recommendation === e.expected }));
  const versions = [...new Set(resolved.map(e => e.automated.policy_version))].map(version => {
    const cohort = resolved.filter(e => e.automated.policy_version === version);
    return { version, assessed: cohort.length, correct: cohort.filter(e => e.correct).length,
      incorrect_routine: cohort.filter(e => e.automated.recommendation === 'routine_processing' && !e.correct).length,
      unnecessary_human: cohort.filter(e => e.automated.recommendation === 'human_review' && !e.correct).length };
  });
  return { generated_at: new Date().toISOString(), baseline: baseline.version, candidate: candidate.version,
    label_sources: { before: labelled.before.source, after: labelled.after.source },
    quality: groups.map(([name, rows]) => ({ name, before: quality(rows, 'before'), after: quality(rows, 'after') })),
    examples: labelled.examples,
    operations: { total: items.length, reviewed: reviews.length, overrides: reviews.filter(i => i.review.outcome === 'changed').length,
      resolved_escalations: reviews.filter(i => i.review.outcome === 'resolved').length,
      rechecks: items.filter(i => i.needs_recheck).length,
      missing_facts: items.filter(i => Object.values(i.case).some(v => v === null)).length,
      distribution: RECOMMENDATIONS.map(code => ({ code, count: items.filter(i => i.automated.recommendation === code).length })),
      reasons: [...new Set(reviews.map(i => i.review.reason_code))].map(code => ({ code, count: reviews.filter(i => i.review.reason_code === code).length })) },
    claims: items.map(i => ({ id: i.case.case_id, version: i.automated.policy_version, decision_token: hash([i.case, i.automated]) })),
    reviews: reviews.map(i => ({ case_id: i.case.case_id, ...i.review })),
    outcome_versions: versions, outcomes: resolved, outcome_events: outcomes.events.length,
    comparisons: validation.events.filter(e => e.type === 'run' && e.mode === 'impact').slice(-8).reverse().map(r => ({ id: r.id, at: r.created_at, baseline: r.baseline.version, candidate: r.candidate.version,
      changed: r.impact.changed, rechecks: r.impact.open_rechecks, closed: r.impact.closed })) };
}
