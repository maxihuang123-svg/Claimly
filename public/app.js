import { createMeasurementUI } from './measurement.js';
import { createValidationUI } from './validation.js';
import { createLabelsUI } from './labels.js';
import { callsIcon, renderCalls } from './calls.js';
import { helpIcon, renderHelp } from './help.js';
import { startTour } from './tour.js';

const OUTCOMES = {
  routine_processing: { name: 'Routine processing', short: 'Routine', action: 'Send to routine processing.' },
  request_information: { name: 'Request information', short: 'Request info', action: 'Request information.' },
  human_review: { name: 'Human review', short: 'Human review', action: 'Send to human review.', help: 'Stays with a person.' },
};
const NOT_PROVIDED = 'Not provided';
const TOAST_MS = 6000;

const svg = (body, width = 1.8) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  check: svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>', 2),
  flag: svg('<path d="M3.5 14V2.5h8.5L10 6l2 3.5H3.5"/>'),
  blank: svg('<path d="M3 8h10"/>'),
  arrow: svg('<path d="M2.5 8h11M9.5 4l4 4-4 4"/>', 1.5),
  table: svg('<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6"/>', 1.5),
  document: svg('<path d="M4 2.5h5.5L12.5 5.5v8H4zM6.5 8h4M6.5 10.5h4"/>', 1.5),
  tag: svg('<path d="M2.5 2.5h5.2l5.8 5.8-5.2 5.2-5.8-5.8zM5.5 5.5h.01"/>', 1.5),
  inbox: svg('<path d="M2.5 9h3l1 2h3l1-2h3M4 3h8l1.5 6v4h-11V9z"/>', 1.5),
};
const STATE_LABELS = {
  pass: [ICONS.check, 'OK'],
  trigger: [ICONS.flag, 'Triggered'],
  unknown: [ICONS.blank, 'Cannot check'],
};

// Sidebar pages. To add one, add an entry here with a render function.
// group sorts the sidebar by who uses a page: reviewers first, then rule owners, then help.
const PAGES = [
  { id: 'claims', group: 'review', label: 'Claims review', icon: ICONS.inbox, render: renderClaims },
  { id: 'calls', group: 'review', label: 'Missing information', icon: callsIcon, render: () => renderCalls({ container: dom.page, items: state.items, status: state.status, onClaimsChanged: reloadClaims }) },
  { id: 'all', group: 'rules', label: 'All claims', icon: ICONS.table, render: renderClaims },
  { id: 'policies', group: 'rules', label: 'Policies', icon: ICONS.document, render: renderPolicies },
  { id: 'measurement', group: 'rules', label: 'Measurement', icon: ICONS.flag, render: () => measurementUI.render() },
  { id: 'labels', group: 'rules', label: 'Expected answers', icon: ICONS.tag, render: () => labelsUI.render() },
  { id: 'validation', group: 'rules', label: 'Validation', icon: ICONS.check, render: () => validationUI.render() },
  { id: 'help', group: 'help', label: 'Help', icon: helpIcon, render: () => renderHelp({
    container: dom.page, outcomes: OUTCOMES, reasons: state.reasons, policyVersion: state.policyVersion,
    counts: { toReview: reviewItems().filter((item) => !item.review).length, recheck: state.items.filter((item) => item.needs_recheck).length },
  }) },
];
const NAV_GROUPS = { review: 'Review', rules: 'Rules & quality' };

const RULE_HEADINGS = {
  human_review: 'Send to human review if any of these is true',
  request_information: 'Otherwise, ask for information if any of these is true',
  routine_processing: 'Otherwise, send to routine processing',
};
const DRAFT_SAVE_DELAY_MS = 300;

const dom = {
  nav: document.getElementById('nav'),
  page: document.getElementById('page'),
  toast: document.getElementById('toast'),
};

const state = {
  pageId: PAGES[0].id,
  status: 'loading',
  items: [],
  recommendations: [],
  reasons: [],
  filter: 'all',
  expandedId: null,
  detailIds: new Set(),
  popupPlacement: null,
  reviewer: '',
  drafts: new Map(),
  busy: new Set(),
  error: null,
  banner: null,
  importing: false,
  policyVersion: null,
  policyStatus: 'loading',
  policyData: null,
  openPolicy: null,
  policyEditing: false,
  policyForm: null,
  policyChoices: null,
  policyConfirm: null,
  policyBusy: false,
  policyError: null,
};

let toastTimer;
let draftTimer = null;
let draftSaves = Promise.resolve();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
const humanize = (value) => {
  const text = value.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.slice(1);
};
const outcomeName = (code) => OUTCOMES[code].name;
const lowerFirst = (text) => text[0].toLowerCase() + text.slice(1);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const findItem = (id) => state.items.find((item) => item.case.case_id === id);

// Claims review lists only open claims that wait for a person: sent to human review or to recheck after a
// policy change, and not reviewed yet. Everything else is on All claims, where any claim can still be checked.
const isClosed = (item) => item.case.case_status === 'closed';
const todoItems = () => state.items.filter((item) => !isClosed(item) && !item.review
  && (item.automated.recommendation === 'human_review' || item.needs_recheck));
const reviewItems = () => state.items.filter((item) => !isClosed(item) && item.automated.recommendation === 'human_review');
const routedItems = () => state.items.filter((item) => !isClosed(item) && item.automated.recommendation !== 'human_review');
const closedItems = () => state.items.filter(isClosed);

function visibleItems() {
  if (state.pageId === 'claims') return todoItems();
  if (state.filter === 'reviewed') return state.items.filter((item) => item.review);
  if (state.filter === 'routed') return routedItems();
  if (state.filter === 'closed') return closedItems();
  return state.items;
}

const reasonsFor = (item, decision) => {
  const kind = decision === item.automated.recommendation ? 'confirm' : 'change';
  return state.reasons.filter((reason) => (!reason.kind || reason.kind === kind)
    && (!reason.only_for || reason.only_for === item.automated.recommendation));
};

const alternatives = (item) => state.recommendations.filter((code) => code !== item.automated.recommendation);

const preselectedReason = (item, decision) => (
  reasonsFor(item, decision).find((reason) => reason.preselected)?.code ?? null
);

function draftFor(item) {
  const id = item.case.case_id;
  if (!state.drafts.has(id)) {
    const previous = item.review?.outcome === 'confirmed' ? null : item.review;
    state.drafts.set(id, {
      changing: false,
      decision: previous?.final_recommendation ?? null,
      reason: previous?.reason_code ?? preselectedReason(item, alternatives(item)[0]),
      note: previous?.note ?? '',
    });
  }
  return state.drafts.get(id);
}

