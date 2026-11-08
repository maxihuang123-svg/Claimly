// "Missing information" page: open claims the policy sent to request information, and the two ways of asking
// the claimant for exactly what is missing: the callback assistant, and an email with a short form (calls/email.js). Mounted by one entry in PAGES (app.js).
// What a claimant says is shown as an unconfirmed note. It never changes the case or its review.

import { canCall, joinList, missingItems } from './missing.js';
import { pageHint } from './help.js';
import { showIncomingCall } from './phone.js';

const CLIENT_URL = 'https://esm.sh/@elevenlabs/client@1.35.0'; // loaded only when a browser call starts
const CALLER = 'Claimly Claims'; // the name on the claimant's call screen
const POLL_MS = 4000;
const FINAL = ['done', 'failed'];

const ANSWER_LABELS = {
  claimant_name: 'Name given',
  repair_type: 'Repair type',
  repair_description: 'Repair, in their words',
  claimant_reached: 'Reached claimant',
  will_send_documents: 'Will send what is missing',
  documents_expected_by: 'Expected by',
  callback_requested: 'Wants a call back',
  new_information: 'New information',
  claimant_questions: 'Open questions',
};

const VALUE_LABELS = {
  standard: 'Standard repair',
  ev_high_voltage_battery: 'EV high-voltage battery',
  unknown: 'Did not know',
};
const OUTCOME_NAMES = {
  routine_processing: 'Routine processing',
  request_information: 'Request information',
  human_review: 'Human review',
};
const FIELD_NAMES = { repair_type: 'Repair type', incident_report_present: 'Incident report', itemized_quote_present: 'Itemized quote' };
const NOTE_LABELS = { repair_description: 'Repair, in their words' };

export const callsIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M5.5 2.5h-2a1 1 0 0 0-1 1C2.5 9 7 13.5 12.5 13.5a1 1 0 0 0 1-1v-2l-2.5-1-1.2 1.2A6 6 0 0 1 5.3 6.2L6.5 5z"/></svg>';

const state = {
  contacts: [],
  loaded: false,
  loading: false,
  loadError: null,
  expandedId: null,
  error: null,
  session: null, // the browser call ringing or in progress: { caseId, contactId, conversation, hungUp }
  sending: null, // case id while its email is being sent
  pollFailed: new Map(), // contact id -> message, polling stops for that contact until "Check again"
};

let context = null; // { container, items, status } from app.js
let pollTimer = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
const formatTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// Claims that need information, plus those a call already completed, so the result stays in view.
const requestItems = () => context.items.filter((item) => item.automated.recommendation === 'request_information'
  || state.contacts.some((contact) => contact.case_id === item.case.case_id && contact.applied));
const contactsFor = (caseId) => state.contacts.filter((contact) => contact.case_id === caseId)
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

/* Server calls */

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'The server could not complete that. Try again.');
  return data;
}

function putContact(contact) {
  const index = state.contacts.findIndex((existing) => existing.id === contact.id);
  if (index === -1) state.contacts.push(contact);
  else state.contacts[index] = contact;
}

async function load() {
  state.loading = true;
  state.loadError = null;
  try {
    state.contacts = (await api('/api/calls')).contacts;
    state.loaded = true;
  } catch (error) {
    state.loadError = error.message;
  }
  state.loading = false;
  refresh();
  schedulePoll();
}

/* Polling for call results */

const isPending = (contact) => contact.conversation_id && !contact.error
  && !FINAL.includes(contact.result?.status) && !state.pollFailed.has(contact.id);

const onPage = () => Boolean(context?.container.querySelector('[data-calls-page]'));

// While this page is open it keeps checking, so a call taken on another device (a phone) shows up
// here as it happens. Elsewhere it only follows calls that still wait for their result.
function schedulePoll() {
  clearTimeout(pollTimer);
  if (onPage() || state.contacts.some(isPending)) pollTimer = setTimeout(poll, POLL_MS);
}

