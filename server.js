import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseFileError, parseCaseFile, reviewStillApplies } from './cases.js';
import { POLICY_VERSION, QUOTE_LIMIT_EUR, RECOMMENDATIONS } from './engine.js';
import { REASONS, ReviewError, ReviewLog } from './reviews.js';

const root = dirname(fileURLToPath(import.meta.url));
const casesPath = resolve(process.argv[2] ?? join(root, 'data/cases.csv'));
const importsDir = resolve(process.env.IMPORTS_DIR ?? join(root, 'data/imports'));
const reviewsPath = resolve(process.env.REVIEWS_PATH ?? join(root, 'data/reviews.jsonl'));
const port = Number(process.env.PORT ?? 3000);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CSV_BYTES = 5 * 1024 * 1024;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

const items = new Map();
const log = new ReviewLog(reviewsPath);

// The base file loads first, then each import in the order it was made. Uploaded
// files are kept as they arrived, so the case list can always be rebuilt from them.
function loadCases() {
  const files = existsSync(casesPath) ? [casesPath] : [];
  if (existsSync(importsDir)) {
    files.push(...readdirSync(importsDir).filter((name) => name.endsWith('.csv')).sort()
      .map((name) => join(importsDir, name)));
  }
  for (const file of files) {
    for (const item of parseCaseFile(readFileSync(file, 'utf8'))) items.set(item.case.case_id, item);
  }
}

function withReview(item) {
  const review = log.current(item.case.case_id);
  return { ...item, review: review && reviewStillApplies(review, item.automated) ? review : null };
}

const casesPayload = () => ({
  policy: { version: POLICY_VERSION, quote_limit_eur: QUOTE_LIMIT_EUR },
  recommendations: RECOMMENDATIONS,
  reasons: REASONS,
  cases: [...items.values()].map(withReview),
});

function importCases(text) {
  const incoming = parseCaseFile(text);
  const summary = { added: 0, updated: 0, unchanged: 0, needs_review_again: 0 };
  const changes = [];

  for (const item of incoming) {
    const existing = items.get(item.case.case_id);
    if (!existing) {
      summary.added += 1;
      changes.push(item);
    } else if (JSON.stringify(existing.case) === JSON.stringify(item.case)) {
      summary.unchanged += 1;
    } else {
      summary.updated += 1;
      if (withReview(existing).review && !withReview(item).review) summary.needs_review_again += 1;
      changes.push(item);
    }
  }

  if (changes.length) {
    mkdirSync(importsDir, { recursive: true });
    writeFileSync(join(importsDir, `${Date.now()}.csv`), text);
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
  const { pathname } = new URL(request.url, 'http://localhost');
  const key = `${request.method} ${pathname}`;

  if (request.method === 'GET' && STATIC_FILES[pathname]) {
    const [file, type] = STATIC_FILES[pathname];
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    response.end(readFileSync(join(root, 'public', file)));
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
    log.record(item, body);
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
  sendJson(response, 404, { error: 'Not found.' });
}

loadCases();

createServer((request, response) => {
  route(request, response).catch((error) => {
    if (error instanceof ReviewError || error instanceof CaseFileError) {
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
});