/* Shell */

function renderNav() {
  dom.nav.innerHTML = PAGES.map((page, index) => {
    const heading = page.group !== PAGES[index - 1]?.group && NAV_GROUPS[page.group]
      ? `<li class="nav-group">${NAV_GROUPS[page.group]}</li>` : '';
    return `${heading}<li${page.group === 'help' ? ' class="nav-help"' : ''}><button type="button" data-page="${page.id}"
    ${page.id === state.pageId ? 'aria-current="page"' : ''}>${page.icon}${escapeHtml(page.label)}</button></li>`;
  }).join('');
}

function render() {
  renderNav();
  PAGES.find((page) => page.id === state.pageId).render();
}

/* Claims page */

// Overview cards above the table. Every number is a filter or page away.
function renderBento() {
  const open = state.items.filter((item) => !isClosed(item));
  const mix = Object.keys(OUTCOMES).map((code) => [code, open.filter((item) => item.automated.recommendation === code).length]);
  const items = reviewItems();
  const reviewed = items.filter((item) => item.review).length;
  const changed = items.filter((item) => item.review?.outcome === 'changed').length;
  const recheck = state.items.filter((item) => item.needs_recheck).length;
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const target = { routine_processing: 'data-filter="routed"', request_information: 'data-page="calls"', human_review: 'data-page="claims"' };
  return `<section class="bento" aria-label="Overview">
    <div class="card stat">
      <span class="card-label">Waiting for review</span>
      <strong class="stat-value">${items.length - reviewed}</strong>
      <div class="meter" role="img" aria-label="${reviewed} of ${items.length} reviewed"><span style="width:${pct(reviewed, items.length)}%"></span></div>
      <span class="card-foot">${reviewed} of ${items.length} reviewed${changed ? ` · ${changed} changed` : ''}</span>
    </div>
    <div class="card mix">
      <span class="card-label">Next step for ${plural(open.length, 'open claim')}</span>
      <div class="mix-bar" role="img" aria-label="${mix.map(([code, count]) => `${outcomeName(code)} ${count}`).join(', ')}">${mix.map(([code, count]) => (count ? `<span data-outcome="${code}" style="flex:${count}"></span>` : '')).join('')}</div>
      <ul class="mix-legend">${mix.map(([code, count]) => `<li><button type="button" ${target[code]} data-outcome="${code}">
        <i class="outcome-dot"></i><span title="${outcomeName(code)}">${OUTCOMES[code].short}</span><b>${count}</b><small>${pct(count, open.length)}%</small></button></li>`).join('')}</ul>
    </div>
    <div class="card stat">
      <span class="card-label">Active policy</span>
      <strong class="stat-value">${escapeHtml(state.policyVersion)}</strong>
      <span class="status${recheck ? ' status-warn' : ''}">${recheck ? `${plural(recheck, 'claim')} to recheck` : 'In use · no rechecks'}</span>
      <button type="button" class="card-link" data-page="policies">View rules ${ICONS.arrow}</button>
    </div>
  </section>`;
}

function renderHead() {
  const todo = todoItems().length;
  const progress = state.pageId === 'claims'
    ? (todo ? `${plural(todo, 'claim')} to review` : '')
    : `${plural(state.items.length, 'claim')}, ${state.items.filter((item) => item.review).length} reviewed`;
  return `<div class="page-head">
    <h1>${pageTitle()}</h1>
    <button type="button" class="link policy-link" data-page="policies">Current policy ${escapeHtml(state.policyVersion)}</button>
    <p class="progress">${progress}</p>
    <button type="button" class="button" data-import ${state.importing ? 'disabled' : ''}>${state.importing ? 'Importing' : 'Import CSV'}</button>
    <button type="button" class="button" data-batch ${state.batching ? 'disabled' : ''}>${state.batching ? 'Generating batch…' : 'Import CSV → batch results'}</button>
    <input type="file" id="batch-file" accept=".csv,text/csv" hidden>
    <input type="file" id="file" accept=".csv,text/csv" hidden>
  </div>
  ${state.banner ? `<div class="banner" role="alert"><span>${escapeHtml(state.banner)}</span>
    <button type="button" class="link" data-dismiss>Dismiss</button></div>` : ''}`;
}

const pageTitle = () => (state.pageId === 'claims' ? 'Claims review' : 'All claims');

function renderFilters() {
  const filters = [
    ['all', 'All', state.items.length],
    ['reviewed', 'Reviewed', state.items.filter((item) => item.review).length],
    ['routed', 'Routed automatically', routedItems().length],
    ['closed', 'Closed', closedItems().length],
  ];
  return `<div class="filters" role="group" aria-label="Filter claims">${filters.map(([key, label, count]) => (
    `<button type="button" data-filter="${key}" aria-pressed="${state.filter === key}">${label} <span class="count">${count}</span></button>`
  )).join('')}</div>`;
}

function renderReviewCell(item) {
  const id = escapeHtml(item.case.case_id);
  if (!item.review) {
    const needed = item.automated.recommendation === 'human_review' || item.needs_recheck;
    if (!needed) return `<button type="button" class="link review-edit" data-toggle="${id}" aria-label="Review recommendation for ${id}">Review decision</button>`;
    return `<button type="button" class="link review-edit" data-toggle="${id}">Review decision</button>`;
  }
  const code = item.review.final_recommendation;
  return `<button type="button" class="pill review-status" data-outcome="${code}" data-toggle="${id}"
    aria-label="${outcomeName(code)} — edit review for ${id}">${outcomeName(code)}</button>`;
}

