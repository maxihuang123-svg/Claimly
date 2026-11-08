// Batch path, for scoring: evaluates every claim in a CSV under policy v1 and v2 and writes the results CSV.
//
//   npm run batch -- <claims.csv> [results.csv]        (or: node batch.js <claims.csv> [results.csv])
//
// Input is the case format (cases.js). Output columns: case_id, recommendation_v1, recommendation_v2,
// needs_recheck, rule_v1, rule_v2, explanation. A closed claim keeps its v1 decision: recommendation_v2 and
// rule_v2 repeat v1 and needs_recheck is False. An open claim needs a recheck when v2 recommends a different
// next step. The engine is the one the app uses, so the screen and this file always agree. Node 22, no install.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseFileError, parseCaseFile } from './cases.js';
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output = 'results.csv'] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: npm run batch -- <claims.csv> [results.csv]');
    process.exit(1);
  }
  try {
    const rows = batchResults(readFileSync(input, 'utf8'));
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, resultsCsv(rows));
    const recheck = rows.filter((row) => row.needs_recheck).length;
    console.log(`${rows.length} claims -> ${output} (v1 and v2, ${recheck} open ${recheck === 1 ? 'claim needs' : 'claims need'} a recheck)`);
  } catch (error) {
    if (!(error instanceof CaseFileError) && error.code !== 'ENOENT') throw error;
    console.error(error.code === 'ENOENT' ? `Cannot read ${input}.` : `${input}: ${error.message}`);
    process.exit(1);
  }
}
