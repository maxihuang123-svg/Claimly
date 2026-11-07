const OUTCOMES = {
  routine_processing: { name: 'Routine processing', help: 'Enters the normal downstream process. Not a payment approval.' },
  request_information: { name: 'Request information', help: 'Ask for what is missing first.' },
  human_review: { name: 'Human review', help: 'Stays with a person.' },
};
const REPAIR_TYPES = { standard: 'Standard repair', ev_high_voltage_battery: 'EV high-voltage battery' };
const REVIEWER_KEY = 'claims-review.reviewer';
const TOAST_MS = 6000;

const svg = (body, width = 1.8) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  check: svg('<path d="M3 8.5l3.2 3.2L13 4.8"/>', 2),
  swap: svg('<path d="M2.5 8h10M9 4.5L12.5 8 9 11.5"/>', 2),
  flag: svg('<path d="M3.5 14V2.5h8.5L10 6l2 3.5H3.5"/>'),
  blank: svg('<path d="M3 8h10"/>'),
  chevron: svg('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  table: svg('<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6"/>', 1.5),
};
const STATE_LABELS = {
  pass: [ICONS.check, 'OK'],
  trigger: [ICONS.flag, 'Triggered'],
  unknown: [ICONS.blank, 'Cannot check'],
};

// Sidebar pages. To add one, add an entry here with a render function.
const PAGES = [
  { id: 'claims', label: 'Claims review', icon: ICONS.table, render: renderClaims },
];

const dom = {
  nav: document.getElementById('nav'),
  page: document.getElementById('page'),
  reviewer: document.getElementById('reviewer'),
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
  drafts: new Map(),
  busy: new Set(),
  error: null,
  banner: null,
  importing: false,
};

let toastTimer;

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

function readStoredReviewer() {
  try { return localStorage.getItem(REVIEWER_KEY) ?? ''; } catch { return ''; }
}
function storeReviewer(name) {
  try { localStorage.setItem(REVIEWER_KEY, name); } catch { /* The name just is not remembered. */ }
}

const findItem = (id) => state.items.find((item) => item.case.case_id === id);

// Only cases the automation sent to human review appear on this page.
const reviewItems = () => state.items.filter((item) => item.automated.recommendation === 'human_review');

function visibleItems() {
  const items = reviewItems();
  if (state.filter === 'todo') return items.filter((item) => !item.review);
  if (state.filter === 'done') return items.filter((item) => item.review);
  return items;
}

function draftFor(item) {
  const id = item.case.case_id;
  if (!state.drafts.has(id)) {
    state.drafts.set(id, {
      decision: item.review?.final_recommendation ?? null,
      reason: item.review?.reason_code ?? 'resolved_after_review',
      note: item.review?.note ?? '',
    });
  }
  return state.drafts.get(id);
}

const reasonsFor = (item) => state.reasons.filter(
  (reason) => !reason.only_for || reason.only_for === item.automated.recommendation,
);

/* Shell */

function renderNav() {
  dom.nav.innerHTML = PAGES.map((page) => `<li><button type="button" data-page="${page.id}"
    ${page.id === state.pageId ? 'aria-current="page"' : ''}>${page.icon}${escapeHtml(page.label)}</button></li>`).join('');
}

function render() {
  renderNav();
  PAGES.find((page) => page.id === state.pageId).render();
}

/* Claims page */

function renderHead() {
  const items = reviewItems();
  const reviewed = items.filter((item) => item.review).length;
  const changed = items.filter((item) => item.review?.outcome === 'changed').length;
  const routed = state.items.length - items.length;
  const progress = [
    items.length ? `${reviewed} of ${items.length} reviewed${changed ? `, ${changed} changed` : ''}` : '',
    routed ? `${plural(routed, 'other case')} routed automatically` : '',
  ].filter(Boolean).join('. ');
  return `<div class="page-head">
    <h1>Claims review</h1>
    <p class="progress">${progress}</p>
    <button type="button" class="button" data-import ${state.importing ? 'disabled' : ''}>${state.importing ? 'Importing' : 'Import CSV'}</button>
    <input type="file" id="file" accept=".csv,text/csv" hidden>
  </div>
  ${state.banner ? `<div class="banner" role="alert"><span>${escapeHtml(state.banner)}</span>
    <button type="button" class="link" data-dismiss>Dismiss</button></div>` : ''}`;
}

function renderFilters() {
  const items = reviewItems();
  const reviewed = items.filter((item) => item.review).length;
  const filters = [
    ['all', 'All', items.length],
    ['todo', 'To review', items.length - reviewed],
    ['done', 'Reviewed', reviewed],
  ];
  return `<div class="filters" role="group" aria-label="Filter claims">${filters.map(([key, label, count]) => (
    `<button type="button" data-filter="${key}" aria-pressed="${state.filter === key}">${label} ${count}</button>`
  )).join('')}</div>`;
}

