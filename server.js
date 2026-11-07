import { OutcomeStore, measurementPayload } from './measurement.js';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessGate } from './calls/access.js';
import { callRoutes, readEnv } from './calls/node.js';
import { CaseFileError, parseCaseFile, reviewStillApplies } from './cases.js';
import { evaluate, RECOMMENDATIONS } from './engine.js';
import { describeChoices, describePolicy, PolicyError, PolicyStore, validatePolicy } from './policies.js';
import { ValidationStore, hash } from './validation.js';
import { REASONS, ReviewError, ReviewLog } from './reviews.js';

const root = dirname(fileURLToPath(import.meta.url));
const casesPath = resolve(process.argv[2] ?? join(root, 'data/cases.csv'));
const importsDir = resolve(process.env.IMPORTS_DIR ?? join(root, 'data/imports'));
const reviewsPath = resolve(process.env.REVIEWS_PATH ?? join(root, 'data/reviews.jsonl'));
const policiesPath = resolve(process.env.POLICIES_PATH ?? join(root, 'data/policies.jsonl'));
const port = Number(process.env.PORT ?? 3000);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/measurement.js': ['measurement.js', 'text/javascript; charset=utf-8'],
  '/validation.js': ['validation.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/calls.js': ['calls.js', 'text/javascript; charset=utf-8'],
  '/calls.css': ['calls.css', 'text/css; charset=utf-8'],
  '/ringtone.js': ['ringtone.js', 'text/javascript; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/missing.js': ['missing.js', 'text/javascript; charset=utf-8'],
};

const items = new Map();
const log = new ReviewLog(reviewsPath);
const policies = new PolicyStore(policiesPath);
const validation = new ValidationStore(resolve(process.env.VALIDATION_PATH ?? join(root, 'data/validation.jsonl')),
  hash(['engine.js', 'cases.js', 'validation.js'].map((file) => readFileSync(join(root, file), 'utf8'))));
const outcomes = new OutcomeStore(resolve(process.env.OUTCOMES_PATH ?? join(root, 'data/outcomes.jsonl')));
const validationItems = () => [...items.values()].map(withReview);
function selectedPolicy(version) {
  const policy = version === 'draft' ? policies.draft && { ...policies.draft, version: 'draft' } : policies.find(version);
  if (!policy) throw new PolicyError('That policy is no longer available. Reload the page.');
  // An unfinished draft cannot be evaluated, for example while its quote limit is blank.
  if (version === 'draft' && validatePolicy({ ...policy, change_note: 'x' }).length) {
    throw new PolicyError('This draft has unfinished rules. Finish them in Policies, then test it.');
  }
  return policy;
}


const sameCase = (a, b) => JSON.stringify(a.case) === JSON.stringify(b.case);

// Imports are named <timestamp>.<policy version>.csv. Older names have no version, and
// those files were imported under the original policy.
function policyForImport(name) {
  const version = name.match(/\.(v\d+)\.csv$/)?.[1];
  if (!version) return policies.original;
  const policy = policies.find(version);
  if (!policy) throw new Error(`${name} was imported under ${version}, which is not in ${policiesPath}.`);
  return policy;
}
const calls = callRoutes({ root, findItem: (caseId) => (items.has(caseId) ? withReview(items.get(caseId)) : null) });
const gate = accessGate(readEnv(join(root, '.env.local')).ACCESS_CODE);

// The base file loads first, then each import in the order it was made. Uploaded
// files are kept as they arrived, so the case list can always be rebuilt from them.
// A case keeps the policy it was evaluated under until an import changes its data.
function loadCases() {
  const files = existsSync(casesPath) ? [[casesPath, policies.original]] : [];
  if (existsSync(importsDir)) {
    const names = readdirSync(importsDir).filter((name) => name.endsWith('.csv')).sort();
    files.push(...names.map((name) => [join(importsDir, name), policyForImport(name)]));
  }
  for (const [file, policy] of files) {
    for (const item of parseCaseFile(readFileSync(file, 'utf8'), policy, policies.original)) {
      const existing = items.get(item.case.case_id);
      if (!existing || !sameCase(existing, item)) items.set(item.case.case_id, item);
    }
  }
}

function withReview(item) {
  const review = log.current(item.case.case_id);
  const importedVersion = policies.versions.findIndex((p) => p.version === item.automated.policy_version);
  const recheckPolicy = item.case.case_status === 'open' && policies.versions.findLast((p, index) => index >= importedVersion && p.recheck_case_ids?.includes(item.case.case_id));
  const automated = recheckPolicy ? evaluate(item.case, recheckPolicy) : item.automated;
  const applicable = review && reviewStillApplies(review, automated) ? review : null;
  return {
    ...item, automated,
    original_automated: item.automated,
    review: applicable,
    retained_review: review && !applicable ? review : null,
    history: log.history(item.case.case_id),
    needs_recheck: !!recheckPolicy && !applicable,
  };
}

const casesPayload = () => ({
  policy: { version: policies.current.version },
  recommendations: RECOMMENDATIONS,
  reasons: REASONS,
  cases: [...items.values()].map(withReview),
});

function draftPayload() {
  const { draft } = policies;
  if (!draft) return null;
  const errors = validatePolicy(draft);
  // The impact only needs valid rules, so it shows before the change note is written.
  const rulesValid = !validatePolicy({ ...draft, change_note: 'x' }).length;
  return { ...(rulesValid ? describePolicy(draft) : draft), errors };
}

const policiesPayload = () => ({
  current_version: policies.current.version,
  policies: policies.versions.map(describePolicy).reverse(),
  draft: draftPayload(),
  choices: describeChoices(),
});

function importCases(text) {
  const policy = policies.current;
  const incoming = parseCaseFile(text, policy, policies.original);
  const summary = { added: 0, updated: 0, unchanged: 0, needs_review_again: 0 };
  const changes = [];

  for (const item of incoming) {
    const existing = items.get(item.case.case_id);
    if (!existing) {
      summary.added += 1;
      changes.push(item);
    } else if (sameCase(existing, item)) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
      if (withReview(existing).review && !withReview(item).review) summary.needs_review_again += 1;
      changes.push(item);
    }
  }

  if (changes.length) {
    mkdirSync(importsDir, { recursive: true });
    writeFileSync(join(importsDir, `${Date.now()}.${policy.version}.csv`), text);
    for (const item of changes) items.set(item.case.case_id, item);
  }
  return summary;
}

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ReviewError('That file is too large. The limit is 5 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request) {
  try {
    return JSON.parse(await readBody(request, MAX_JSON_BYTES));
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('Request is not valid JSON.');
  }
}