function renderRow(item) {
  const { case: record, automated } = item;
  const id = escapeHtml(record.case_id);
  const rule = automated.rules.find((rule) => rule.result === 'matched');
  const ruleText = `Policy ${automated.policy_version}, Rule ${rule.number}: ${rule.title}. ${rule.checks.filter((check) => check.state !== 'pass').map((check) => `${check.label}: ${check.test} (this claim: ${check.value})`).join('; ')}`;
  const quote = record.quote_eur === null ? NOT_PROVIDED : `€${record.quote_eur.toLocaleString('en-US')}`;
  const status = record.case_status ? humanize(record.case_status) : NOT_PROVIDED;

  return `<tr class="row" data-row="${id}">
    <td class="c-case"><button type="button" class="link case-expand" data-details="${id}" aria-expanded="${state.detailIds.has(record.case_id)}" aria-controls="case-details-${id}" aria-label="${state.detailIds.has(record.case_id) ? 'Hide' : 'Show'} details for ${id}">${svg('<path d="m6 4 4 4-4 4"/>')}<span>${id}</span></button></td>
    <td class="c-summary" title="${escapeHtml(record.claim_summary)}">${escapeHtml(record.claim_summary)}</td>
    <td class="c-quote">${quote}</td>
    <td class="c-status">${status}</td>
    <td class="c-rec"><span class="pill rule-trigger" tabindex="0" aria-describedby="rule-tooltip" data-rule="${escapeHtml(ruleText)}" data-outcome="${automated.recommendation}">${outcomeName(automated.recommendation)}</span></td>
    <td class="c-why" title="${escapeHtml(automated.explanation)}">${escapeHtml(automated.reason)}</td>
    <td class="c-review">${renderReviewCell(item)}</td>
  </tr>${renderCaseDetails(item)}`;
}

function renderCaseDetails(item) {
  const record = item.case;
  const id = escapeHtml(record.case_id);
  const fields = [
    ['case_status', 'Case status'], ['claim_type', 'Claim type'], ['repair_type', 'Repair type'],
    ['quote_eur', 'Repair quote'], ['policy_active_on_incident', 'Policy active on incident date'],
    ['incident_report_present', 'Incident report present'], ['itemized_quote_present', 'Itemized quote present'],
    ['injury_reported', 'Injury reported'], ['liability_disputed', 'Liability disputed'],
    ['duplicate_flag', 'Duplicate flag'], ['evidence_conflict', 'Evidence conflict'],
  ];
  return `<tr class="case-detail" id="case-details-${id}" ${state.detailIds.has(record.case_id) ? '' : 'hidden'}><td colspan="7">
    <section class="case-detail-body" aria-label="Details for ${id}">
      <h2>Case details · ${id}</h2>
      <p class="case-full-summary">${escapeHtml(record.claim_summary || NOT_PROVIDED)}</p>
      <dl class="case-facts">${fields.map(([key, label]) => {
        const value = record[key];
        const missing = value === null || value === undefined || value === '';
        const formatted = missing ? NOT_PROVIDED : typeof value === 'boolean' ? (value ? 'Yes' : 'No')
          : key === 'quote_eur' ? `€${value.toLocaleString('en-US')}` : humanize(value);
        return `<div><dt>${label}</dt><dd${missing ? ' class="not-provided"' : ''}>${escapeHtml(formatted)}</dd></div>`;
      }).join('')}</dl>
      <p class="notice"><strong>Recommendation:</strong> ${escapeHtml(item.automated.explanation)} · Policy ${escapeHtml(item.automated.policy_version)}</p>
      <button type="button" class="button" data-toggle="${id}">Review decision</button>
    </section>
  </td></tr>`;
}

const formatTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const reasonLabel = (code) => state.reasons.find((reason) => reason.code === code)?.label;

function renderReviewPopup(item) {
  return `<section class="review-popup" popover="auto" role="dialog" aria-labelledby="review-title">
    <header class="popup-head"><div><h2 id="review-title">Review ${escapeHtml(item.case.case_id)}</h2>
      <p class="notice">${escapeHtml(item.case.claim_summary)}</p></div>
      <button type="button" class="button" data-close-review aria-label="Close review">Close</button></header>
    <div class="review-original">
      <span class="review-label">System recommendation</span>
      <div><span class="pill" data-outcome="${item.automated.recommendation}">${outcomeName(item.automated.recommendation)}</span><span class="notice">Policy ${escapeHtml(item.automated.policy_version)}</span></div>
      <p class="notice">${escapeHtml(item.automated.explanation)}</p>
    </div>
    ${renderAction(item)}
    ${renderReviewHistory(item)}
  </section>`;
}

function renderReviewHistory(item) {
  if (!item.history?.length) return '';
  return `<details class="review-history"><summary>Review history · ${item.history.length}</summary>
    <ol class="history">${[...item.history].reverse().map((event) => `<li>
      <strong>${escapeHtml(event.reviewer)}</strong> · <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(formatTime(event.created_at))}</time>
      ${event.event === 'retraction' ? '<p>Review withdrawn. The earlier record is preserved.</p>' : `<p>${outcomeName(event.automated.recommendation)} ${ICONS.arrow} <strong>${outcomeName(event.final_recommendation)}</strong></p><p>${escapeHtml(reasonLabel(event.reason_code) ?? event.reason_code)}${event.note ? `: ${escapeHtml(event.note)}` : ''}</p><p class="notice">Policy ${escapeHtml(event.automated.policy_version)} · ${escapeHtml(event.automated.rule_id)}</p>`}
    </li>`).join('')}</ol></details>`;
}

function renderReviewed(item) {
  const { reviewer, created_at: createdAt, outcome, final_recommendation: code, reason_code: reasonCode, note } = item.review;
  const reason = [reasonLabel(reasonCode), note].filter(Boolean).join(': ');
  return `<p class="reviewed">
    <span class="pill" data-outcome="${code}">${outcomeName(code)}</span>
    <span>${humanize(outcome)}${reviewer ? ` by ${escapeHtml(reviewer)}` : ''}, ${escapeHtml(formatTime(createdAt))}.${reason ? ` ${escapeHtml(reason)}.` : ''}</span>
  </p>
  <div class="action-row">
    <button type="button" class="button" data-change>Change decision</button>
  </div>`;
}

function renderChangeForm(item, draft) {
  const segments = alternatives(item).map((code) => `<button type="button" class="segment" data-decision="${code}"
    data-outcome="${code}" aria-pressed="${draft.decision === code}">${outcomeName(code)}</button>`).join('');
  const reasons = reasonsFor(item, draft.decision ?? alternatives(item)[0]).map((reason) => `<button type="button" role="option" aria-selected="${draft.reason === reason.code}" data-reason="${reason.code}"><span>${escapeHtml(reason.label)}</span>${draft.reason === reason.code ? ICONS.check : ''}</button>`).join('');
  const noteRequired = state.reasons.find((reason) => reason.code === draft.reason)?.note_required;
  return `<div class="change-form">
    <div>
      <span class="review-label">Corrected recommendation</span>
      <div class="segments" role="group" aria-label="Corrected recommendation">${segments}</div>
      ${draft.decision && OUTCOMES[draft.decision].help ? `<p class="notice segment-help">${OUTCOMES[draft.decision].help}</p>` : ''}
    </div>
    <div class="review-fields">
      <div class="field reason-picker"><span id="reason-label">Reason</span>
        <button type="button" class="reason-trigger" id="reason" data-reason-menu aria-haspopup="listbox" aria-expanded="false" aria-labelledby="reason-label reason-value"><span id="reason-value">${escapeHtml(reasonLabel(draft.reason) ?? 'Choose a reason')}</span>${svg('<path d="m4 6 4 4 4-4"/>')}</button>
        <div class="reason-menu" role="listbox" aria-labelledby="reason-label" hidden>${reasons}</div>
      </div>
      <label class="field field-grow"><span>Note${noteRequired ? '' : ' (optional)'}</span>
        <textarea class="text-input" id="note" rows="2" ${noteRequired ? 'required' : ''}>${escapeHtml(draft.note)}</textarea>
      </label>
    </div>
  </div>`;
}

