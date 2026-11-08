// Claimant callback API. Written against the web Request/Response so the same handler can run
// in a Cloudflare Function later. Only the contact store and the Node adapter (node.js) are Node-specific.
//
//   GET  /api/calls                  every contact, for the page
//   POST /api/calls                  { case_id } -> signed URL for a browser call
//   POST /api/calls/connected        { id, conversation_id?, error? }  the browser reports its session
//   POST /api/calls/answer           { id, repair_type }  the agent's answer during the call (its client tool);
//                                    a clear answer to a blank field updates the claim at once (UPDATES)
//   GET  /api/calls/result?id=...    fetches the call's analysis from ElevenLabs once, then keeps it;
//                                    if nothing was applied during the call, a clear answer there updates the claim
//
// The ElevenLabs key stays on the server. What the agent asks for is worked out here from the case,
// never taken from the browser.

import { readText, TooLarge } from '../body.js';
import { canCall, joinList, missingFields, missingItems } from '../public/missing.js';

const EL = 'https://api.elevenlabs.io/v1';
const FINAL = ['done', 'failed'];
const STARTED_BY = 'Claimly app'; // calls are started from the app, not signed by a person

// Claim fields a claimant can settle on a call, with the answers that count as clear. A clear answer
// to a field that is still blank updates the claim and the rules run again; anything else ("unknown",
// a field that already has a value) stays with a person.
const UPDATES = { repair_type: ['standard', 'ev_high_voltage_battery'] };
const outcome = (automated) => ({
  recommendation: automated.recommendation, policy_version: automated.policy_version, rule_id: automated.rule_id,
});
const MAX_JSON_BYTES = 64 * 1024;
const ANSWER_WINDOW_MS = 15 * 60_000; // answers are taken while a call can still be going on

// The end of the agent's first message, so the call opens with what is missing.
function openingQuestion(item) {
  const fields = missingFields(item);
  if (fields.length === 1 && fields[0] === 'repair_type') return "One quick question: what's being repaired, and is the car electric?";
  return `We still need ${joinList(missingItems(item))}. Can you help with that?`;
}

class CallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

function need(env, name) {
  if (!env[name]) throw new CallError(500, `${name} is not set on the server.`);
  return env[name];
}

async function readJson(request) {
  try {
    return JSON.parse(await readText(request, MAX_JSON_BYTES));
  } catch (error) {
    if (error instanceof TooLarge) throw new CallError(413, 'Request is too large.');
    throw new CallError(400, 'Request is not valid JSON.');
  }
}