const isQuickApproved = (review) => review.outcome === 'resolved' && review.final_recommendation === 'routine_processing';

function renderApprove(item) {
  const id = escapeHtml(item.case.case_id);
  const busy = state.busy.has(item.case.case_id) ? 'disabled' : '';
  if (item.review && !isQuickApproved(item.review)) {
    return `<button type="button" class="approve" data-state="changed" data-toggle="${id}" title="Reviewed. Open to edit."
      aria-label="${id}: reviewed, open to edit">${ICONS.swap}</button>`;
  }
  const label = item.review ? 'Sent to routine processing. Click to undo.' : 'Send to routine processing';
  return `<button type="button" class="approve" data-state="${item.review ? 'approved' : 'open'}" data-approve="${id}" title="${label}"
    aria-label="${id}: ${label}" aria-pressed="${Boolean(item.review)}" ${busy}>${ICONS.check}</button>`;
}

function renderReviewCell(item) {
  if (!item.review) return '<span class="pending">Not reviewed</span>';
  const code = item.review.final_recommendation;
  return `<span class="pill" data-outcome="${code}">${outcomeName(code)}</span>`;
}

function renderRow(item) {
  const { case: record, automated } = item;
  const id = escapeHtml(record.case_id);
  const open = state.expandedId === record.case_id;
  const quote = record.quote_eur === null
    ? '<span class="blank">Blank</span>'
    : `€${record.quote_eur.toLocaleString('en-US')}`;
  const status = record.case_status ? humanize(record.case_status) : '<span class="blank">Blank</span>';

  return `<tr class="row" data-row="${id}" data-open="${open}">
    <td class="c-case">${id}</td>
    <td class="c-summary" title="${escapeHtml(record.claim_summary)}">${escapeHtml(record.claim_summary)}</td>
    <td class="c-quote">${quote}</td>
    <td class="c-status">${status}</td>
    <td class="c-why" title="${escapeHtml(automated.explanation)}">${escapeHtml(automated.explanation)}</td>
    <td class="c-review">${renderReviewCell(item)}</td>
    <td class="c-check">${renderApprove(item)}</td>
    <td class="c-open"><button type="button" class="chevron" data-toggle="${id}" aria-expanded="${open}" aria-label="${open ? 'Close' : 'Open'} ${id}">${ICONS.chevron}</button></td>
  </tr>${open ? `<tr class="detail"><td colspan="8"><div class="detail-grid">${renderTrace(item)}${renderReview(item)}</div></td></tr>` : ''}`;
}

function ruleResultText(rule) {
  if (rule.result === 'matched') return `Matched: ${lowerFirst(outcomeName(rule.outcome))}`;
  if (rule.result === 'not_reached') return rule.would_also_match ? 'Not reached, would also match' : 'Not reached';
  const blanks = rule.checks.some((check) => check.state === 'unknown');
  if (rule.number === 1) return blanks ? 'No known trigger' : 'No trigger';
  return 'Nothing missing';
}

function renderCheck(check) {
  const [icon, label] = STATE_LABELS[check.state];
  return `<tr data-state="${check.state}">
    <td class="col-label" title="${escapeHtml(check.field)}">${escapeHtml(check.label)}</td>
    <td class="col-value">${escapeHtml(check.value)}</td>
    <td class="col-test">${escapeHtml(check.test)}</td>
    <td><span class="check-state">${icon}<span>${label}</span></span></td>
  </tr>`;
}

function renderRule(rule) {
  const table = rule.checks.length ? `<table class="checks">
    <thead><tr>
      <th scope="col" class="col-label">Check</th>
      <th scope="col" class="col-value">This claim</th>
      <th scope="col" class="col-test">Policy</th>
      <th scope="col">Result</th>
    </tr></thead>
    <tbody>${rule.checks.map(renderCheck).join('')}</tbody>
  </table>` : '';
  return `<li class="rule" data-result="${rule.result}" data-outcome="${rule.outcome}">
    <span class="rule-node"></span>
    <div class="rule-head">
      <h3 class="rule-title">Rule ${rule.number}. ${escapeHtml(rule.title)}</h3>
      <span class="rule-result">${ruleResultText(rule)}</span>
    </div>
    ${table}
  </li>`;
}

