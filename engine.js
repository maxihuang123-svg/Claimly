// Policy v1 for motor claims triage. Every check is evaluated, even after a rule
// has matched, so a reviewer can see what the decision order hid.
// A blank or unreadable value stays null: it is never read as true or false.

export const POLICY_VERSION = 'v1';
export const QUOTE_LIMIT_EUR = 1500;
export const RECOMMENDATIONS = ['routine_processing', 'request_information', 'human_review'];

const BOOLEAN_FIELDS = [
  'policy_active_on_incident', 'incident_report_present', 'itemized_quote_present',
  'injury_reported', 'liability_disputed', 'duplicate_flag', 'evidence_conflict',
];
const TEXT_FIELDS = ['case_status', 'claim_type', 'repair_type'];

const FIELD_LABELS = {
  case_status: 'Case status',
  claim_type: 'Claim type',
  repair_type: 'Repair type',
  quote_eur: 'Quote',
  policy_active_on_incident: 'Policy active on incident date',
  incident_report_present: 'Incident report',
  itemized_quote_present: 'Itemized quote',
  injury_reported: 'Injury reported',
  liability_disputed: 'Liability disputed',
  duplicate_flag: 'Duplicate flag',
  evidence_conflict: 'Evidence conflict',
};

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
  for (const field of TEXT_FIELDS) record[field] = (row[field] ?? '').trim() || null;
  for (const field of BOOLEAN_FIELDS) record[field] = parseBoolean(row[field]);
  record.quote_eur = parseQuote(row.quote_eur);
  return record;
}

export const formatEur = (value) => `€${value.toLocaleString('en-US')}`;
const humanize = (value) => {
  const text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.slice(1);
};
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

const BLANK = 'Blank';
const yesNo = (value) => (value === null ? BLANK : value ? 'Yes' : 'No');
const presentMissing = (value) => (value === null ? BLANK : value ? 'Present' : 'Missing');

// state: pass (no effect), trigger (this check fired), unknown (blank, so it cannot be tested)
function flagCheck(record, field, phrase) {
  const value = record[field];
  return {
    field,
    label: FIELD_LABELS[field],
    value: yesNo(value),
    test: 'Must be no',
    state: value === null ? 'unknown' : value ? 'trigger' : 'pass',
    phrase,
  };
}

function ruleOneChecks(record) {
  const active = record.policy_active_on_incident;
  const type = record.claim_type;
  const quote = record.quote_eur;
  return [
    {
      field: 'policy_active_on_incident',
      label: FIELD_LABELS.policy_active_on_incident,
      value: yesNo(active),
      test: 'Must be yes',
      state: active === null ? 'unknown' : active ? 'pass' : 'trigger',
      phrase: 'policy not active on the incident date',
    },
    {
      field: 'claim_type',
      label: FIELD_LABELS.claim_type,
      value: type === null ? BLANK : humanize(type),
      test: 'Must be motor own damage',
      state: type === null ? 'unknown' : type === 'motor_own_damage' ? 'pass' : 'trigger',
      phrase: `claim type is ${type === null ? '' : humanize(type).toLowerCase()}, not motor own damage`,
    },
    {
      field: 'quote_eur',
      label: FIELD_LABELS.quote_eur,
      value: quote === null ? BLANK : formatEur(quote),
      test: `At most ${formatEur(QUOTE_LIMIT_EUR)}`,
      state: quote === null ? 'unknown' : quote > QUOTE_LIMIT_EUR ? 'trigger' : 'pass',
      phrase: `quote ${quote === null ? '' : formatEur(quote)} is over the ${formatEur(QUOTE_LIMIT_EUR)} limit`,
    },
    flagCheck(record, 'injury_reported', 'injury reported'),
    flagCheck(record, 'liability_disputed', 'liability disputed'),
    flagCheck(record, 'duplicate_flag', 'flagged as a duplicate'),
    flagCheck(record, 'evidence_conflict', 'evidence conflict flagged'),
  ];
}

function evidenceCheck(record, field, noun) {
  const value = record[field];
  return {
    field,
    label: FIELD_LABELS[field],
    value: presentMissing(value),
    test: 'Must be present',
    state: value === true ? 'pass' : 'trigger',
    phrase: value === null ? `${noun} field is blank` : `${noun} missing`,
  };
}

function ruleTwoChecks(record) {
  const others = [...TEXT_FIELDS, 'quote_eur', 'policy_active_on_incident', 'injury_reported',
    'liability_disputed', 'duplicate_flag', 'evidence_conflict'].filter((field) => record[field] === null);
  const names = others.map((field) => FIELD_LABELS[field]);
  return [
    evidenceCheck(record, 'incident_report_present', 'incident report'),
    evidenceCheck(record, 'itemized_quote_present', 'itemized quote'),
    {
      field: 'other_fields',
      label: 'Other fields',
      value: others.length ? `${names.join(', ')} blank` : 'All readable',
      test: 'None blank',
      state: others.length ? 'trigger' : 'pass',
      phrase: `${names.join(', ').toLowerCase()} blank or unreadable`,
    },
  ];
}

const joinPhrases = (checks) => checks.map((check) => check.phrase).join('; ');

export function evaluate(record) {
  const ruleOne = ruleOneChecks(record);
  const ruleTwo = ruleTwoChecks(record);
  const ruleOneFired = ruleOne.filter((check) => check.state === 'trigger');
  const ruleTwoFired = ruleTwo.filter((check) => check.state === 'trigger');

  let recommendation;
  let decidingRule;
  let explanation;
  if (ruleOneFired.length) {
    recommendation = 'human_review';
    decidingRule = 1;
    explanation = `${capitalize(joinPhrases(ruleOneFired))}.`;
    if (ruleTwoFired.length) {
      explanation += ` Also: ${joinPhrases(ruleTwoFired)}, but Rule 1 takes priority.`;
    }
  } else if (ruleTwoFired.length) {
    recommendation = 'request_information';
    decidingRule = 2;
    explanation = `${capitalize(joinPhrases(ruleTwoFired))}.`;
  } else {
    recommendation = 'routine_processing';
    decidingRule = 3;
    explanation = 'No review trigger, and all evidence is present.';
  }

  const resultFor = (number) => {
    if (number === decidingRule) return 'matched';
    return number < decidingRule ? 'clear' : 'not_reached';
  };

  return {
    policy_version: POLICY_VERSION,
    recommendation,
    rule_id: `${POLICY_VERSION}.rule${decidingRule}`,
    triggers: (decidingRule === 1 ? ruleOneFired : decidingRule === 2 ? ruleTwoFired : [])
      .map((check) => check.field),
    explanation,
    rules: [
      {
        number: 1,
        title: 'Send to human review if any check fails',
        outcome: 'human_review',
        result: resultFor(1),
        checks: ruleOne,
      },
      {
        number: 2,
        title: 'Otherwise, request information if anything is missing',
        outcome: 'request_information',
        result: resultFor(2),
        would_also_match: decidingRule === 1 && ruleTwoFired.length > 0,
        checks: ruleTwo,
      },
      {
        number: 3,
        title: 'Otherwise, send to routine processing',
        outcome: 'routine_processing',
        result: resultFor(3),
        checks: [],
      },
    ],
  };
}