function renderAction(item) {
  const draft = draftFor(item);
  const saving = state.busy.has(item.case.case_id);
  const error = state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : '';
  const closed = item.case.case_status === 'closed'
    ? '<p class="notice">This claim is closed.</p>' : '';
  if (item.review && !draft.changing) return `<div class="action">${renderReviewed(item)}${closed}</div>`;

  const recommended = item.automated.recommendation;
  const disabled = saving ? 'disabled' : '';
  const showForm = draft.changing || recommended === 'human_review';
  const buttons = showForm
    ? `<button type="button" class="save" data-save ${disabled} ${!draft.decision ? 'disabled' : ''}>${saving ? 'Saving…' : (recommended === 'human_review' ? 'Save review' : 'Save correction')}</button>
       ${draft.changing ? '<button type="button" class="link" data-cancel-change>Cancel</button>' : ''}`
    : `<button type="button" class="save" data-confirm ${disabled}>${saving ? 'Saving' : decisionLabel(item, recommended)}</button>
       <button type="button" class="button" data-change>Change recommendation</button>`;
  return `<div class="action">
    ${showForm ? renderChangeForm(item, draft) : ''}
    <div class="action-row">
      <label class="field"><span>Reviewer</span>
        <input type="text" class="text-input" id="reviewer" autocomplete="name" value="${escapeHtml(state.reviewer)}">
      </label>
    </div>
    ${error}${closed}
    <div class="review-footer">${buttons}</div>
  </div>`;
}

function decisionLabel(item, code) {
  const recommended = item.automated.recommendation;
  if (code === recommended) return `Confirm ${lowerFirst(outcomeName(code))}`;
  if (recommended === 'human_review') return OUTCOMES[code].action.slice(0, -1);
  return `Change to ${lowerFirst(outcomeName(code))}`;
}

function renderTable() {
  const items = visibleItems();
  if (!state.items.length) {
    return `<div class="state"><strong>No claims yet</strong>Import a CSV to start reviewing.<br>
      <button type="button" class="button" data-import>Import CSV</button></div>`;
  }
  if (!items.length && state.pageId === 'claims') {
    return `<div class="state"><strong>Nothing to review</strong>
      <button type="button" class="button" data-page="all">See all claims</button></div>`;
  }
  if (!items.length) {
    const message = {
      reviewed: 'Nothing reviewed yet.',
      routed: 'No claims were routed automatically.',
      closed: 'No closed claims.',
    }[state.filter];
    return `<div class="state"><strong>${message}</strong></div>`;
  }
  return `<table class="claims">
    <thead><tr>
      <th scope="col" class="c-case">Case</th>
      <th scope="col" class="c-summary">Claim</th>
      <th scope="col" class="c-quote">Quote</th>
      <th scope="col" class="c-status">Status</th>
      <th scope="col" class="c-rec">Recommendation</th>
      <th scope="col" class="c-why">Why</th>
      <th scope="col" class="c-review">Review</th>
    </tr></thead>
    <tbody>${items.map(renderRow).join('')}</tbody>
  </table>`;
}