async function poll() {
  const known = new Map(state.contacts.map((contact) => [contact.id, contact]));
  const isNewlyApplied = (contact) => contact.applied && !known.get(contact.id)?.applied;
  let claimsChanged = false;
  if (onPage()) {
    try {
      for (const contact of (await api('/api/calls')).contacts) {
        if (isNewlyApplied(contact)) claimsChanged = true;
        putContact(contact);
      }
    } catch { /* try again on the next round */ }
  }
  // A browser call still in progress on this device has nothing to analyse yet.
  const pending = state.contacts.filter((contact) => isPending(contact) && contact.id !== state.session?.contactId);
  await Promise.all(pending.map(async (contact) => {
    try {
      const updated = (await api(`/api/calls/result?id=${encodeURIComponent(contact.id)}`)).contact;
      if (isNewlyApplied(updated)) claimsChanged = true;
      putContact(updated);
    } catch (error) {
      state.pollFailed.set(contact.id, error.message);
    }
  }));
  // A call updated a claim: reload the claims so every page shows its new recommendation.
  if (claimsChanged) await context.onClaimsChanged?.();
  refresh();
  schedulePoll();
}

/* Actions */

function report(contactId, patch) {
  api('/api/calls/connected', { id: contactId, ...patch })
    .then(({ contact }) => { putContact(contact); refresh(); })
    .catch(() => { /* The call goes on; its result can still be fetched later. */ });
}

// The claimant's side of a call, on this device: it rings like a phone, and answering starts the
// voice session. Nothing is recorded unless the call is answered.
function ringBrowser(caseId) {
  state.error = null;
  const client = import(CLIENT_URL); // load while it rings
  client.catch(() => {});
  const session = { caseId, contactId: null, conversation: null, hungUp: false };
  state.session = session;
  refresh();

  const finish = () => {
    if (state.session === session) state.session = null;
    refresh();
    schedulePoll();
  };
  const screen = showIncomingCall({
    caller: CALLER,
    detail: `Motor claim ${caseId}`,
    onDecline: finish,
    onAccept: () => connect(session, client, screen).finally(finish),
    onHangUp: () => {
      session.hungUp = true;
      if (session.conversation) session.conversation.endSession();
      else screen.ended();
    },
    onMute: (muted) => session.conversation?.setMicMuted(muted),
  });
}

async function connect(session, client, screen) {
  try {
    const { VoiceConversation } = await client.catch(() => {
      throw new Error('The voice client could not be loaded. Check the internet connection.');
    });
    const started = await api('/api/calls', { case_id: session.caseId });
    putContact(started.contact);
    session.contactId = started.contact.id;
    refresh();
    if (session.hungUp) {
      report(session.contactId, { error: 'Ended before the call connected.' });
      return;
    }

    // Resolves once connected, and the promise below waits for the call to end.
    await new Promise((resolve, reject) => {
      VoiceConversation.startSession({
        signedUrl: started.signed_url,
        dynamicVariables: started.dynamic_variables,
        onConnect: ({ conversationId }) => {
          report(session.contactId, { conversation_id: conversationId });
          screen.connected();
        },
        onError: (message) => report(session.contactId, { error: String(message) }),
        onModeChange: ({ mode }) => screen.speaking(mode === 'speaking'),
        onDisconnect: () => {
          screen.ended();
          resolve();
        },
      }).then((conversation) => {
        session.conversation = conversation;
        if (session.hungUp) conversation.endSession();
      }, reject);
    });
  } catch (error) {
    // Most often the microphone was blocked.
    const message = error.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it and try again.' : error.message;
    screen.failed(message);
    if (session.contactId) report(session.contactId, { error: message });
  }
}

async function sendEmail(caseId) {
  state.error = null;
  state.sending = caseId;
  refresh();
  try {
    putContact((await api('/api/emails', { case_id: caseId })).contact);
  } catch (error) {
    state.error = error.message;
    await load(); // a failed send is still recorded, with its error
  }
  state.sending = null;
  refresh();
}

