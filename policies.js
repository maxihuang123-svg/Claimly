import { conditionText, FIELDS, OPERATORS } from './engine.js';
import { asLog } from './storage.js';

export const SCHEMA_VERSION = 1;

const condition = (field, op, value) => ({ field, op, value });

export const POLICY_V1 = {
  version: 'v1',
  activated_at: null,
  change_note: 'Original policy.',
  rules: [
    {
      title: 'Send to human review if any check fails',
      outcome: 'human_review',
      when_any: [
        condition('policy_active_on_incident', '=', false),
        condition('claim_type', '!=', 'motor_own_damage'),
        condition('quote_eur', '>', 1500),
        condition('injury_reported', '=', true),
        condition('liability_disputed', '=', true),
        condition('duplicate_flag', '=', true),
        condition('evidence_conflict', '=', true),
      ],
    },
    {
      title: 'Otherwise, request information if anything is missing',
      outcome: 'request_information',
      when_any: [
        condition('incident_report_present', '=', false),
        condition('itemized_quote_present', '=', false),
      ],
    },
    { title: 'Otherwise, send to routine processing', outcome: 'routine_processing', when_any: [] },
  ],
};

// What the policy page offers. A check is switched on or off, and the quote limit is
// the only typed value. To offer a new check, add it here.
export const POLICY_CHOICES = {
  human_review: [
    ...POLICY_V1.rules[0].when_any,
    condition('repair_type', '=', 'ev_high_voltage_battery'),
  ],
  request_information: POLICY_V1.rules[1].when_any,
};

export class PolicyError extends Error {}

function conditionErrors(item, place) {
  const meta = FIELDS[item.field];
  if (!meta) return [`${place}: choose a field.`];
  const errors = [];
  if (!OPERATORS[meta.type].includes(item.op)) errors.push(`${place}: ${meta.label} cannot use "${item.op}".`);
  const valid = {
    boolean: typeof item.value === 'boolean',
    number: Number.isFinite(item.value) && item.value >= 0,
    text: typeof item.value === 'string' && item.value.trim() !== '',
  }[meta.type];
  if (!valid) errors.push(`${place}: ${meta.label} needs a ${meta.type === 'number' ? 'number' : 'value'}.`);
  return errors;
}

// The rule order is what makes blank handling safe. Human review rules come first, so
// a blank can never hide a known reason for review. Routine processing comes last, so
// no case reaches it without passing every other rule.
export function validatePolicy(policy) {
  const errors = [];
  if (!String(policy.change_note ?? '').trim()) errors.push('Add a change note.');

  const outcomes = policy.rules.map((rule) => rule.outcome);
  const last = policy.rules.at(-1);
  const firstInfo = outcomes.indexOf('request_information');
  if (!outcomes.includes('human_review')) errors.push('Add at least one human review rule.');
  if (firstInfo === -1) errors.push('Add at least one request information rule.');
  if (firstInfo !== -1 && outcomes.lastIndexOf('human_review') > firstInfo) {
    errors.push('Human review rules must come before request information rules.');
  }
  if (last?.outcome !== 'routine_processing' || last.when_any.length) {
    errors.push('The last rule must be routine processing, with no conditions.');
  }
  if (outcomes.indexOf('routine_processing') !== outcomes.length - 1) {
    errors.push('Only the last rule can be routine processing.');
  }

  policy.rules.forEach((rule, index) => {
    const place = `Rule ${index + 1}`;
    if (!rule.title.trim()) errors.push(`${place}: add a title.`);
    if (rule !== last && !rule.when_any.length) errors.push(`${place}: choose at least one check.`);
    rule.when_any.forEach((item) => errors.push(...conditionErrors(item, place)));
    // Testing a yes/no field both ways would catch every claim where it is known.
    const both = rule.when_any.find((item) => FIELDS[item.field]?.type === 'boolean'
      && rule.when_any.some((other) => other.field === item.field && other.value === !item.value));
    if (both) errors.push(`${place}: ${FIELDS[both.field].label} is checked both ways, so it would match every claim.`);
  });
  return errors;
}

// Adds a readable sentence to each condition, for pages that show a policy.
const describeConditions = (items) => items.map((item) => ({ ...item, text: conditionText(item) }));
export const describePolicy = (policy) => ({
  ...policy,
  rules: policy.rules.map((rule) => ({ ...rule, when_any: describeConditions(rule.when_any) })),
});
export const describeChoices = () => Object.fromEntries(
  Object.entries(POLICY_CHOICES).map(([outcome, items]) => [outcome, describeConditions(items)]),
);

// A draft has one rule per outcome. Rules that share an outcome fold into the first.
function mergeRules(rules) {
  const merged = new Map();
  for (const rule of rules) {
    const existing = merged.get(rule.outcome);
    if (existing) existing.when_any.push(...rule.when_any);
    else merged.set(rule.outcome, { ...rule, when_any: [...rule.when_any] });
  }
  return [...merged.values()];
}

const cleanDraft = (input) => {
  if (!Array.isArray(input?.rules)) throw new PolicyError('A draft needs a list of rules.');
  return {
    change_note: String(input.change_note ?? ''),
    rules: mergeRules(input.rules.map((rule) => ({
      title: String(rule?.title ?? ''),
      outcome: rule?.outcome,
      when_any: (Array.isArray(rule?.when_any) ? rule.when_any : [])
        .map((item) => condition(item?.field, item?.op, item?.value)),
    }))),
  };
};

// The log is append-only, and an activated version is never rewritten: the only way to
// change a policy is a new version. There is one draft at a time, and it has no version
// number until it is activated.
export class PolicyStore {
  constructor(target) {
    this.log = asLog(target);
    this.path = this.log.path;
    this.versions = [POLICY_V1];
    this.draft = null;
    this.log.read().split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        this.#apply(JSON.parse(line));
      } catch {
        console.warn(`Skipping unreadable line ${index + 1} in ${this.path}`);
      }
    });
  }

  #apply(event) {
    if (event.event === 'draft_saved') this.draft = cleanDraft(event.draft);
    if (event.event === 'draft_discarded') this.draft = null;
    if (event.event === 'activated') {
      this.versions.push(event.policy);
      this.draft = null;
    }
  }

  #write(event) {
    this.log.append(`${JSON.stringify({
      schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), ...event,
    })}\n`);
    this.#apply(event);
  }

  get current() {
    return this.versions.at(-1);
  }

  // The first version, which the base case file is evaluated under.
  get original() {
    return this.versions[0];
  }

  find(version) {
    return this.versions.find((policy) => policy.version === version) ?? null;
  }

  saveDraft(input) {
    this.#write({ event: 'draft_saved', draft: cleanDraft(input) });
    return this.draft;
  }

  // A new draft starts as a copy of the current rules.
  startDraft() {
    if (this.draft) throw new PolicyError('There is already a draft. Finish or discard it first.');
    return this.saveDraft({ rules: this.current.rules, change_note: '' });
  }

  discardDraft() {
    if (!this.draft) throw new PolicyError('There is no draft to discard.');
    this.#write({ event: 'draft_discarded' });
  }

  activateDraft(release = {}) {
    if (!this.draft) throw new PolicyError('There is no draft to activate.');
    const [error] = validatePolicy(this.draft);
    if (error) throw new PolicyError(error);
    const policy = {
      version: `v${this.versions.length + 1}`,
      activated_at: new Date().toISOString(),
      ...release,
      change_note: this.draft.change_note.trim(),
      rules: this.draft.rules,
    };
    this.#write({ event: 'activated', policy });
    return policy;
  }
}