function renderClaims() {
  if (state.status === 'loading') {
    dom.page.innerHTML = `<div class="page-head"><h1>${pageTitle()}</h1></div>
      <div aria-label="Loading claims">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
    return;
  }
  if (state.status === 'failed') {
    dom.page.innerHTML = `<div class="page-head"><h1>${pageTitle()}</h1></div>
      <div class="state"><strong>Claims could not be loaded</strong>Check that the server is running with npm start, then try again.<br>
      <button type="button" class="button" data-retry>Try again</button></div>`;
    return;
  }
  const focusId = document.activeElement?.id;
  const focusedDecision = document.activeElement?.dataset.decision;
  const rows = visibleItems().length;
  const all = state.pageId === 'all';
  dom.page.innerHTML = renderHead() + (all && state.items.length ? renderBento() : '')
    + `<section class="card table-card">${all ? renderFilters() : ''}${renderTable()}</section>`
    + '<aside id="rule-tooltip" class="rule-tooltip" popover="manual" role="tooltip"></aside>'
    + (state.expandedId ? renderReviewPopup(findItem(state.expandedId)) : '');
  const popup = dom.page.querySelector('.review-popup');
  if (popup) {
    popup.showPopover();
    positionReviewPopup();
    popup.addEventListener('toggle', (event) => {
      if (event.newState === 'closed' && popup.isConnected && state.expandedId) closeReview();
    });
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    else if (focusedDecision) popup.querySelector(`[data-decision="${focusedDecision}"]`)?.focus({ preventScroll: true });
  }
}

/* Policies page */

const formatDate = (iso) => new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
const nextVersion = () => `v${state.policyData.policies.length + 1}`;
const currentPolicy = () => state.policyData.policies.find(
  (policy) => policy.version === state.policyData.current_version,
);

// The quote check keeps its identity when its limit changes.
const isQuote = (item) => item.field === 'quote_eur';
const choiceId = (item) => [item.field, item.op, isQuote(item) ? '' : item.value].join('|');

function ruleStep(outcome, body) {
  return `<li class="rule" data-result="matched" data-outcome="${outcome}">
    <span class="rule-node"></span>
    <h3 class="rule-title">${RULE_HEADINGS[outcome]}</h3>
    ${body}
  </li>`;
}

function renderPolicyNotes() {
  return `<details class="policy-notes">
    <summary>How every policy works</summary>
    <p>Rules apply in order. A known reason for human review takes priority over a missing document.</p>
    <p>Routine processing means the case may enter the insurer's normal downstream process.</p>
    <p>If an input field is absent or unreadable, no value is invented. Information is requested unless another known fact already requires human review.</p>
    <p>Case status is open or closed: open claims are still in process, closed claims have been completed. Claim type identifies the kind of claim. Repair type distinguishes standard repair from EV high-voltage battery work. Quote is the itemized repair estimate in euros. The remaining yes/no fields indicate whether evidence is present or a review trigger is known.</p>
  </details>`;
}

function renderPolicyDoc(policy) {
  const isCurrent = policy.version === state.policyData.current_version;
  const since = policy.activated_at ? `Activated ${formatDate(policy.activated_at)}` : 'Original policy';
  const steps = policy.rules.map((rule) => ruleStep(rule.outcome, rule.when_any.length
    ? `<ul class="conditions">${rule.when_any.map((item) => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul>`
    : ''));
  return `<section class="policy-main" aria-label="Policy ${escapeHtml(policy.version)}">
    <h2 class="policy-title">Policy ${escapeHtml(policy.version)}</h2>
    <p class="notice">${isCurrent ? '<strong>Current.</strong> ' : '<strong>Historic.</strong> '}${since}.</p>
    <ol class="path">${steps.join('')}</ol>
    ${renderPolicyNotes()}
  </section>`;
}

function renderVersions() {
  const { policies, current_version: current } = state.policyData;
  return `<aside class="policy-side" aria-labelledby="versions-title">
    <h2 class="field-label" id="versions-title">Versions</h2>
    <div class="versions">${policies.map((policy) => `<button type="button" class="version"
      data-policy-action="select" data-version="${escapeHtml(policy.version)}" aria-pressed="${policy.version === state.openPolicy}">
      <span class="version-name">${escapeHtml(policy.version)}${policy.version === current ? ' <span class="version-tag">Current</span>' : ''}</span>
      <span class="option-help">${escapeHtml(policy.change_note)}</span>
    </button>`).join('')}</div>
  </aside>`;
}

function renderChoice(outcome, choice, checked) {
  const box = `<input type="checkbox" data-choice="${escapeHtml(choiceId(choice))}" data-rule-outcome="${outcome}" ${checked ? 'checked' : ''}`;
  if (isQuote(choice)) {
    return `<div class="choice">${box} id="quote-check" aria-label="Use a quote limit">
      <label for="quote-check">Quote is over</label>
      <span class="money">€<input type="number" id="quote-limit" min="0" step="any" aria-label="Quote limit in euros"
        value="${escapeHtml(choice.value)}" ${checked ? '' : 'disabled'}></span>
    </div>`;
  }
  const text = choice.text ?? `${choice.field} ${choice.op} ${choice.value}`;
  return `<label class="choice">${box}><span>${escapeHtml(text)}</span></label>`;
}

function renderDraftForm() {
  const steps = state.policyForm.rules.map((rule) => {
    const choices = state.policyChoices[rule.outcome];
    if (!choices) return ruleStep(rule.outcome, '');
    const on = new Set(rule.when_any.map(choiceId));
    return ruleStep(rule.outcome, `<div class="choices">${choices
      .map((choice) => renderChoice(rule.outcome, choice, on.has(choiceId(choice)))).join('')}</div>`);
  });
  return `<section class="policy-main" aria-label="Rules in this draft"><ol class="path">${steps.join('')}</ol></section>`;
}

function renderDraftActions() {
  const busy = state.policyBusy ? 'disabled' : '';
  const { errors } = state.policyData.draft;
  if (state.policyConfirm === 'discard') {
    return `<p class="notice"><strong>Discard this draft?</strong> The current policy stays as it is.</p>
    <button type="button" class="button" data-policy-action="discard" ${busy}>Discard draft</button>
    <button type="button" class="link" data-policy-action="cancelConfirm">Keep draft</button>`;
  }
  return `${errors.length ? `<ul class="todo">${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
    <button type="button" class="save" data-policy-action="reviewDraft" ${errors.length ? 'disabled' : busy}>Review draft</button>
    <button type="button" class="link" data-policy-action="askDiscard">Discard draft</button>`;
}

// This part redraws on every autosave. The note stays outside it, so typing keeps focus.
function renderDraftStatus() {
  return `
    ${state.policyError ? `<p class="error" role="alert">${escapeHtml(state.policyError)}</p>` : ''}
    ${renderDraftActions()}`;
}

function refreshDraftStatus() {
  const status = document.getElementById('draft-status');
  if (status) status.innerHTML = renderDraftStatus();
}

function renderDraftPage() {
  dom.page.innerHTML = `<div class="page-head">
    <h1>Draft of ${nextVersion()}</h1>
    <p class="progress">Based on ${escapeHtml(state.policyData.current_version)}.</p>
    <button type="button" class="button" data-policy-action="back">Back to policies</button>
  </div>
  <div class="policy-grid">
    ${renderDraftForm()}
    <aside class="policy-side" aria-label="Finish this draft">
      <div>
        <label class="field-label" for="policy-note">What changed, and why?</label>
        <textarea id="policy-note" rows="3">${escapeHtml(state.policyForm.change_note)}</textarea>
      </div>
      <div class="draft-status" id="draft-status">${renderDraftStatus()}</div>
    </aside>
  </div>`;
}

function renderPolicies() {
  if (state.policyStatus === 'loading' && !state.policyData) {
    dom.page.innerHTML = `<div class="page-head"><h1>Policies</h1></div>
      <div aria-label="Loading policies">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
    return;
  }
  if (state.policyStatus === 'failed') {
    dom.page.innerHTML = `<div class="page-head"><h1>Policies</h1></div>
      <div class="state"><strong>Policies could not be loaded</strong>Check that the server is running with npm start, then try again.<br>
      <button type="button" class="button" data-policy-action="reload">Try again</button></div>`;
    return;
  }
  const { policies, draft } = state.policyData;
  if (state.policyEditing && draft) {
    renderDraftPage();
    return;
  }
  const open = policies.find((policy) => policy.version === state.openPolicy) ?? currentPolicy();
  dom.page.innerHTML = `<div class="page-head">
    <h1>Policies</h1>
    <button type="button" class="button" data-policy-action="edit" ${state.policyBusy ? 'disabled' : ''}>${draft ? 'Continue draft' : 'Edit policy'}</button>
  </div>
  ${state.policyError ? `<div class="banner" role="alert"><span>${escapeHtml(state.policyError)}</span></div>` : ''}
  <div class="policy-grid">${renderPolicyDoc(open)}${renderVersions()}</div>`;
}

/* Toast */

function hideToast() {
  clearTimeout(toastTimer);
  dom.toast.hidden = true;
}

function showToast(message) {
  clearTimeout(toastTimer);
  dom.toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  dom.toast.hidden = false;
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

/* Server calls */

async function post(path, body, contentType = 'application/json') {
  let response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  } catch {
    throw new Error('Could not reach the server. Nothing was saved. Try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'The server could not complete that. Try again.');
  return data;
}

const postJson = (path, body) => post(path, JSON.stringify(body));

function replaceItem(updated) {
  const index = state.items.findIndex((item) => item.case.case_id === updated.case.case_id);
  state.items[index] = updated;
}

// Quiet reload after a claimant call updated a claim (calls.js).
async function reloadClaims() {
  const response = await fetch('/api/cases');
  if (!response.ok) return;
  applyCases(await response.json());
  render();
}

function applyCases(data) {
  state.items = data.cases;
  state.recommendations = data.recommendations;
  state.reasons = data.reasons;
  state.policyVersion = data.policy.version;
}

// The offered checks, plus any this draft already has that are no longer offered, so
// nothing is dropped without someone unticking it.
function draftChoices(draft, choices) {
  return Object.fromEntries(Object.entries(choices).map(([outcome, offered]) => {
    const rule = draft.rules.find((candidate) => candidate.outcome === outcome);
    const saved = new Map(rule.when_any.map((item) => [choiceId(item), item]));
    const ids = new Set(offered.map(choiceId));
    const list = [
      ...offered.map((choice) => ({ ...choice, ...saved.get(choiceId(choice)) })),
      ...rule.when_any.filter((item) => !ids.has(choiceId(item))),
    ];
    // The rule shares these objects, so a new quote limit reaches what gets saved.
    rule.when_any = list.filter((choice) => saved.has(choiceId(choice)));
    return [outcome, list];
  }));
}

function applyPolicies(data) {
  state.policyData = data;
  state.policyVersion = data.current_version;
  state.policyForm = data.draft
    ? structuredClone({ change_note: data.draft.change_note, rules: data.draft.rules })
    : null;
  state.policyChoices = state.policyForm ? draftChoices(state.policyForm, data.choices) : null;
  if (!state.openPolicy) state.openPolicy = data.current_version;
}

/* Actions */

function toggleRow(id) {
  state.expandedId = state.expandedId === id ? null : id;
  state.popupPlacement = null;

  state.error = null;
  render();
}

function positionReviewPopup() {
  const popup = dom.page.querySelector('.review-popup');
  const anchor = [...dom.page.querySelectorAll('[data-toggle]')]
    .find((button) => button.dataset.toggle === state.expandedId && button.getClientRects().length);
  if (!popup || !anchor) return;
  if (state.popupPlacement?.id === state.expandedId) {
    Object.assign(popup.style, state.popupPlacement.style);
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const gap = 8;
  const margin = 12;
  const height = popup.offsetHeight;
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const placeBelow = below >= height || below >= above;
  popup.style.maxHeight = `${Math.max(120, placeBelow ? below : above)}px`;
  popup.style.left = `${Math.max(margin, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - margin))}px`;
  popup.style.top = `${placeBelow ? rect.bottom + gap : Math.max(margin, rect.top - gap - popup.offsetHeight)}px`;
  state.popupPlacement = { id: state.expandedId, style: { left: popup.style.left, top: popup.style.top, maxHeight: popup.style.maxHeight } };
}

window.addEventListener('resize', () => { state.popupPlacement = null; positionReviewPopup(); });
dom.page.addEventListener('scroll', () => { state.popupPlacement = null; positionReviewPopup(); });

function closeReview() {
  const id = state.expandedId;
  state.expandedId = null;
  state.error = null;
  render();
  [...dom.page.querySelectorAll('[data-toggle]')].find((button) => button.dataset.toggle === id)?.focus();
}

function setFilter(filter) {
  state.filter = filter;
  state.expandedId = null;
  state.error = null;
  render();
}

function updateReviewEditor() {
  const popup = dom.page.querySelector('.review-popup');
  if (!popup) return;
  const focusId = document.activeElement?.id;
  const focusedDecision = document.activeElement?.dataset.decision;
  const scrollTop = popup.scrollTop;
  popup.querySelector('.action').outerHTML = renderAction(findItem(state.expandedId));
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  else if (focusedDecision) popup.querySelector(`[data-decision="${focusedDecision}"]`)?.focus({ preventScroll: true });
  popup.scrollTop = scrollTop;
}

function setDecision(code) {
  const item = findItem(state.expandedId);
  const draft = draftFor(item);
  draft.decision = code;
  if (!reasonsFor(item, code).some((reason) => reason.code === draft.reason)) {
    draft.reason = preselectedReason(item, code);
  }
  state.error = null;
  updateReviewEditor();
}

function setReason(code) {
  draftFor(findItem(state.expandedId)).reason = code;
  state.error = null;
  updateReviewEditor();
  document.getElementById('reason').focus({ preventScroll: true });
}

function setChanging(changing) {
  draftFor(findItem(state.expandedId)).changing = changing;
  state.error = null;
  updateReviewEditor();
}

async function submitReview(item, decision, reason, note) {
  const id = item.case.case_id;
  state.busy.add(id);
  render();
  try {
    const updated = await postJson('/api/reviews', {
      case_id: id, reviewer: state.reviewer, final_recommendation: decision, reason_code: reason, note,
    });
    replaceItem(updated);
    state.drafts.delete(id);
    return updated;
  } finally {
    state.busy.delete(id);
  }
}

async function save(item, decision, reason, note) {
  try {
    await submitReview(item, decision, reason, note);
    state.expandedId = null;
    state.error = null;
    render();
    const recommended = item.automated.recommendation;
    const verb = { [recommended]: 'confirmed as' }[decision] ?? (recommended === 'human_review' ? 'moved to' : 'changed to');
    showToast(`${item.case.case_id} ${verb} ${lowerFirst(outcomeName(decision))}`);
  } catch (error) {
    state.error = error.message;
    render();
    if (!state.reviewer.trim()) document.getElementById('reviewer').focus();
  }
}

// Confirming takes one click, and records the usual reason for agreeing.
function confirmRecommendation() {
  const item = findItem(state.expandedId);
  const code = item.automated.recommendation;
  save(item, code, preselectedReason(item, code), '');
}

function saveChange() {
  const item = findItem(state.expandedId);
  const draft = draftFor(item);
  if (!draft.decision) {
    state.error = 'Choose a next step.';
    render();
    return;
  }
  save(item, draft.decision, draft.reason, draft.note);
}

function importSummary({ added, updated, unchanged, needs_review_again: again, emailed }) {
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (emailed) parts.push(`${plural(emailed, 'claimant')} emailed for missing information`);
  const text = `Import finished: ${parts.join(', ')}`;
  return again ? `${text}. ${plural(again, 'case')} need review again.` : `${text}.`;
}

async function importFile(file) {
  state.importing = true;
  state.banner = null;
  render();
  try {
    const data = await post('/api/import', await file.text(), 'text/csv');
    applyCases(data);
    state.expandedId = null;
    showToast(`${importSummary(data.summary)} ${plural(reviewItems().length, 'case')} in review.`);
  } catch (error) {
    state.banner = `${file.name} was not imported. ${error.message}`;
  }
  state.importing = false;
  render();
}

async function batchFile(file) {
  state.batching = true;
  state.banner = null;
  render();
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is too large. The limit is 5 MB.');
    const response = await fetch('/api/batch', {
      method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text(),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? 'Could not generate batch results. Try again.');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `${file.name.replace(/\.csv$/i, '')}-results.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast('Batch results downloaded. Evaluated under v1 and v2.');
  } catch (error) {
    state.banner = `${file.name}: ${error.message}`;
  } finally {
    state.batching = false;
    render();
  }
}

function saveDraftNow() {
  clearTimeout(draftTimer);
  draftTimer = null;
  draftSaves = draftSaves.then(async () => {
    try {
      state.policyData = await postJson('/api/policies/draft', state.policyForm);
      state.policyError = null;
    } catch (error) {
      state.policyError = error.message;
    }
    refreshDraftStatus();
  });
  return draftSaves;
}

function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, DRAFT_SAVE_DELAY_MS);
  if (state.policyConfirm) {
    state.policyConfirm = null;
    refreshDraftStatus();
  }
}

// Waits until the server has everything on screen.
const flushDraft = () => (draftTimer ? saveDraftNow() : draftSaves);

async function loadPolicies() {
  state.policyStatus = 'loading';
  render();
  try {
    await flushDraft();
    const response = await fetch('/api/policies');
    if (!response.ok) throw new Error('Load failed');
    applyPolicies(await response.json());
    state.policyStatus = 'ready';
  } catch {
    state.policyStatus = 'failed';
  }
  render();
}

function goToPage(id) {
  if (state.pageId === 'labels' && id !== 'labels' && labelsUI.dirty() && !confirm('Discard unsaved expected answers?')) return;
  state.pageId = id;
  renderNav();
  if (id === 'policies') loadPolicies();
  else if (id === 'measurement') measurementUI.load();
  else if (id === 'validation') validationUI.load();
  else if (id === 'labels') labelsUI.load();
  else render();
}

async function policyRequest(path) {
  state.policyBusy = true;
  state.policyError = null;
  render();
  try {
    const data = await postJson(path, {});
    applyPolicies(data);
    return data;
  } catch (error) {
    state.policyError = error.message;
    return null;
  } finally {
    state.policyBusy = false;
    render();
  }
}

const policyActions = {
  reload: loadPolicies,
  select: ({ version }) => { state.openPolicy = version; render(); },
  edit: async () => {
    if (state.policyData.draft || await policyRequest('/api/policies/draft/start')) state.policyEditing = true;
    render();
  },
  back: async () => {
    await flushDraft();
    state.policyEditing = false;
    state.policyConfirm = null;
    render();
  },
  reviewDraft: async () => { await flushDraft(); if (!state.policyError) { state.pageId = 'validation'; renderNav(); validationUI.load(true); } },
  askDiscard: () => { state.policyConfirm = 'discard'; refreshDraftStatus(); },
  cancelConfirm: () => { state.policyConfirm = null; refreshDraftStatus(); },
  discard: async () => {
    clearTimeout(draftTimer);
    draftTimer = null;
    await draftSaves;
    state.policyConfirm = null;
    if (!await policyRequest('/api/policies/draft/discard')) return;
    state.policyEditing = false;
    render();
    showToast('Draft discarded');
  },
};

function toggleChoice(target) {
  const { choice: id, ruleOutcome } = target.dataset;
  const rule = state.policyForm.rules.find((candidate) => candidate.outcome === ruleOutcome);
  const on = new Set(rule.when_any.map(choiceId));
  if (target.checked) on.add(id);
  else on.delete(id);
  rule.when_any = state.policyChoices[ruleOutcome].filter((choice) => on.has(choiceId(choice)));
  if (target.id === 'quote-check') document.getElementById('quote-limit').disabled = !target.checked;
  scheduleDraftSave();
}

function setQuoteLimit(target) {
  const quote = state.policyChoices.human_review.find(isQuote);
  quote.value = target.value === '' ? null : Number(target.value);
  scheduleDraftSave();
}

function hideRuleTooltip() {
  const tooltip = document.getElementById('rule-tooltip');
  if (tooltip?.matches(':popover-open')) tooltip.hidePopover();
}

function showRuleTooltip(trigger) {
  const tooltip = document.getElementById('rule-tooltip');
  if (!tooltip) return;
  tooltip.textContent = trigger.dataset.rule;
  if (!tooltip.matches(':popover-open')) tooltip.showPopover();
  const rect = trigger.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 12))}px`;
  tooltip.style.top = `${rect.bottom + 8 + tooltip.offsetHeight <= window.innerHeight - 12
    ? rect.bottom + 8 : Math.max(12, rect.top - tooltip.offsetHeight - 8)}px`;
}

dom.page.addEventListener('pointerover', (event) => {
  const trigger = event.target.closest('.rule-trigger');
  if (trigger) showRuleTooltip(trigger);
});
dom.page.addEventListener('pointerout', (event) => {
  if (!event.target.closest('.rule-trigger, .rule-tooltip')) return;
  if (event.relatedTarget?.closest?.('.rule-trigger, .rule-tooltip')) return;
  hideRuleTooltip();
});
dom.page.addEventListener('focusin', (event) => {
  const trigger = event.target.closest('.rule-trigger');
  if (trigger) showRuleTooltip(trigger);
});
dom.page.addEventListener('focusout', (event) => {
  if (event.target.closest('.rule-trigger')) hideRuleTooltip();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideRuleTooltip(); });
window.addEventListener('resize', hideRuleTooltip);
dom.page.addEventListener('scroll', hideRuleTooltip);

function closeReasonMenu(focus = false) {
  const picker = dom.page.querySelector('.reason-picker');
  if (!picker) return;
  picker.querySelector('.reason-menu').hidden = true;
  picker.querySelector('#reason').setAttribute('aria-expanded', 'false');
  if (focus) picker.querySelector('#reason').focus({ preventScroll: true });
}

function toggleReasonMenu() {
  const picker = dom.page.querySelector('.reason-picker');
  const menu = picker.querySelector('.reason-menu');
  if (!menu.hidden) { closeReasonMenu(true); return; }
  menu.hidden = false;
  picker.querySelector('#reason').setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-selected="true"]') ?? menu.querySelector('button')).focus({ preventScroll: true });
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.reason-picker')) closeReasonMenu();
});
document.addEventListener('keydown', (event) => {
  const picker = event.target.closest('.reason-picker');
  if (!picker) return;
  const menu = picker.querySelector('.reason-menu');
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault(); event.stopPropagation(); closeReasonMenu(true); return;
  }
  if (event.key === 'Tab') { closeReasonMenu(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (menu.hidden) { toggleReasonMenu(); return; }
  const options = [...menu.querySelectorAll('button')];
  const index = options.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[next].focus({ preventScroll: true });
});

/* Events */

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button && 'demoReset' in button.dataset) {
    resetDemo(button);
    return;
  }
  if (button && 'tourStart' in button.dataset) {
    startTour({ goToPage, currentPage: () => state.pageId });
    return;
  }
  if (button) {
    const { page, filter, toggle, decision, policyAction } = button.dataset;
    if (policyAction) policyActions[policyAction](button.dataset);
    else if (page) {
      if (filter) state.filter = filter;
      goToPage(page);
      if (state.pageId === page) {
        const target = document.getElementById(button.dataset.helpSection ? `help-${button.dataset.helpSection}` : 'page');
        if (button.dataset.helpSection) target?.scrollIntoView({ block: 'start' });
        else dom.page.scrollTop = 0;
      }
    }
    else if (filter) setFilter(filter);
    else if ('details' in button.dataset) {
      const id = button.dataset.details;
      if (state.detailIds.has(id)) state.detailIds.delete(id);
      else state.detailIds.add(id);
      const expanded = state.detailIds.has(id);
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} details for ${id}`);
      document.getElementById(`case-details-${id}`).hidden = !expanded;
    }
    else if (toggle) toggleRow(toggle);
    else if ('reasonMenu' in button.dataset) toggleReasonMenu();
    else if (button.dataset.reason) setReason(button.dataset.reason);
    else if (decision) setDecision(decision);
    else if ('closeReview' in button.dataset) closeReview();
    else if ('confirm' in button.dataset) confirmRecommendation();
    else if ('change' in button.dataset) setChanging(true);
    else if ('cancelChange' in button.dataset) setChanging(false);
    else if ('save' in button.dataset) saveChange();
    else if ('batch' in button.dataset) document.getElementById('batch-file').click();
    else if ('import' in button.dataset) document.getElementById('file').click();
    else if ('dismiss' in button.dataset) { state.banner = null; render(); }
    else if ('retry' in button.dataset) start();
    return;
  }

});

