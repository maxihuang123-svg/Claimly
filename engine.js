// Motor claims triage. A policy is data: an ordered list of rules, each with an outcome
// and conditions on case fields. Every check is evaluated, even after a rule has matched,
// so a reviewer can see what the decision order hid.
// A blank or unreadable value stays null: it is never read as true or false.

export const RECOMMENDATIONS = ['routine_processing', 'request_information', 'human_review'];

// The fields a policy may test. Each one is a required CSV column, so a valid policy
// works on any file that passes import. `options` are suggestions, not a closed list.
export const FIELDS = {
  case_status: { label: 'Case status', type: 'text', options: ['open', 'closed'] },
  claim_type: { label: 'Claim type', type: 'text', options: ['motor_own_damage'] },
  repair_type: { label: 'Repair type', type: 'text', options: ['standard', 'ev_high_voltage_battery'] },
  quote_eur: { label: 'Quote', noun: 'repair quote', type: 'number' },
  policy_active_on_incident: {
    label: 'Policy active on incident date',
    type: 'boolean',
    phrases: { true: 'policy active on the incident date', false: 'policy not active on the incident date' },
    reasons: { true: 'the policy was active on the incident date', false: 'the policy was not active on the incident date' },
  },
  incident_report_present: {
    label: 'Incident report',
    type: 'boolean',
    presence: true,
    phrases: { true: 'incident report present', false: 'incident report missing' },
    reasons: { true: 'the incident report is present', false: 'the incident report is missing' },
  },
  itemized_quote_present: {
    label: 'Itemized quote',
    type: 'boolean',
    presence: true,
    phrases: { true: 'itemized quote present', false: 'itemized quote missing' },
    reasons: { true: 'the itemized quote is present', false: 'the itemized quote is missing' },
  },
  injury_reported: {
    label: 'Injury reported',
    type: 'boolean',
    phrases: { true: 'injury reported', false: 'no injury reported' },
    reasons: { true: 'an injury was reported', false: 'no injury was reported' },
  },
  liability_disputed: {
    label: 'Liability disputed',
    type: 'boolean',
    phrases: { true: 'liability disputed', false: 'liability not disputed' },
    reasons: { true: 'liability is disputed', false: 'liability is not disputed' },
  },
  duplicate_flag: {
    label: 'Duplicate flag',
    type: 'boolean',
    phrases: { true: 'flagged as a duplicate', false: 'not flagged as a duplicate' },
    reasons: { true: 'the claim is flagged as a duplicate', false: 'the claim is not flagged as a duplicate' },
  },
  evidence_conflict: {
    label: 'Evidence conflict',
    type: 'boolean',
    phrases: { true: 'evidence conflict flagged', false: 'no evidence conflict flagged' },
    reasons: { true: 'an evidence conflict is flagged', false: 'no evidence conflict is flagged' },
  },
};

export const OPERATORS = { boolean: ['='], text: ['=', '!='], number: ['>', '>=', '<', '<='] };

const COMPARE = {
  '=': (actual, value) => actual === value,
  '!=': (actual, value) => actual !== value,
  '>': (actual, value) => actual > value,
  '>=': (actual, value) => actual >= value,
  '<': (actual, value) => actual < value,
  '<=': (actual, value) => actual <= value,
};

const fieldsOfType = (type) => Object.keys(FIELDS).filter((field) => FIELDS[field].type === type);

const parseBoolean = (raw) => {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
};