function checkAgain(contactId) {
  state.pollFailed.delete(contactId);
  refresh();
  poll();
}

function toggleRow(caseId) {
  state.expandedId = state.expandedId === caseId ? null : caseId;
  state.error = null;
  refresh();
}

/* Rendering */

const isEmail = (contact) => contact.channel === 'email';

function contactStatus(contact) {
  if (contact.error) return ['failed', 'Failed'];
  if (isEmail(contact)) {
    if (contact.applied) return ['done', 'Email → Updated'];
    if (contact.reply) return ['done', 'Answered'];
    if (Date.now() > Date.parse(contact.expires_at)) return ['warn', 'Link expired'];
    return ['active', 'Email sent'];
  }
  if (state.session?.contactId === contact.id) return ['active', 'In call'];
  if (contact.applied) return ['done', 'Call → Updated'];
  const status = contact.result?.status;
  if (status === 'done') {
    const reached = contact.result.data.claimant_reached?.value;
    return reached === false ? ['warn', 'Not reached'] : ['done', 'Called'];
  }
  if (status === 'failed') return ['failed', 'Failed'];
  return ['active', contact.conversation_id ? 'In progress' : 'Starting'];
}

function renderStatus(contact) {
  if (!contact) return '<span class="pending">Not contacted</span>';
  const [kind, label] = contactStatus(contact);
  return `<span class="call-status" data-state="${kind}">${label}</span>`;
}

function renderAnswer(value) {
  if (value === null || value === undefined || value === '') return '<span class="blank">Not stated</span>';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return escapeHtml(VALUE_LABELS[value] ?? value);
}

// The moment the demo is about: the answer filled the gap and the rules ran again.
function renderApplied(applied, source) {
  if (!applied) return '';
  const changes = Object.entries(applied.changes)
    .map(([field, value]) => `${FIELD_NAMES[field] ?? field}: ${value === true ? 'Received' : VALUE_LABELS[value] ?? value}`).join(', ');
  return `<div class="call-applied">
    <p><strong>Claim updated from this ${source}.</strong> ${escapeHtml(changes)}.</p>
    <p>Rules re-run under policy ${escapeHtml(applied.after.policy_version)}:
      ${escapeHtml(OUTCOME_NAMES[applied.before.recommendation])} → <strong>${escapeHtml(OUTCOME_NAMES[applied.after.recommendation])}</strong></p>
  </div>`;
}