dom.page.addEventListener('change', (event) => {
  if (event.target.dataset.choice) { toggleChoice(event.target); return; }
  if (event.target.id === 'reason') { setReason(event.target.value); return; }
  if (event.target.id === 'batch-file') {
    const [file] = event.target.files;
    if (file) batchFile(file);
    return;
  }
  if (event.target.id !== 'file') return;
  const [file] = event.target.files;
  if (file) importFile(file);
});

dom.page.addEventListener('input', (event) => {
  if (event.target.id === 'quote-limit') { setQuoteLimit(event.target); return; }
  if (event.target.id === 'policy-note') {
    state.policyForm.change_note = event.target.value;
    scheduleDraftSave();
    return;
  }
  if (event.target.id === 'reviewer') { state.reviewer = event.target.value; return; }
  if (event.target.id !== 'note') return;
  draftFor(findItem(state.expandedId)).note = event.target.value;
});

/* Start */

// Only the demo copy on Cloudflare answers with space 'demo'; elsewhere the button stays hidden.
async function showDemoReset() {
  try {
    const { space } = await (await fetch('/api/space')).json();
    document.querySelector('[data-demo-reset]').hidden = space !== 'demo';
  } catch { /* not on Cloudflare */ }
}

async function resetDemo(button) {
  if (!confirm('Reset the demo copy? Every call, email, review and policy change made here is removed.')) return;
  button.disabled = true;
  const response = await fetch('/api/demo/reset', { method: 'POST' });
  if (response.ok) location.reload();
  else button.disabled = false;
}