const parseQuote = (raw) => {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export function normalizeCase(row) {
  const record = { case_id: row.case_id.trim(), claim_summary: (row.claim_summary ?? '').trim() };
  for (const field of fieldsOfType('text')) record[field] = (row[field] ?? '').trim() || null;
  for (const field of fieldsOfType('boolean')) record[field] = parseBoolean(row[field]);
  record.quote_eur = parseQuote(row.quote_eur);
  return record;
}

export const formatEur = (value) => `€${value.toLocaleString('en-US')}`;
const humanize = (value) => {
  const text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.slice(1);
};
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
const lowerHumanize = (value) => humanize(value).toLowerCase().replace(/\bev\b/, 'EV');

const NOT_PROVIDED = 'Not provided';

function displayValue(meta, value) {
  if (value === null) return NOT_PROVIDED;
  if (meta.type === 'number') return formatEur(value);
  if (meta.type === 'text') return humanize(value);
  if (meta.presence) return value ? 'Present' : 'Missing';
  return value ? 'Yes' : 'No';
}

// What a passing claim looks like, for the Policy column of the trace.
function passText({ field, op, value }) {
  const meta = FIELDS[field];
  if (meta.type === 'boolean') {
    if (meta.presence) return value ? 'Must be missing' : 'Must be present';
    return value ? 'Must be no' : 'Must be yes';
  }
  if (meta.type === 'text') return `Must ${op === '=' ? 'not ' : ''}be ${lowerHumanize(value)}`;
  const limit = formatEur(value);
  return { '>': `At most ${limit}`, '>=': `Under ${limit}`, '<': `At least ${limit}`, '<=': `Over ${limit}` }[op];
}

// Why this claim tripped the condition, for the explanation.
function triggerPhrase({ field, op, value }, actual) {
  const meta = FIELDS[field];
  const name = meta.label.toLowerCase();
  if (meta.type === 'boolean') return meta.reasons[value];
  if (meta.type === 'text') {
    return op === '=' ? `${name} is ${lowerHumanize(value)}`
      : `${name} is ${lowerHumanize(actual)}, not ${lowerHumanize(value)}`;
  }
  const relation = {
    '>': 'exceeds the', '>=': 'is at or over the', '<': 'is under the', '<=': 'is at or under the',
  }[op];
  return `the ${formatEur(actual)} ${meta.noun} ${relation} ${formatEur(value)} ${op[0] === '>' ? 'limit' : 'minimum'}`;
}

// The condition as a sentence, for reading a policy on its own.
export function conditionText({ field, op, value }) {
  const meta = FIELDS[field];
  if (meta.type === 'boolean') return capitalize(meta.phrases[value]);
  if (meta.type === 'text') return `${meta.label} is ${op === '=' ? '' : 'not '}${lowerHumanize(value)}`;
  const limit = formatEur(value);
  return `${meta.label} is ${{
    '>': `over ${limit}`, '>=': `${limit} or more`, '<': `under ${limit}`, '<=': `${limit} or less`,
  }[op]}`;
}

// state: pass (no effect), trigger (this check fired), unknown (blank, so it cannot be tested)
function buildCheck(record, condition, blankTriggers) {
  const { field, op, value } = condition;
  const meta = FIELDS[field];
  const actual = record[field];
  const blank = actual === null;
  let state = 'pass';
  if (blank) state = blankTriggers ? 'trigger' : 'unknown';
  else if (COMPARE[op](actual, value)) state = 'trigger';
  return {
    field,
    label: meta.label,
    value: displayValue(meta, actual),
    test: passText(condition),
    state,
    blanks: blank ? [meta.label] : [],
    phrase: blank ? null : triggerPhrase(condition, actual),
  };
}

// Blank handling is fixed in every policy version: no value is ever invented, and a
// blank leads to request information unless a known fact already sent the case to review.
function otherFieldsCheck(record, rule) {
  const own = rule.when_any.map((condition) => condition.field);
  const others = Object.keys(FIELDS).filter((field) => !own.includes(field) && record[field] === null);
  const names = others.map((field) => FIELDS[field].label);
  return {
    field: 'other_fields',
    label: 'Other fields',
    value: others.length ? `${names.join(', ')}: ${NOT_PROVIDED.toLowerCase()}` : 'All provided',
    test: 'All provided',
    state: others.length ? 'trigger' : 'pass',
    blanks: names,
    phrase: null,
  };
}

// Known facts read as sentences. Absent ones are gathered under one "Not provided".
function sentences(checks) {
  const known = checks.filter((check) => check.phrase).map((check) => `${capitalize(check.phrase)}.`);
  const absent = checks.flatMap((check) => check.blanks).join(', ').toLowerCase();
  return [...known, ...(absent ? [`${NOT_PROVIDED}: ${absent}.`] : [])].join(' ');
}

// The facts that produced the decision, one per field.
const evidenceFrom = (checks) => checks.flatMap((check) => (check.blanks.length
  ? check.blanks.map((label) => ({ label, value: NOT_PROVIDED, blank: true }))
  : [{ label: check.label, value: check.value, blank: false }]));

export function evaluate(record, policy) {
  const blankRule = policy.rules.findIndex((rule) => rule.outcome === 'request_information');
  const rules = policy.rules.map((rule, index) => {
    const blankTriggers = rule.outcome === 'request_information';
    const checks = (rule.when_any ?? []).map((condition) => buildCheck(record, condition, blankTriggers));
    if (index === blankRule) checks.push(otherFieldsCheck(record, rule));
    return { rule, checks, fired: checks.filter((check) => check.state === 'trigger') };
  });

  // The last rule has no conditions: it is what happens when nothing else matched.
  const deciding = rules.findIndex(({ fired }, index) => fired.length || index === rules.length - 1);
  const decidingRule = deciding + 1;
  const { rule, fired } = rules[deciding];
  const alsoFired = rules.slice(deciding + 1).flatMap((later) => later.fired);

  const reason = fired.length ? sentences(fired) : 'No review trigger, and all evidence is present.';
  const why = rule.outcome === 'human_review' ? ': a known human review trigger comes first' : '';
  const priorityNote = alsoFired.length
    ? `${sentences(alsoFired)} Rule ${decidingRule} takes priority${why}.`
    : null;

  const resultFor = (index) => {
    if (index === deciding) return 'matched';
    return index < deciding ? 'clear' : 'not_reached';
  };

  return {
    policy_version: policy.version,
    recommendation: rule.outcome,
    rule_id: `${policy.version}.rule${decidingRule}`,
    triggers: fired.map((check) => check.field),
    reason,
    evidence: evidenceFrom(fired),
    priority_note: priorityNote,
    explanation: [reason, priorityNote].filter(Boolean).join(' '),
    rules: rules.map((entry, index) => ({
      number: index + 1,
      title: entry.rule.title,
      outcome: entry.rule.outcome,
      result: resultFor(index),
      would_also_match: index > deciding && entry.fired.length > 0,
      checks: entry.checks,
    })),
  };
}
