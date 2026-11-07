import { readText, TooLarge } from './body.js';
import { createCallApi } from './calls/api.js';
import { ContactLog } from './calls/contacts.js';
import { CaseFileError, parseCaseFile, reviewStillApplies } from './cases.js';
import { evaluate, RECOMMENDATIONS } from './engine.js';
import { OutcomeStore, measurementPayload } from './measurement.js';
import { describeChoices, describePolicy, PolicyError, PolicyStore, validatePolicy } from './policies.js';
import { REASONS, ReviewError, ReviewLog } from './reviews.js';
import { ValidationStore, hash } from './validation.js';

const MAX_JSON_BYTES = 64 * 1024;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

// The whole API as one web handler, Request in and Response out. server.js runs it on
// Node with files, and worker/index.js runs it in a Durable Object on Cloudflare.
// logs: { reviews, policies, validation, outcomes, contacts }, each a path or a log (storage.js).
// imports: uploaded case files (storage.js). baseCases: CSV text loaded before them, if any.
export function createApp({ logs, imports, baseCases = null, engineVersion, examples, env = {}, fetch }) {
  const items = new Map();
  const log = new ReviewLog(logs.reviews);
  const policies = new PolicyStore(logs.policies);
  const validation = new ValidationStore(logs.validation, engineVersion, examples);
  const outcomes = new OutcomeStore(logs.outcomes);
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
    if (!policy) throw new Error(`${name} was imported under ${version}, which is not in ${policies.path}.`);
    return policy;
  }

  // The base file loads first, then each import in the order it was made. Uploaded
  // files are kept as they arrived, so the case list can always be rebuilt from them.
  // A case keeps the policy it was evaluated under until an import changes its data.
  let lastImportAt = 0;
  function loadCases() {
    const files = baseCases === null ? [] : [[baseCases, policies.original]];
    for (const { name, text } of imports.list()) {
      lastImportAt = Math.max(lastImportAt, Number.parseInt(name, 10) || 0);
      files.push([text, policyForImport(name)]);
    }
    for (const [text, policy] of files) {
      for (const item of parseCaseFile(text, policy, policies.original)) {
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
      // Names sort in import order. Two imports in the same millisecond (or under a
      // frozen Worker clock) must still get different names.
      lastImportAt = Math.max(Date.now(), lastImportAt + 1);
      imports.save(`${lastImportAt}.${policy.version}.csv`, text);
      for (const item of changes) items.set(item.case.case_id, item);
    }
    return summary;
  }

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  async function readBody(request, limit) {
    try {
      return await readText(request, limit);
    } catch (error) {
      if (error instanceof TooLarge) throw new ReviewError('That file is too large. The limit is 5 MB.');
      throw error;
    }
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

  const calls = createCallApi({
    env, fetch, contacts: new ContactLog(logs.contacts),
    findItem: (caseId) => (items.has(caseId) ? withReview(items.get(caseId)) : null),
  });

  async function route(request) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;

    if (key === 'GET /api/measurement') {
      const baseline = selectedPolicy(url.searchParams.get('baseline') ?? policies.original.version);
      const candidate = selectedPolicy(url.searchParams.get('candidate') ?? policies.current.version);
      return json({ ...measurementPayload(validationItems(), baseline, candidate, validation, outcomes),
        active_version: policies.current.version, policies: [...policies.versions.map(p => p.version), ...(policies.draft ? ['draft'] : [])] });
    }
    if (key === 'POST /api/outcomes') {
      const body = await readJson(request);
      const item = withReview(findItem(body.case_id));
      if (body.decision_token !== hash([item.case, item.automated])) throw new ReviewError('The assessed decision changed. Refresh data and check the claim before saving.');
      outcomes.record(item, body);
      return json({ saved: true }, 201);
    }
    if (key === 'GET /api/cases') return json(casesPayload());
    if (key === 'POST /api/import') {
      const summary = importCases(await readBody(request, MAX_CSV_BYTES));
      return json({ summary, ...casesPayload() });
    }
    if (key === 'POST /api/reviews') {
      const body = await readJson(request);
      const item = findItem(body.case_id);
      log.record(withReview(item), body);
      return json(withReview(item), 201);
    }
    if (key === 'POST /api/reviews/undo') {
      const body = await readJson(request);
      const item = findItem(body.case_id);
      log.retract(item.case.case_id, body.reviewer);
      return json(withReview(item));
    }
    if (key === 'GET /api/policies') return json(policiesPayload());
    if (key === 'POST /api/policies/draft/start') {
      policies.startDraft();
      return json(policiesPayload(), 201);
    }
    if (key === 'POST /api/policies/draft') {
      policies.saveDraft(await readJson(request));
      return json(policiesPayload());
    }
    if (key === 'POST /api/policies/draft/discard') {
      policies.discardDraft();
      return json(policiesPayload());
    }
    if (key === 'POST /api/policies/draft/activate') {
      const body = await readJson(request);
      const run = validation.assertRelease(body.run_id, policies.current, selectedPolicy('draft'), validationItems(), body.approver);
      policies.activateDraft({ validation_run_id: run.id, approved_by: body.approver.trim(),
        recheck_case_ids: run.claims.filter((c) => c.needs_recheck).map((c) => c.case.case_id) });
      return json(policiesPayload());
    }
    if (key === 'GET /api/validation') {
      const baseline = selectedPolicy(url.searchParams.get('baseline') ?? policies.current.version);
      const candidate = selectedPolicy(url.searchParams.get('candidate') ?? (policies.draft ? 'draft' : policies.current.version));
      const preview = validation.preview(baseline, candidate, validationItems());
      const runs = validation.events.filter((e) => e.type === 'run' && e.mode === 'impact' && e.baseline.version === baseline.version && e.candidate.version === candidate.version);
      const run = runs.at(-1) ?? null;
      return json({ ...policiesPayload(), preview, run,
        stale: !!run && run.fingerprint !== validation.fingerprint(baseline, candidate, validationItems()) });
    }
    if (key === 'POST /api/validation/run') {
      const body = await readJson(request);
      const run = validation.run(selectedPolicy(body.baseline), selectedPolicy(body.candidate), validationItems(), body.reviewer);
      return json(run, 201);
    }
    if (key === 'POST /api/validation/labels') {
      const body = await readJson(request);
      const candidate = selectedPolicy(body.candidate);
      if (body.token !== validation.labelSetup(candidate).token) {
        throw new PolicyError('The policy or labels changed. Reload the validation tab before saving labels.');
      }
      validation.saveLabels(candidate, body.expected);
      return json(validation.labelSetup(candidate), 201);
    }
    return (await calls(request)) ?? json({ error: 'Not found.' }, 404);
  }

  loadCases();

  return {
    items,
    policies,
    async handle(request) {
      try {
        return await route(request);
      } catch (error) {
        if (error instanceof ReviewError || error instanceof CaseFileError || error instanceof PolicyError) {
          return json({ error: error.message }, 400);
        }
        console.error(error);
        return json({ error: 'The server could not complete that request.' }, 500);
      }
    },
  };
}
