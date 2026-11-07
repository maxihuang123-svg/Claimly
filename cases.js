import { parseCsv } from './csv.js';
import { evaluate, normalizeCase } from './engine.js';

export const REQUIRED_COLUMNS = [
  'case_id', 'case_status', 'claim_summary', 'policy_active_on_incident', 'claim_type', 'repair_type',
  'quote_eur', 'incident_report_present', 'itemized_quote_present', 'injury_reported',
  'liability_disputed', 'duplicate_flag', 'evidence_conflict',
];

export class CaseFileError extends Error {}

// Validates a whole file before anything is used, so a bad import changes nothing.
export function parseCaseFile(text) {
  let rows;
  try {
    rows = parseCsv(text);
  } catch (error) {
    throw new CaseFileError(error.message);
  }
  if (!rows.length) throw new CaseFileError('The file has no cases in it.');

  const missing = REQUIRED_COLUMNS.filter((column) => !(column in rows[0]));
  if (missing.length) throw new CaseFileError(`The file is missing these columns: ${missing.join(', ')}.`);

  const seen = new Set();
  return rows.map((row, index) => {
    const id = row.case_id.trim();
    if (!id) throw new CaseFileError(`Row ${index + 1} has no case_id.`);
    if (seen.has(id)) throw new CaseFileError(`Case ${id} appears more than once.`);
    seen.add(id);
    const record = normalizeCase(row);
    return { case: record, automated: evaluate(record) };
  });
}

// A review only stands while the automated decision it reviewed is still the current one.
export function reviewStillApplies(review, automated) {
  return review.automated.recommendation === automated.recommendation
    && review.automated.rule_id === automated.rule_id
    && review.automated.triggers.join() === automated.triggers.join();
}