// updateCase(caseId, changes) re-imports the case with the changes and returns its new automated result.
export function createCallApi({ env, findItem, contacts, updateCase = null, fetch = globalThis.fetch }) {
  async function el(path, init = {}) {
    const response = await fetch(`${EL}${path}`, {
      ...init,
      headers: { 'xi-api-key': need(env, 'ELEVENLABS_API_KEY'), ...init.headers },
    });
    if (!response.ok) throw new CallError(502, `ElevenLabs ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return response.json();
  }

  async function start(request) {
    const body = await readJson(request);
    const item = findItem(String(body.case_id ?? ''));
    if (!item) throw new CallError(404, `Unknown case ${body.case_id}.`);
    if (!canCall(item)) throw new CallError(400, 'Calls are only for open claims that need more information.');

    // Get the signed URL before recording, so a call that cannot start leaves no contact behind.
    const agent = encodeURIComponent(need(env, 'ELEVENLABS_AGENT_ID'));
    const { signed_url: signedUrl } = await el(`/convai/conversation/get-signed-url?agent_id=${agent}`);

    const missing = missingItems(item);
    const contact = await contacts.add({
      case_id: item.case.case_id,
      initiated_by: STARTED_BY,
      missing_items: missing,
      policy_version: item.automated.policy_version,
      rule_id: item.automated.rule_id,
    });
    const variables = { case_id: item.case.case_id, missing_items: joinList(missing), question: openingQuestion(item) };
    return json({ contact, signed_url: signedUrl, dynamic_variables: variables }, 201);
  }

  async function connected(request) {
    const body = await readJson(request);
    const contact = await contacts.get(String(body.id ?? ''));
    if (!contact) throw new CallError(404, 'Unknown call.');
    const patch = {};
    if (body.conversation_id && !contact.conversation_id) {
      if (!/^[\w-]+$/.test(body.conversation_id)) throw new CallError(400, 'Invalid conversation id.');
      patch.conversation_id = body.conversation_id;
    }
    if (body.error) patch.error = String(body.error).slice(0, 300);
    return json({ contact: Object.keys(patch).length ? await contacts.update(contact.id, patch) : contact });
  }

  // answers: { field: value }. Only a clear value for a field that is still blank changes the claim.
  function applyAnswers(contact, answers, during) {
    if (!updateCase || contact.applied) return null;
    const item = findItem(contact.case_id);
    if (!item || item.case.case_status !== 'open') return null;
    const changes = Object.fromEntries(Object.entries(UPDATES)
      .filter(([field, clear]) => item.case[field] === null && clear.includes(answers[field]))
      .map(([field]) => [field, answers[field]]));
    if (!Object.keys(changes).length) return null;
    const after = updateCase(item.case.case_id, changes);
    return { at: new Date().toISOString(), during, changes, before: outcome(item.automated), after: outcome(after) };
  }

  // The agent's client tool, relayed by the claimant's browser while the call is going on.
  async function answer(request) {
    const body = await readJson(request);
    const contact = await contacts.get(String(body.id ?? ''));
    if (!contact) throw new CallError(404, 'Unknown call.');
    if (contact.applied) return json({ contact });
    if (FINAL.includes(contact.result?.status) || Date.now() - Date.parse(contact.created_at) > ANSWER_WINDOW_MS) {
      throw new CallError(400, 'This call is over.');
    }
    const applied = applyAnswers(contact, { repair_type: body.repair_type }, 'call');
    if (!applied) throw new CallError(400, 'That answer does not change the claim.');
    return json({ contact: await contacts.update(contact.id, { applied }) });
  }

  // Claimant statements, kept apart from claim facts. Once ElevenLabs has finished the analysis the result
  // is stored and ElevenLabs is not asked again.
  async function result(url) {
    const contact = await contacts.get(url.searchParams.get('id') ?? '');
    if (!contact) throw new CallError(404, 'Unknown contact.');
    if (!contact.conversation_id || FINAL.includes(contact.result?.status)) return json({ contact });

    const call = await el(`/convai/conversations/${encodeURIComponent(contact.conversation_id)}`);
    const collected = call.analysis?.data_collection_results ?? {};
    const update = {
      status: call.status,
      call_successful: call.analysis?.call_successful ?? null,
      summary: call.analysis?.transcript_summary ?? null,
      duration_secs: call.metadata?.call_duration_secs ?? null,
      data: Object.fromEntries(Object.entries(collected).map(([key, answer]) => (
        [key, { value: answer.value ?? null, rationale: answer.rationale ?? '' }]
      ))),
      transcript: (call.transcript ?? []).filter((turn) => turn.message)
        .map((turn) => ({ role: turn.role, message: turn.message })),
    };
    if (contact.result?.status === update.status && !FINAL.includes(update.status)) return json({ contact });
    const applied = update.status === 'done'
      ? applyAnswers(contact, Object.fromEntries(Object.entries(update.data).map(([field, answer]) => [field, answer.value])), 'analysis')
      : null;
    return json({ contact: await contacts.update(contact.id, applied ? { result: update, applied } : { result: update }) });
  }

  // Returns null for paths that are not ours, so the caller can carry on routing.
  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/calls' && !url.pathname.startsWith('/api/calls/')) return null;
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /api/calls': return json({ contacts: await contacts.all() });
        case 'POST /api/calls': return await start(request);
        case 'POST /api/calls/connected': return await connected(request);
        case 'POST /api/calls/answer': return await answer(request);
        case 'GET /api/calls/result': return await result(url);
        default: return json({ error: 'Not found.' }, 404);
      }
    } catch (error) {
      if (error instanceof CallError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'The server could not complete that request.' }, 500);
    }
  };
}