async function start() {
  showDemoReset();
  state.status = 'loading';
  render();
  try {
    const response = await fetch('/api/cases');
    if (!response.ok) throw new Error('Load failed');
    applyCases(await response.json());
    state.status = 'ready';
  } catch {
    state.status = 'failed';
  }
  render();
}

const measurementUI = createMeasurementUI({ root: dom.page, active: () => state.pageId === 'measurement', request: postJson });

const validationUI = createValidationUI({
  root: dom.page, active: () => state.pageId === 'validation', request: postJson, flush: flushDraft,
  onActivated: (data) => { state.openPolicy = data.current_version; applyPolicies(data); state.policyEditing = false; showToast(`${data.current_version} activated. Affected open claims are ready for review.`); },
  onClaims: () => { state.pageId = 'claims'; start(); },
  onPolicies: () => { state.policyEditing = true; goToPage('policies'); },
  onLabels: (policy) => { state.pageId = 'labels'; renderNav(); labelsUI.load(policy); },
});

const labelsUI = createLabelsUI({
  root: dom.page, active: () => state.pageId === 'labels', request: postJson, flush: flushDraft,
  onValidation: (policy) => { state.pageId = 'validation'; renderNav(); validationUI.load(false, policy); },
});
window.addEventListener('beforeunload', (event) => { if (labelsUI.dirty()) event.preventDefault(); });

start();


// Help's reset action is explicit about replacing the current workspace.
dom.page.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-prepare-demo]');
  if (!button) return;
  if (!confirm('Prepare for demo? Replace this workspace’s claims and history with the original practice cases, policies v1/v2 and fresh validation results.')) return;
  const status = dom.page.querySelector('[data-demo-status]');
  button.disabled = true;
  status.textContent = 'Preparing demo…';
  try {
    const response = await fetch('/api/demo/prepare', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Demo preparation failed.');
    location.reload();
  } catch (error) {
    status.textContent = `${error.message} Please try again.`;
    button.disabled = false;
  }
});