function renderTrace(item) {
  const { case: record, automated } = item;
  const decidingRule = automated.rules.find((rule) => rule.result === 'matched');
  const repair = record.repair_type ? (REPAIR_TYPES[record.repair_type] ?? humanize(record.repair_type)) : 'Repair type blank';
  const claimType = record.claim_type ? humanize(record.claim_type) : 'Claim type blank';
  return `<section class="trace" aria-label="Why this decision was made">
    <h2 class="detail-summary">${escapeHtml(record.claim_summary) || 'No summary provided'}</h2>
    <p class="detail-meta"><span>${escapeHtml(claimType)}</span><span>${escapeHtml(repair)}</span></p>
    <div class="verdict" data-outcome="${automated.recommendation}">
      <p class="verdict-line">
        <span class="verdict-outcome">${outcomeName(automated.recommendation)}</span>
        <span class="verdict-source">Automated, Rule ${decidingRule.number}, policy ${escapeHtml(automated.policy_version)}</span>
      </p>
      <p>${escapeHtml(automated.explanation)}</p>
    </div>
    <ol class="path" aria-label="How the policy was applied">${automated.rules.map(renderRule).join('')}</ol>
  </section>`;
}

function reviewNotice(item) {
  if (!item.review) return '';
  const { reviewer, created_at: createdAt, outcome } = item.review;
  const time = new Date(createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `<p class="notice"><strong>${outcome === 'changed' ? 'Changed' : 'Resolved'}</strong> by
    ${escapeHtml(reviewer)}, ${escapeHtml(time)}.
    <button type="button" class="link" data-undo="${escapeHtml(item.case.case_id)}">Undo</button></p>`;
}

function renderReview(item) {
  const draft = draftFor(item);
  const saving = state.busy.has(item.case.case_id);

  // A case already in human review has to leave it, so that option is not offered.
  const options = state.recommendations.filter((code) => code !== item.automated.recommendation).map((code) => `
    <button type="button" class="option" data-decision="${code}" data-outcome="${code}" aria-pressed="${draft.decision === code}">
      <span class="option-name">${outcomeName(code)}</span>
      <span class="option-help">${OUTCOMES[code].help}</span>
    </button>`).join('');

  const reasons = `<div role="group" aria-labelledby="reason-label">
    <span class="field-label" id="reason-label">Reason</span>
    <div class="reasons">${reasonsFor(item).map((reason) => `
      <button type="button" class="reason" data-reason="${reason.code}" aria-pressed="${draft.reason === reason.code}">${escapeHtml(reason.label)}</button>`).join('')}
    </div>
  </div>`;

  const noteRequired = state.reasons.find((reason) => reason.code === draft.reason)?.note_required;
  const saveLabel = saving ? 'Saving'
    : draft.decision ? `Send to ${lowerFirst(outcomeName(draft.decision))}` : 'Choose a next step';

  return `<section class="review" aria-label="Your review">
    <div role="group" aria-labelledby="decision-label">
      <span class="field-label" id="decision-label">Next step</span>
      <div class="options">${options}</div>
    </div>
    ${reasons}
    <div>
      <label class="field-label" for="note">Note ${noteRequired ? '' : '<span class="optional">(optional)</span>'}</label>
      <textarea id="note" rows="2" placeholder="What should the system learn from this case?">${escapeHtml(draft.note)}</textarea>
    </div>
    ${state.error ? `<p class="error" role="alert">${escapeHtml(state.error)}</p>` : ''}
    <button type="button" class="save" data-save ${saving ? 'disabled' : ''}>${saveLabel}</button>
    ${item.case.case_status === 'closed' ? '<p class="notice">This claim is closed. Your review is recorded as feedback on the decision.</p>' : ''}
    ${reviewNotice(item)}
  </section>`;
}

function renderTable() {
  const items = visibleItems();
  if (!state.items.length) {
    return `<div class="state"><strong>No claims yet</strong>Import a CSV to start reviewing.<br>
      <button type="button" class="button" data-import>Import CSV</button></div>`;
  }
  if (!reviewItems().length) {
    return '<div class="state"><strong>No cases need human review</strong>Every imported case was routed automatically.</div>';
  }
  if (!items.length) {
    const message = state.filter === 'todo' ? 'Everything has been reviewed.' : 'Nothing reviewed yet.';
    return `<div class="state"><strong>${message}</strong></div>`;
  }
  return `<table class="claims">
    <thead><tr>
      <th scope="col" class="c-case">Case</th>
      <th scope="col" class="c-summary">Claim</th>
      <th scope="col" class="c-quote">Quote</th>
      <th scope="col" class="c-status">Status</th>
      <th scope="col" class="c-why">Why</th>
      <th scope="col" class="c-review">Review</th>
      <th scope="col" class="c-check"><span hidden>Send to routine processing</span></th>
      <th scope="col" class="c-open"><span hidden>Open</span></th>
    </tr></thead>
    <tbody>${items.map(renderRow).join('')}</tbody>
  </table>`;
}

function renderClaims() {
  if (state.status === 'loading') {
    dom.page.innerHTML = `<div class="page-head"><h1>Claims review</h1></div>
      <div aria-label="Loading claims">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
    return;
  }
  if (state.status === 'failed') {
    dom.page.innerHTML = `<div class="page-head"><h1>Claims review</h1></div>
      <div class="state"><strong>Claims could not be loaded</strong>Check that the server is running with npm start, then try again.<br>
      <button type="button" class="button" data-retry>Try again</button></div>`;
    return;
  }
  dom.page.innerHTML = renderHead() + renderFilters() + renderTable();
}

/* Toast */

function hideToast() {
  clearTimeout(toastTimer);
  dom.toast.hidden = true;
}

function showToast(message, undoCaseId) {
  clearTimeout(toastTimer);
  dom.toast.innerHTML = `<span>${escapeHtml(message)}</span>`
    + (undoCaseId ? `<button type="button" class="link" data-undo="${escapeHtml(undoCaseId)}">Undo</button>` : '');
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

function applyCases(data) {
  state.items = data.cases;
  state.recommendations = data.recommendations;
  state.reasons = data.reasons;
}

/* Actions */

function requireReviewer() {
  const name = dom.reviewer.value.trim();
  if (name) return name;
  dom.reviewer.setAttribute('aria-invalid', 'true');
  dom.reviewer.focus();
  return null;
}

function toggleRow(id) {
  state.expandedId = state.expandedId === id ? null : id;
  state.error = null;
  render();
}

function setFilter(filter) {
  state.filter = filter;
  state.expandedId = null;
  state.error = null;
  render();
}

function setDecision(code) {
  draftFor(findItem(state.expandedId)).decision = code;
  state.error = null;
  render();
}

function setReason(code) {
  draftFor(findItem(state.expandedId)).reason = code;
  state.error = null;
  render();
}

async function submitReview(item, decision, reason, note) {
  const id = item.case.case_id;
  const reviewer = requireReviewer();
  if (!reviewer) throw new Error('Enter your name in the sidebar first.');
  state.busy.add(id);
  render();
  try {
    const updated = await postJson('/api/reviews', {
      case_id: id, reviewer, final_recommendation: decision, reason_code: reason, note,
    });
    replaceItem(updated);
    state.drafts.delete(id);
    return updated;
  } finally {
    state.busy.delete(id);
  }
}

async function approve(id) {
  const item = findItem(id);
  try {
    await submitReview(item, 'routine_processing', 'resolved_after_review', '');
    if (state.expandedId === id) state.expandedId = null;
    render();
    showToast(`${id} sent to routine processing`, id);
  } catch (error) {
    render();
    showToast(error.message);
  }
}

async function save() {
  const item = findItem(state.expandedId);
  const draft = draftFor(item);
  if (!draft.decision) {
    state.error = 'Choose a next step.';
    render();
    return;
  }
  try {
    await submitReview(item, draft.decision, draft.reason, draft.note);
    state.expandedId = null;
    state.error = null;
    render();
    showToast(`${item.case.case_id} sent to ${lowerFirst(outcomeName(draft.decision))}`, item.case.case_id);
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function undo(id) {
  hideToast();
  try {
    replaceItem(await postJson('/api/reviews/undo', { case_id: id, reviewer: dom.reviewer.value.trim() }));
    state.drafts.delete(id);
    render();
    showToast(`${id} undone`);
  } catch (error) {
    showToast(error.message);
  }
}

function importSummary({ added, updated, unchanged, needs_review_again: again }) {
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
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

/* Events */

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button) {
    const { page, filter, toggle, approve: approveId, decision, reason, undo: undoId } = button.dataset;
    if (page) { state.pageId = page; render(); }
    else if (filter) setFilter(filter);
    else if (toggle) toggleRow(toggle);
    else if (approveId) {
      if (findItem(approveId).review) undo(approveId);
      else approve(approveId);
    }
    else if (decision) setDecision(decision);
    else if (reason) setReason(reason);
    else if (undoId) undo(undoId);
    else if ('save' in button.dataset) save();
    else if ('import' in button.dataset) document.getElementById('file').click();
    else if ('dismiss' in button.dataset) { state.banner = null; render(); }
    else if ('retry' in button.dataset) start();
    return;
  }
  const row = event.target.closest('.row');
  if (row && !String(getSelection())) toggleRow(row.dataset.row);
});

dom.page.addEventListener('change', (event) => {
  if (event.target.id !== 'file') return;
  const [file] = event.target.files;
  if (file) importFile(file);
});

dom.page.addEventListener('input', (event) => {
  if (event.target.id !== 'note') return;
  draftFor(findItem(state.expandedId)).note = event.target.value;
});

dom.reviewer.addEventListener('input', () => {
  dom.reviewer.removeAttribute('aria-invalid');
  storeReviewer(dom.reviewer.value.trim());
});

/* Start */

async function start() {
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

dom.reviewer.value = readStoredReviewer();
start();