// What the claimant answered on the form. Documents open from here; notes are for a person to check.
function renderReply(reply) {
  if (!reply) return '';
  const rows = [
    ...Object.entries(reply.answers).map(([field, value]) => [FIELD_NAMES[field] ?? field, renderAnswer(value)]),
    ...reply.documents.map((doc) => [FIELD_NAMES[doc.field] ?? doc.field,
      `<a href="/api/documents?id=${encodeURIComponent(doc.id)}" target="_blank" rel="noopener">${escapeHtml(doc.name)}</a>`]),
    ...Object.entries(reply.notes).map(([field, text]) => [NOTE_LABELS[field] ?? FIELD_NAMES[field] ?? field, escapeHtml(text)]),
  ];
  return `<p class="call-caption">Claimant answered ${escapeHtml(formatTime(reply.at))}. A chosen repair type or an uploaded document updates the claim; text is a note for a person.</p>
    <table class="call-answers"><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${value}</td></tr>`).join('')}</tbody></table>`;
}

function renderEmail(contact) {
  const waiting = !contact.reply && !contact.error && contactStatus(contact)[1] === 'Email sent';
  return `<li class="contact">
    <p class="contact-head">${renderStatus(contact)}<span>Email, ${escapeHtml(formatTime(contact.created_at))}</span>
      <span>by ${escapeHtml(contact.initiated_by)}</span></p>
    <p class="notice">Sent to ${escapeHtml(contact.to)}, asking for ${escapeHtml(joinList(contact.missing_items))}. Policy ${escapeHtml(contact.policy_version)}, ${escapeHtml(contact.rule_id)}.</p>
    ${contact.error ? `<p class="error">${escapeHtml(contact.error)}</p>` : ''}
    ${renderApplied(contact.applied, 'email')}
    ${renderReply(contact.reply)}
    ${waiting ? `<p class="notice"><a href="/reply/${encodeURIComponent(contact.token)}" target="_blank" rel="noopener">Open the claimant's form</a></p>` : ''}
  </li>`;
}

function renderContact(contact) {
  if (isEmail(contact)) return renderEmail(contact);
  const result = contact.result;
  const failed = state.pollFailed.get(contact.id);
  const answers = result && Object.keys(result.data).length ? `
    <p class="call-caption">${contact.applied ? 'Claimant said. Only a clear repair type updates the claim; the rest are notes for a person.' : 'Claimant said (unconfirmed, does not change the claim)'}</p>
    <table class="call-answers"><tbody>${Object.entries(ANSWER_LABELS).map(([key, label]) => `
      <tr title="${escapeHtml(result.data[key]?.rationale)}"><th scope="row">${label}</th><td>${renderAnswer(result.data[key]?.value)}</td></tr>`).join('')}
    </tbody></table>` : '';
  const newInfo = result?.data.new_information?.value;
  const transcript = result?.transcript.length ? `<details class="call-transcript">
      <summary>Transcript, ${result.transcript.length} turns${result.duration_secs ? `, ${result.duration_secs} s` : ''}</summary>
      <ol>${result.transcript.map((turn) => `<li><strong>${turn.role === 'agent' ? 'Assistant' : 'Claimant'}</strong> ${escapeHtml(turn.message)}</li>`).join('')}</ol>
    </details>` : '';

  return `<li class="contact">
    <p class="contact-head">${renderStatus(contact)}<span>${escapeHtml(formatTime(contact.created_at))}</span>
      <span>by ${escapeHtml(contact.initiated_by)}</span></p>
    <p class="notice">Asked for ${escapeHtml(joinList(contact.missing_items))}. Policy ${escapeHtml(contact.policy_version)}, ${escapeHtml(contact.rule_id)}.</p>
    ${contact.error ? `<p class="error">${escapeHtml(contact.error)}</p>` : ''}
    ${failed ? `<p class="error">${escapeHtml(failed)} <button type="button" class="link" data-call-check="${contact.id}">Check again</button></p>` : ''}
    ${renderApplied(contact.applied, 'call')}
    ${result?.summary ? `<p>${escapeHtml(result.summary)}</p>` : ''}
    ${answers}
    ${typeof newInfo === 'string' && newInfo.trim() ? '<p class="call-flag">The claimant mentioned new information. Verify it before any fact on the claim changes.</p>' : ''}
    ${transcript}
  </li>`;
}

function renderDialer(item) {
  const id = escapeHtml(item.case.case_id);
  if (item.case.case_status !== 'open') {
    return '<p class="notice">This claim is closed, so the assistant does not call. Earlier contacts are listed here.</p>';
  }
  if (!canCall(item)) {
    return `<p class="notice">Nothing is missing any more. The claim is now in <strong>${escapeHtml(OUTCOME_NAMES[item.automated.recommendation])}</strong>.</p>`;
  }
  return `<p>The assistant asks only for <strong>${escapeHtml(joinList(missingItems(item)))}</strong>.
      It cannot decide, promise payment or change the claim.</p>
    <div class="call-line">
      <button type="button" class="save" data-call-browser="${id}" ${state.session ? 'disabled' : ''}>Incoming call</button>
      <span class="notice">This device rings like a phone. Answer it as the claimant.</span>
    </div>
    <div class="call-line">
      <button type="button" class="button" data-call-email="${id}" ${state.sending ? 'disabled' : ''}>${state.sending === item.case.case_id ? 'Sending…' : 'Send email'}</button>
      <span class="notice">A link to a short form that asks only for what is missing.</span>
    </div>
    ${state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : ''}`;
}

function renderRow(item) {
  const { case: record } = item;
  const id = escapeHtml(record.case_id);
  const open = state.expandedId === record.case_id;
  const history = contactsFor(record.case_id);
  return `<tr class="call-row" data-call-row="${id}" data-open="${open}">
    <td class="c-case">${id}</td>
    <td class="c-summary" title="${escapeHtml(record.claim_summary)}">${escapeHtml(record.claim_summary)}</td>
    <td class="c-missing">${escapeHtml(joinList(missingItems(item)))}</td>
    <td class="c-contact">${renderStatus(history[0])}</td>
    <td class="c-open"><button type="button" class="chevron" data-call-toggle="${id}" aria-expanded="${open}" aria-label="${open ? 'Close' : 'Open'} ${id}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5"/></svg></button></td>
  </tr>${open ? `<tr class="detail"><td colspan="5"><div class="detail-grid">
    <section class="call-dialer" aria-label="Call the claimant">${renderDialer(item)}</section>
    <section aria-label="Contact history">
      <h2 class="field-label">Contact history</h2>
      ${history.length ? `<ol class="contacts">${history.map(renderContact).join('')}</ol>` : '<p class="notice">No contact yet.</p>'}
    </section>
  </div></td></tr>` : ''}`;
}

function renderBody() {
  if (context.status === 'loading' || !state.loaded && !state.loadError) {
    return `<div aria-label="Loading">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
  }
  if (context.status === 'failed') {
    return '<div class="state"><strong>Claims could not be loaded</strong>Check that the server is running with npm start.</div>';
  }
  if (state.loadError) {
    return `<div class="state"><strong>Calls could not be loaded</strong>${escapeHtml(state.loadError)}<br>
      <button type="button" class="button" data-call-reload>Try again</button></div>`;
  }
  const items = requestItems().sort((a, b) => Number(canCall(b)) - Number(canCall(a)));
  if (!items.length) {
    return '<div class="state"><strong>No claims are missing information</strong>Cases the policy sends to request information appear here.</div>';
  }
  return `<table class="claims calls">
    <thead><tr>
      <th scope="col" class="c-case">Case</th>
      <th scope="col" class="c-summary">Claim</th>
      <th scope="col" class="c-missing">Still needed</th>
      <th scope="col" class="c-contact">Contact</th>
      <th scope="col" class="c-open"><span hidden>Open</span></th>
    </tr></thead>
    <tbody>${items.map(renderRow).join('')}</tbody>
  </table>`;
}

