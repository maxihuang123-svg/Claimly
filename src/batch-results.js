// Shared batch conversion for the website and CLI.
import { parseCaseFile } from './cases.js';
import { evaluate } from './engine.js';
import { POLICY_V1, POLICY_V2 } from './policies.js';

export const RESULT_COLUMNS = [
  'case_id', 'recommendation_v1', 'recommendation_v2', 'needs_recheck', 'rule_v1', 'rule_v2', 'explanation',
];

export function batchResults(text, v1 = POLICY_V1, v2 = POLICY_V2) {
  return parseCaseFile(text, v1).map(({ case: record, automated: first }) => {
    const closed = record.case_status === 'closed';
    const second = closed ? first : evaluate(record, v2);
    const changed = !closed && first.recommendation !== second.recommendation;
    let explanation = second.explanation;
    if (closed) {
      explanation = `Closed claim: the ${v1.version} decision is retained, not re-evaluated under ${v2.version}. ${first.explanation}`;
    } else if (changed) {
      explanation = `Changed under ${v2.version}: ${second.explanation} Under ${v1.version} it was ${first.recommendation}: ${first.explanation}`;
    }
    return {
      case_id: record.case_id,
      recommendation_v1: first.recommendation,
      recommendation_v2: second.recommendation,
      needs_recheck: changed,
      rule_v1: first.rule_id,
      rule_v2: second.rule_id,
      explanation,
    };
  });
}

const csvValue = (value) => {
  const text = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const resultsCsv = (rows) => `${[RESULT_COLUMNS, ...rows.map((row) => RESULT_COLUMNS.map((column) => row[column]))]
  .map((cells) => cells.map(csvValue).join(',')).join('\n')}\n`;
