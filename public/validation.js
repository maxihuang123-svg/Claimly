const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { routine_processing: 'Routine processing', request_information: 'Request information', human_review: 'Human review' };
const pill = (code) => `<span class="pill" data-outcome="${esc(code)}">${names[code] ?? 'Not provided'}</span>`;
const time = (value) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>';
const versionName = (version) => version === 'draft' ? 'Draft' : `Policy ${version}`;

export function createValidationUI({ root, active, request, flush, onActivated, onClaims, onPolicies, onLabels }) {
  const state = { data: null, baseline: null, candidate: null, busy: false, error: null, reviewer: '', filter: 'changed', transition: null, expanded: null };
  let generation = 0;
  const options = (selected, draft) => `${draft ? `<option value="draft" ${selected === 'draft' ? 'selected' : ''}>Draft</option>` : ''}${state.data.policies.map((p) => `<option value="${p.version}" ${selected === p.version ? 'selected' : ''}>Policy ${p.version}${p.version === state.data.current_version ? ' · Current' : ''}</option>`).join('')}`;
  const field = (id, label, body) => `<label class="field"><span>${label}</span><select class="text-input" id="${id}" ${state.busy ? 'disabled' : ''}>${body}</select></label>`;
  function render() {
    if (!active()) return;
    const { data, busy } = state;
    if (!data) {
      root.innerHTML = `<div class="page-head"><h1>Validation</h1></div><div class="state" role="status">${state.error ? `${esc(state.error)}<br><button class="button" data-validation="reload">Try again</button>` : 'Loading policies and claims…'}</div>`;
      return;
    }
    const { preview, run, stale } = data;
    root.innerHTML = `<div class="validation-page">
      <header class="validation-heading"><div><h1>Validation</h1><p>See what changes when your policy does.</p></div><span class="comparison-mode">${state.candidate === 'draft' ? 'Draft comparison' : 'Historical comparison'}</span></header>
      <section class="comparison-panel" aria-label="Choose policies to compare"><div class="validation-controls">
        ${field('validation-baseline', 'From', options(state.baseline, false))}
        <span class="comparison-arrow">${arrow}</span>
        ${field('validation-candidate', 'To', options(state.candidate, !!data.draft))}
        <button class="save" data-validation="run" ${busy ? 'disabled' : ''}>${busy ? 'Comparing…' : run ? 'Run again' : 'Compare policies'}</button>
      </div><div class="comparison-scope"><span>${preview.total} imported claims · same facts, two policies</span>${state.candidate === 'draft' ? '<button class="link" data-validation="edit">Edit draft</button>' : '<span>Simulation only</span>'}</div></section>
      ${state.error ? `<p class="validation-alert error" role="alert">${esc(state.error)}</p>` : ''}
      <section class="policy-change-note"><h2>Policy change</h2><div>${preview.changes.length ? `<ul class="rule-differences">${preview.changes.map((c) => `<li><strong>${c.kind}</strong><span>${esc(c.text)}</span><span class="notice">${names[c.outcome] ?? ''}</span></li>`).join('')}</ul>` : '<p>The decision rules are identical.</p>'}</div></section>
      ${labelSetup()}
      ${run ? `${stale ? '<p class="validation-alert" role="status"><strong>This comparison is out of date.</strong> The policy, claim facts, or labels changed. Run it again before activation.</p>' : ''}${results(run)}${labelled(run)}${claims(run)}${release(run, stale)}` : `<section class="validation-empty"><span class="empty-comparison">${arrow}</span><h2>Understand the impact before you release</h2><p>Compare recommendations, see where claims move, and review the cases affected by your policy change.</p><p class="notice">Recorded decisions stay intact during comparison.</p></section>`}
    </div>`;
  }
  function results(run) {
    const { impact } = run;
    const max = Math.max(1, ...impact.outcomes.flatMap((r) => [r.before, r.after]));
    return `<section class="impact-overview"><div class="section-heading"><div><h2>${impact.changed ? `${impact.changed} of ${impact.total} claims would move to a different next step` : 'The next steps stay the same'}</h2><p class="notice">${impact.unchanged} unchanged · ${impact.open_rechecks} open claims need another look</p></div><span class="run-stamp">${esc(time(run.created_at))}</span></div>
      <div class="impact-layout"><div class="outcome-distribution"><div class="distribution-header"><h3>Recommendations</h3><span>${esc(versionName(run.baseline.version))} / ${esc(versionName(run.candidate.version))}</span><span>Change</span></div>
        ${impact.outcomes.map((r) => `<div class="distribution-row" data-outcome="${r.outcome}"><div class="distribution-label"><span class="outcome-dot"></span>${names[r.outcome]}</div><div class="bar-comparison" aria-label="${names[r.outcome]}: ${r.before} before, ${r.after} after"><div class="bar-line before"><span style="width:${r.before / max * 100}%"></span><b>${r.before}</b></div><div class="bar-line after"><span style="width:${r.after / max * 100}%"></span><b>${r.after}</b></div></div><span class="outcome-delta ${r.delta ? 'has-change' : ''}">${r.delta > 0 ? '+' : ''}${r.delta || '—'}</span></div>`).join('')}
        <p class="notice distribution-caption">Lighter bars show the baseline; solid bars show the proposed policy. All ${impact.total} claims are included, including closed-case simulations.</p>
      </div><aside class="claim-movements"><h3>Where claims move</h3>${impact.transitions.length ? impact.transitions.map((t) => `<button class="movement" data-validation="transition" data-from="${t.from}" data-to="${t.to}" aria-pressed="${state.transition?.from === t.from && state.transition?.to === t.to}"><span class="movement-path">${pill(t.from)}<span class="movement-arrow">${arrow}</span>${pill(t.to)}</span><span class="movement-count">${t.count}<small>${t.count === 1 ? 'claim' : 'claims'}</small></span></button>`).join('') : '<p class="notice movement-empty">No claims change their next step.</p>'}<p class="notice">Select a movement to inspect its claims below.</p></aside></div>
      <details class="validation-details run-details"><summary>Comparison details</summary><p>Run ${esc(run.id)}<br>${run.claims.length} imported claims · Engine ${esc(run.engine_version.slice(0, 12))}<br>Both policies were evaluated against the same saved input facts. Closed decisions and reviewer history are retained.</p></details></section>`;
  }
  function labelSetup() {
    const setup = state.data.preview.label_setup;
    if (!setup) return '';
    const status = setup.source === 'confirmed' ? 'Confirmed for these rules.' : setup.source === 'supplied' ? 'Using the supplied v1 answers.' : 'Not confirmed yet. Scoring uses v1 answers until you confirm them.';
    return `<section class="policy-change-note"><h2>Expected answers</h2><div class="label-link"><p>${setup.examples.length} labelled examples for ${esc(versionName(state.candidate))}. ${status}</p><button class="button" data-validation="labels">${setup.source === 'confirmed' ? 'Review expected answers' : 'Set expected answers'}</button></div></section>`;
  }
  function labelled(run) {
    const test = run.labelled;
    if (!test) return `<p class="notice">Run the comparison again to include labelled-example checks.</p>`;
    const reference = test.after.source === 'v1_reference';
    const sourceName = (source) => source === 'v1_reference' ? 'v1 reference labels' : source === 'supplied' ? 'supplied v1 labels' : 'confirmed policy labels';
    const examples = [...test.examples].sort((a, b) => Number(b.after.incorrect_routine) - Number(a.after.incorrect_routine) || Number(a.after.correct) - Number(b.after.correct));
    const cell = (r) => `${pill(r.actual.recommendation)}<span class="cell-note">Expected: ${esc(names[r.expected])}</span><span class="labelled-status ${r.incorrect_routine ? 'routine-miss' : ''}">${r.correct ? 'Matches' : r.incorrect_routine ? 'Incorrect routine recommendation' : 'Does not match'}</span>`;
    return `<details class="labelled-checks"><summary><span>Labelled examples</span><span class="labelled-summary">Before ${test.before.correct}/${test.before.total} · After ${test.after.correct}/${test.after.total} match${test.after.incorrect_routine ? ` · ${test.after.incorrect_routine} routine ${reference ? (test.after.incorrect_routine === 1 ? 'mismatch' : 'mismatches') : (test.after.incorrect_routine === 1 ? 'error' : 'errors')}` : ''}</span></summary>
      <div class="labelled-body"><p class="notice">The ${test.examples.length} development examples are tested with both policies. Before: ${sourceName(test.before.source)}. After: ${sourceName(test.after.source)}.</p>
      ${reference ? '<p class="labelled-reference">The proposed policy is compared with v1 answers. Differences may be intentional. Confirm them on the Expected answers page.</p>' : ''}
      <p class="notice">${test.before.wrong} mismatches before · ${test.after.wrong} after. Incorrect routine recommendations: ${test.before.incorrect_routine} before · ${test.after.incorrect_routine} after${reference ? ' (against v1 reference)' : ''}. Unnecessary human escalations: ${test.before.unnecessary_human ?? '—'} before · ${test.after.unnecessary_human ?? '—'} after.</p>
      <div class="validation-table-wrap"><table class="validation-table labelled-table"><thead><tr><th>Example / facts</th><th>${esc(versionName(run.baseline.version))}</th><th>${esc(versionName(run.candidate.version))}</th></tr></thead><tbody>${examples.map((e) => `<tr><td><details class="validation-details"><summary>${esc(e.case.case_id)}</summary><p>${esc(e.case.claim_summary)}</p>${facts(e.case)}<p><strong>Before:</strong> ${esc(e.before.actual.explanation)}</p><p><strong>After:</strong> ${esc(e.after.actual.explanation)}</p></details></td><td>${cell(e.before)}</td><td>${cell(e.after)}</td></tr>`).join('')}</tbody></table></div>
      </div></details>`;
  }
  function facts(record) {
    return `<details class="validation-details"><summary>Input facts used by both policies</summary><dl class="validation-facts">${Object.entries(record).filter(([k]) => k !== 'claim_summary').map(([k, v]) => `<dt>${esc(k.replaceAll('_', ' '))}</dt><dd>${esc(v === null ? 'Not provided' : v)}</dd>`).join('')}</dl></details>`;
  }
  function claims(run) {
    const visible = run.claims.filter((r) => state.transition ? r.before.recommendation === state.transition.from && r.after.recommendation === state.transition.to : state.filter === 'closed' ? r.case.case_status === 'closed' : state.filter === 'all' ? true : state.filter === 'recheck' ? r.needs_recheck : state.filter === 'reason' ? !r.changed && r.reason_changed : r.changed);
    return `<section class="validation-section affected-section"><div class="section-heading"><h2>Explore the claims</h2><span class="notice">${visible.length} ${visible.length === 1 ? 'claim' : 'claims'}</span></div>
      <div class="filters" role="group" aria-label="Filter compared claims">${[['changed', 'Changed decisions'], ['recheck', 'Needs recheck'], ['reason', 'Reason only'], ['all', 'All claims'], ['closed', 'Closed']].map(([key, label]) => `<button data-validation="filter" data-filter="${key}" aria-pressed="${!state.transition && state.filter === key}">${label}</button>`).join('')}</div>
      ${state.transition ? `<div class="transition-selection">${pill(state.transition.from)}${arrow}${pill(state.transition.to)}<button class="link" data-validation="clearTransition">Clear filter</button></div>` : ''}
      <div class="validation-table-wrap"><table class="validation-table"><thead><tr><th>Claim</th><th>${esc(versionName(run.baseline.version))}</th><th>${esc(versionName(run.candidate.version))}</th><th>Reason under ${esc(versionName(run.candidate.version).toLowerCase())}</th></tr></thead><tbody>${visible.length ? visible.map((r) => `<tr><td><button class="link case-link" data-validation="case" data-case="${esc(r.case.case_id)}" aria-expanded="${state.expanded === r.case.case_id}">${esc(r.case.case_id)}</button><span class="cell-note">${r.case.case_status === 'closed' ? 'Closed · simulation' : r.needs_recheck ? 'Open · recheck' : esc(r.case.case_status ?? 'Status not provided')}</span></td><td>${pill(r.before.recommendation)}</td><td>${pill(r.after.recommendation)}</td><td class="validation-reason">${esc(r.after.reason)}</td></tr>${state.expanded === r.case.case_id ? `<tr><td colspan="4" class="claim-comparison"><p class="claim-summary">${esc(r.case.claim_summary)}</p><div class="comparison-detail">${['before', 'after'].map((side) => `<div><h3>${esc(versionName(r[side].policy_version))}</h3><p>${pill(r[side].recommendation)}</p><p class="notice">${esc(r[side].rule_id)} · ${esc(r[side].explanation)}</p></div>`).join('')}</div>${facts(r.case)}</td></tr>` : ''}`).join('') : '<tr><td colspan="4" class="empty-claims">No claims in this group. Choose another filter to explore the comparison.</td></tr>'}</tbody></table></div>
      <p class="retention-note">${run.impact.closed} closed decisions remain unchanged. ${run.impact.open_rechecks} open claims need another look under the proposed policy.</p></section>`;
  }
  function release(run, stale) {
    if (state.candidate !== 'draft') return '';
    const wrongBaseline = run.baseline.version !== state.data.current_version;
    return `<section class="validation-release"><div><h2>${stale ? 'Refresh the comparison' : wrongBaseline ? 'Compare with the active policy' : 'Ready to put this policy into use?'}</h2><p>${stale ? 'Run the comparison again to include the latest changes.' : wrongBaseline ? 'Select the current policy as your baseline before activation.' : 'Activation records your approval and flags affected open claims for review.'}</p></div><div class="release-actions"><label class="field"><span>Approved by</span><input id="validation-reviewer" class="text-input" autocomplete="name" value="${esc(state.reviewer)}" placeholder="Your name" ${state.busy ? 'disabled' : ''}></label><button class="save" data-validation="activate" ${stale || wrongBaseline || state.busy ? 'disabled' : ''}>Activate draft</button></div></section>`;
  }
  async function load(reset = false, candidate = null) {
    const seq = ++generation;
    state.error = null;
    if (reset) { state.baseline = null; state.candidate = null; state.data = null; }
    if (candidate && candidate !== state.candidate) { state.candidate = candidate; state.expanded = null; state.transition = null; }
    state.busy = true; render();
    try {
      await flush();
      const params = new URLSearchParams();
      if (state.baseline) params.set('baseline', state.baseline);
      if (state.candidate) params.set('candidate', state.candidate);
      const response = await fetch(`/api/validation?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load the comparison. Try again.');
      if (seq !== generation) return;
      state.data = data;
      state.baseline ??= data.current_version;
      state.candidate ??= data.draft ? 'draft' : data.current_version;
    } catch (error) { if (seq === generation) { state.error = error.message; state.data = null; } }
    finally { if (seq === generation) { state.busy = false; render(); } }
  }
  async function action(kind, button) {
    if (kind === 'reload') return load();
    if (state.busy) return;
    if (kind === 'edit') return onPolicies();
    if (kind === 'labels') return onLabels(state.candidate);
    if (kind === 'filter') { state.filter = button.dataset.filter; state.transition = null; state.expanded = null; render(); return; }
    if (kind === 'transition') { state.transition = { from: button.dataset.from, to: button.dataset.to }; state.expanded = null; render(); root.querySelector('.affected-section')?.scrollIntoView({ block: 'nearest' }); return; }
    if (kind === 'clearTransition') { state.transition = null; render(); return; }
    if (kind === 'case') { state.expanded = state.expanded === button.dataset.case ? null : button.dataset.case; render(); root.querySelector('.claim-comparison')?.scrollIntoView({ block: 'nearest' }); return; }
    state.busy = true; state.error = null; render();
    try {
      if (kind === 'run') {
        state.data.run = await request('/api/validation/run', { baseline: state.baseline, candidate: state.candidate });
        state.data.stale = false;
        state.data.preview.changes = state.data.run.changes;
        state.data.preview.total = state.data.run.impact.total;
      } else if (kind === 'activate') {
        const data = await request('/api/policies/draft/activate', { run_id: state.data.run.id, approver: state.reviewer });
        onActivated(data);
        state.data = null; state.baseline = null; state.candidate = null;
        onClaims();
      }
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; render(); }
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-validation]');
    if (button && active()) { event.stopPropagation(); action(button.dataset.validation, button); }
  });
  root.addEventListener('input', (event) => { if (event.target.id === 'validation-reviewer') state.reviewer = event.target.value; });
  root.addEventListener('change', (event) => {
    if (['validation-baseline', 'validation-candidate'].includes(event.target.id)) {
      state[event.target.id === 'validation-baseline' ? 'baseline' : 'candidate'] = event.target.value;
      state.data.run = null; state.expanded = null; state.transition = null;
      load();
    }
  });
  return { render, load };
}
