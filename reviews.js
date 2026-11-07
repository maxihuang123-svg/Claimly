import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { RECOMMENDATIONS } from './engine.js';

export const SCHEMA_VERSION = 1;

// Why a reviewer changed the outcome. These codes split system faults from normal
// handling: resolved_after_review means the escalation was right, so it should not
// count against the automation.
export const REASONS = [
  { code: 'resolved_after_review', label: 'Escalation was right, now resolved', only_for: 'human_review' },
  { code: 'input_data_wrong', label: 'Input data is wrong' },
  { code: 'rule_misapplied', label: 'Rule was misapplied' },
  { code: 'policy_gap', label: 'Policy gives the wrong result here' },
  { code: 'other', label: 'Other', note_required: true },
];

export class ReviewError extends Error {}

// The log is append-only. The current review of a case is found by replaying it, so
// edits and undos never erase what a reviewer previously recorded.
export class ReviewLog {
  constructor(path) {
    this.path = path;
    this.byCase = new Map();
    if (!existsSync(path)) return;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        this.#apply(JSON.parse(line));
      } catch {
        console.warn(`Skipping unreadable line ${index + 1} in ${path}`);
      }
    });
  }

  #apply(event) {
    const history = this.byCase.get(event.case_id) ?? [];
    if (event.event === 'review') history.push(event);
    if (event.event === 'retraction') {
      const position = history.findIndex((review) => review.review_id === event.retracts);
      if (position !== -1) history.splice(position, 1);
    }
    this.byCase.set(event.case_id, history);
  }

  #write(event) {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    this.#apply(event);
    return event;
  }

  current(caseId) {
    return this.byCase.get(caseId)?.at(-1) ?? null;
  }

  record(item, input) {
    const reviewer = String(input.reviewer ?? '').trim();
    const decision = input.final_recommendation;
    const note = String(input.note ?? '').trim();
    const automated = item.automated;
    const changed = decision !== automated.recommendation;

    if (!reviewer) throw new ReviewError('Enter your name before saving.');
    if (!RECOMMENDATIONS.includes(decision)) throw new ReviewError('Choose a next step.');
    if (decision === 'human_review' && automated.recommendation === 'human_review') {
      throw new ReviewError('This case is already in human review. Choose where it goes next.');
    }

    const reason = REASONS.find((option) => option.code === input.reason_code);
    if (changed) {
      if (!reason) throw new ReviewError('Choose a reason for the change.');
      if (reason.only_for && reason.only_for !== automated.recommendation) {
        throw new ReviewError('That reason does not apply to this case.');
      }
      if (reason.note_required && !note) throw new ReviewError('Add a note to explain "Other".');
    }

    return this.#write({
      schema_version: SCHEMA_VERSION,
      event: 'review',
      review_id: randomUUID(),
      created_at: new Date().toISOString(),
      reviewer,
      case_id: item.case.case_id,
      case_status: item.case.case_status,
      automated: {
        policy_version: automated.policy_version,
        recommendation: automated.recommendation,
        rule_id: automated.rule_id,
        triggers: automated.triggers,
      },
      final_recommendation: decision,
      // confirmed: the decision stands. resolved: a correct escalation was settled by a
      // person. changed: the automation got it wrong.
      outcome: !changed ? 'confirmed' : reason.code === 'resolved_after_review' ? 'resolved' : 'changed',
      reason_code: changed ? reason.code : null,
      note: note || null,
      supersedes: this.current(item.case.case_id)?.review_id ?? null,
    });
  }

  retract(caseId, reviewer) {
    const current = this.current(caseId);
    if (!current) throw new ReviewError('There is no review to undo.');
    return this.#write({
      schema_version: SCHEMA_VERSION,
      event: 'retraction',
      review_id: randomUUID(),
      created_at: new Date().toISOString(),
      reviewer: String(reviewer ?? '').trim() || current.reviewer,
      case_id: caseId,
      retracts: current.review_id,
    });
  }
}
