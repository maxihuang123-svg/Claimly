// Claimant callback API. Written against the web Request/Response so the same handler can run
// in a Cloudflare Function later. Only the contact store and the Node adapter (node.js) are Node-specific.
//
//   GET  /api/calls                  every contact, for the page
//   POST /api/calls                  { case_id } -> signed URL for a browser call
//   POST /api/calls/connected        { id, conversation_id?, error? }  the browser reports its session
//   GET  /api/calls/result?id=...    fetches the call's analysis from ElevenLabs once, then keeps it
//
// The ElevenLabs key stays on the server. What the agent asks for is worked out here from the case,
// never taken from the browser.

import { readText, TooLarge } from '../body.js';
import { canCall, joinList, missingItems } from '../public/missing.js';

const EL = 'https://api.elevenlabs.io/v1';
const FINAL = ['done', 'failed'];
const STARTED_BY = 'Claimly app'; // calls are started from the app, not signed by a person
const MAX_JSON_BYTES = 64 * 1024;

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

export function createCallApi({ env, findItem, contacts, fetch = globalThis.fetch }) {
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
    const variables = { case_id: item.case.case_id, missing_items: joinList(missing) };
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
    return json({ contact: await contacts.update(contact.id, { result: update }) });
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