function draw() {
  const callable = requestItems().filter(canCall);
  const contacted = callable.filter((item) => contactsFor(item.case.case_id).length).length;
  const progress = callable.length ? `${contacted} of ${callable.length} open claims contacted` : '';

  context.container.innerHTML = `<div data-calls-page>
    <div class="page-head"><h1>Missing information</h1><p class="progress">${progress}</p></div>
    ${pageHint('calls')}
    ${renderBody()}
  </div>`;
}

// Redraw only while this page is the one on screen.
function refresh() {
  if (context?.container.querySelector('[data-calls-page]')) draw();
}

export function renderCalls(nextContext) {
  context = nextContext;
  if (!state.loaded && !state.loading && !state.loadError) load();
  draw();
  if (state.loaded) schedulePoll(); // back on this page: start watching again
}

/* Events. app.js handles its own data attributes; these all start with data-call. */

document.addEventListener('click', (event) => {
  if (!context?.container.querySelector('[data-calls-page]')) return;
  const button = event.target.closest('button');
  if (button) {
    const { callToggle, callBrowser: browserId, callEmail, callCheck } = button.dataset;
    if (callToggle) toggleRow(callToggle);
    else if (browserId) ringBrowser(browserId);
    else if (callEmail) sendEmail(callEmail);
    else if (callCheck) checkAgain(callCheck);
    else if ('callReload' in button.dataset) load();
    return;
  }
  const row = event.target.closest('[data-call-row]');
  if (row && !String(getSelection())) toggleRow(row.dataset.callRow);
});