function findItem(caseId) {
  const item = items.get(caseId);
  if (!item) throw new ReviewError(`Unknown case ${caseId}.`);
  return item;
}

async function route(request, response) {
  if (await gate(request, response)) return;
  const { pathname } = new URL(request.url, 'http://localhost');
  const key = `${request.method} ${pathname}`;

  if (request.method === 'GET' && STATIC_FILES[pathname]) {
    const [file, type] = STATIC_FILES[pathname];
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    response.end(readFileSync(join(root, 'public', file)));
    return;
  }
  if (key === 'GET /api/measurement') {
    const url = new URL(request.url, 'http://localhost');
    const baseline = selectedPolicy(url.searchParams.get('baseline') ?? policies.original.version);
    const candidate = selectedPolicy(url.searchParams.get('candidate') ?? policies.current.version);
    sendJson(response, 200, { ...measurementPayload(validationItems(), baseline, candidate, validation, outcomes),
      active_version: policies.current.version, policies: [...policies.versions.map(p => p.version), ...(policies.draft ? ['draft'] : [])] });
    return;
  }
  if (key === 'POST /api/outcomes') {
    const body = await readJson(request);
    const item = withReview(findItem(body.case_id));
    if (body.decision_token !== hash([item.case, item.automated])) throw new ReviewError('The assessed decision changed. Refresh data and check the claim before saving.');
    outcomes.record(item, body);
    sendJson(response, 201, { saved: true });
    return;
  }
  if (key === 'GET /api/cases') {
    sendJson(response, 200, casesPayload());
    return;
  }
  if (key === 'POST /api/import') {
    const summary = importCases(await readBody(request, MAX_CSV_BYTES));
    sendJson(response, 200, { summary, ...casesPayload() });
    return;
  }
  if (key === 'POST /api/reviews') {
    const body = await readJson(request);
    const item = findItem(body.case_id);
    log.record(withReview(item), body);
    sendJson(response, 201, withReview(item));
    return;
  }
  if (key === 'POST /api/reviews/undo') {
    const body = await readJson(request);
    const item = findItem(body.case_id);
    log.retract(item.case.case_id, body.reviewer);
    sendJson(response, 200, withReview(item));
    return;
  }
  if (key === 'GET /api/policies') {
    sendJson(response, 200, policiesPayload());
    return;
  }
  if (key === 'POST /api/policies/draft/start') {
    policies.startDraft();
    sendJson(response, 201, policiesPayload());
    return;
  }
  if (key === 'POST /api/policies/draft') {
    policies.saveDraft(await readJson(request));
    sendJson(response, 200, policiesPayload());
    return;
  }
  if (key === 'POST /api/policies/draft/discard') {
    policies.discardDraft();
    sendJson(response, 200, policiesPayload());
    return;
  }
  if (key === 'POST /api/policies/draft/activate') {
    const body = await readJson(request);
    const run = validation.assertRelease(body.run_id, policies.current, selectedPolicy('draft'), validationItems(), body.approver);
    policies.activateDraft({ validation_run_id: run.id, approved_by: body.approver.trim(),
      recheck_case_ids: run.claims.filter((c) => c.needs_recheck).map((c) => c.case.case_id) });
    sendJson(response, 200, policiesPayload());
    return;
  }
  if (key === 'GET /api/validation') {
    const url = new URL(request.url, 'http://localhost');
    const baseline = selectedPolicy(url.searchParams.get('baseline') ?? policies.current.version);
    const candidate = selectedPolicy(url.searchParams.get('candidate') ?? (policies.draft ? 'draft' : policies.current.version));
    const preview = validation.preview(baseline, candidate, validationItems());
    const runs = validation.events.filter((e) => e.type === 'run' && e.mode === 'impact' && e.baseline.version === baseline.version && e.candidate.version === candidate.version);
    const run = runs.at(-1) ?? null;
    sendJson(response, 200, { ...policiesPayload(), preview, run,
      stale: !!run && run.fingerprint !== validation.fingerprint(baseline, candidate, validationItems()) });
    return;
  }
  if (key === 'POST /api/validation/run') {
    const body = await readJson(request);
    const run = validation.run(selectedPolicy(body.baseline), selectedPolicy(body.candidate), validationItems(), body.reviewer);
    sendJson(response, 201, run);
    return;
  }
  if (key === 'POST /api/validation/labels') {
    const body = await readJson(request);
    const candidate = selectedPolicy(body.candidate);
    if (body.token !== validation.labelSetup(candidate).token) {
      throw new PolicyError('The policy or labels changed. Reload the validation tab before saving labels.');
    }
    validation.saveLabels(candidate, body.expected);
    sendJson(response, 201, validation.labelSetup(candidate));
    return;
  }
  if (await calls(request, response)) return;
  sendJson(response, 404, { error: 'Not found.' });
}

loadCases();

createServer((request, response) => {
  route(request, response).catch((error) => {
    if (error instanceof ReviewError || error instanceof CaseFileError || error instanceof PolicyError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: 'The server could not complete that request.' });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Claims review: http://localhost:${port}`);
  console.log(`${items.size} cases loaded`);
  console.log(`Reviews append to ${reviewsPath}`);
  console.log(`Current policy: ${policies.current.version}`);
});
