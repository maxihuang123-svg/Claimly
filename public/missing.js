// What the callback agent may ask a claimant for, derived from the request information checks that fired, so the agent
// never asks for anything the policy did not find missing. Shared by the server (calls/api.js), which
// decides what the agent is told, and the browser (calls.js), which shows it before the call.

const ASK = {
  incident_report_present: 'the incident report',
  itemized_quote_present: 'an itemized repair quote',
};

// Blank fields behind the "Other fields" check. case_status is internal and not the claimant's to supply.
const ASK_BLANK = {
  claim_type: 'a short description of what happened',
  repair_type: 'what is being repaired, and whether the car is electric',
  quote_eur: 'the repair quote amount',
  policy_active_on_incident: 'the date of the incident',
  injury_reported: 'confirmation of whether anyone was injured',
  liability_disputed: 'confirmation of whether anyone disputes who caused it',
  duplicate_flag: 'confirmation of whether this incident was reported before',
  evidence_conflict: 'clarification of the photos and dates',
};

export function missingItems(item) {
  // Policies are versioned, so the rule is found by its outcome, not its number.
  const rule = item.automated.rules.find((entry) => entry.outcome === 'request_information');
  if (!rule) return [];
  const asks = rule.checks.filter((check) => check.state === 'trigger').flatMap((check) => (
    check.field === 'other_fields'
      ? Object.keys(ASK_BLANK).filter((field) => item.case[field] === null).map((field) => ASK_BLANK[field])
      : [ASK[check.field] ?? ASK_BLANK[check.field]]
  ));
  return [...new Set(asks.filter(Boolean))];
}

// Calls are only for open claims the policy sent to request information.
export const canCall = (item) => item.case.case_status === 'open'
  && item.automated.recommendation === 'request_information'
  && missingItems(item).length > 0;

export const joinList = (items) => (
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
);
