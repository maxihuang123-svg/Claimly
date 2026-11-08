import { pageHint } from './help.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { routine_processing: 'Routine processing', request_information: 'Request information', human_review: 'Human review' };
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'Not measured';
const metric = r => `<strong>${r.rate === null ? '—' : `${(r.rate * 100).toFixed(1)}%`}</strong><span>${r.count} / ${r.total}</span>`;
const when = v => new Date(v).toLocaleString();
const human = s => s.replaceAll('_', ' ');
const plan = [
  ['Daily · Operations lead', 'Check intake, missing facts and review coverage', 'Review every flagged conflict and every open policy recheck. Each week, randomly sample 10% of routine and information requests, at least 30 per route (or all if fewer). Stratify by policy and repair type; retain the sampling denominator.'],
  ['Daily · Quality lead', 'Investigate unsafe routine recommendations', 'Any independently confirmed incorrect routine recommendation triggers same-day investigation. Trace the original facts and policy; temporarily route the affected segment to a person while the policy owner decides remediation.'],
  ['Weekly · Quality lead', 'Watch corrections and unnecessary escalation', 'Investigate an override share above 5% of reviewed cases, or unnecessary human escalation above 10% of independently assessed cases, once at least 30 are available. Compare with the previous four weeks and check sampling bias before changing rules.'],
  ['Weekly · Claims assessor', 'Reconcile delayed evidence', 'Revisit unresolved cohorts after 30 days, then weekly until evidence arrives. Record the correct next step at triage, assessor and independent evidence. Keep the original recommendation. Settlement or payment alone is not a triage label.'],
  ['Before release · Policy owner', 'Approve a tested policy change', 'Confirm independent labels for changed cases. Rerun all labelled examples and historical claims; inspect changed and unaffected quality separately. Resolve new unsafe routine errors, document trade-offs, approve by name, and recheck affected open claims. Closed decisions stay retained.'],
  ['Monthly · Operations and policy owners', 'Review drift, fairness and value', 'Compare error, missing-fact and escalation rates by policy version and repair type, with sample sizes. Investigate a rise of 5 percentage points in missing facts or human-review share versus the previous four weeks. Track handling time and cost when available; avoid conclusions from the 14 development examples.'],
];
export function createMeasurementUI({ root, active, request }) {
  let data = null, error = null, busy = false, saving = false, notice = '', requestId = 0, baseline = null, candidate = null;
  function render() {
    if (!active()) return;
    root.innerHTML = `<div class="measurement-page"><div class="page-head"><h1>Measurement</h1><button class="button" data-measure="refresh" ${busy ? 'disabled' : ''}>${busy ? 'Refreshing…' : 'Refresh data'}</button></div>${pageHint('measurement', { short: true })}
      ${error ? `<p class="banner" role="alert">${esc(error)}</p>` : ''}
      ${notice ? `<p class="measurement-notice" role="status">${esc(notice)}</p>` : ''}
      ${!data ? '<p class="notice" role="status">Loading measurement data…</p>' : content(data)}
      </div>`;
  }
  function content(d) {
    const o = d.operations;
    const reference = Object.values(d.label_sources).includes('v1_reference');
    const failures = d.examples.filter(e => !e.after.correct);
    return `<p class="measurement-intro">Decision quality, human feedback and policy changes in one place.</p>
      <p class="notice">Snapshot ${esc(when(d.generated_at))} · Active policy ${esc(d.active_version)} · All loaded claims, including development or practice imports. Refresh to include new activity.</p>
      <div class="measurement-status"><span><strong>${o.rechecks}</strong> open policy rechecks</span><span><strong>${o.missing_facts}</strong> claims with absent facts</span><span><strong>${d.outcomes.length}</strong> independent outcomes recorded</span></div>
      <section class="measure-section"><div class="measure-heading"><h2>Labelled decision quality</h2><span>${esc(d.baseline)} → ${esc(d.candidate)} · ${d.examples.length} development examples</span></div>
      <div class="measure-selectors"><label>Baseline<select id="measure-baseline" class="text-input">${d.policies.map(v => `<option ${v === d.baseline ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label><label>Compare with<select id="measure-candidate" class="text-input">${d.policies.map(v => `<option ${v === d.candidate ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label></div><p class="notice">Each rate uses all examples in that row as its denominator. These are development results, not production accuracy. “Affected” includes a changed prediction or expected answer.</p>
      ${reference ? '<p class="measurement-notice">Unlabelled set: a selected policy has no confirmed expected answers yet, so v1 answers are used. Accuracy may be misleading.</p>' : ''}
      <div class="measure-table-wrap"><table class="measure-table"><thead><tr><th scope="col">Test group</th><th scope="col">Correct decisions<br>Before / after</th><th scope="col">Incorrect routine<br>Before / after</th><th scope="col">Unnecessary human review<br>Before / after</th></tr></thead><tbody>${d.quality.map(g => `<tr><th scope="row">${esc(g.name)}</th>${['correct', 'incorrect_routine', 'unnecessary_human'].map(k => `<td><div class="measure-pair"><div>${metric(g.before[k])}</div><span aria-hidden="true">→</span><div class="${k !== 'correct' && g.after[k].count ? 'measure-error' : ''}">${metric(g.after[k])}</div></div></td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <details class="measure-details"><summary>${failures.length} candidate mismatches · inspect all ${d.examples.length} examples</summary><div class="measure-table-wrap"><table class="measure-table"><thead><tr><th>Case</th><th>Expected (before)</th><th>Expected (after)</th><th>Actual (after)</th><th>Explanation</th></tr></thead><tbody>${d.examples.map(e => `<tr><th scope="row">${esc(e.case.case_id)}</th><td>${names[e.before.expected]}</td><td class="${e.before.expected !== e.after.expected ? 'measure-error' : ''}">${names[e.after.expected]}${e.before.expected !== e.after.expected ? ' <small>(differs)</small>' : ''}</td><td class="${e.after.correct ? '' : 'measure-error'}">${names[e.after.actual.recommendation]}</td><td>${esc(e.after.actual.explanation)}</td></tr>`).join('')}</tbody></table></div></details></section>
      <div class="measure-columns"><section class="measure-section"><div class="measure-heading"><h2>Current routing</h2><span>${o.total} claims</span></div>
      <div class="measure-bars">${o.distribution.map(r => `<div data-outcome="${r.code}"><div class="measure-bar-label"><span>${names[r.code]}</span><strong>${r.count} <small>${pct(r.count, o.total)}</small></strong></div><div class="measure-track"><span style="width:${o.total ? r.count / o.total * 100 : 0}%"></span></div></div>`).join('')}</div><p class="notice">Current automated recommendations. Human corrections do not rewrite these decisions.</p></section>
      <section class="measure-section"><div class="measure-heading"><h2>Reviewer signals</h2><span>Current applicable reviews</span></div><dl class="measure-signals"><div><dt>Review coverage</dt><dd>${pct(o.reviewed, o.total)} <small>${o.reviewed} / ${o.total} claims</small></dd></div><div><dt>Override share</dt><dd>${pct(o.overrides, o.reviewed)} <small>${o.overrides} / ${o.reviewed} reviewed</small></dd></div><div><dt>Correct escalations resolved</dt><dd>${o.resolved_escalations}</dd></div></dl>
      <p class="notice">Corrections are investigation signals, not verified outcomes. Resolving a correct escalation is excluded from overrides. Reviews invalidated by changed decisions remain in Claims review history.</p>
      ${d.reviews.length ? `<details class="measure-details"><summary>Inspect ${d.reviews.length} current reviews</summary><div class="measure-table-wrap"><table class="measure-table"><thead><tr><th>Claim / policy</th><th>Reviewer</th><th>Correction</th><th>Reason</th></tr></thead><tbody>${d.reviews.map(r => `<tr><th scope="row">${esc(r.case_id)} · ${esc(r.automated.policy_version)}</th><td>${esc(r.reviewer)}<p>${esc(when(r.created_at))}</p></td><td>${names[r.automated.recommendation]} → ${names[r.final_recommendation]}</td><td>${esc(human(r.reason_code))}${r.note ? `<p>${esc(r.note)}</p>` : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}${o.reasons.length ? `<details class="measure-details"><summary>Review reasons</summary>${o.reasons.map(r => `<p>${esc(human(r.code))} <strong>${r.count}</strong></p>`).join('')}</details>` : ''}</section></div>
      <section class="measure-section"><div class="measure-heading"><h2>Delayed outcomes</h2><span>${d.outcomes.length} assessed claims · ${d.outcome_events} audit entries</span></div>
      <p class="notice">Record an independently assessed correct next step at triage when evidence arrives. Each entry preserves the recommendation, facts and policy being assessed. Revised assessments append to history; the latest assessment per claim appears below.</p>
      ${d.outcome_versions.length ? `<div class="measure-table-wrap"><table class="measure-table"><thead><tr><th>Assessed policy</th><th>Correct</th><th>Incorrect routine</th><th>Unnecessary human review</th></tr></thead><tbody>${d.outcome_versions.map(v => `<tr><th scope="row">${esc(v.version)}</th><td>${pct(v.correct, v.assessed)} (${v.correct}/${v.assessed})</td><td>${pct(v.incorrect_routine, v.assessed)} (${v.incorrect_routine}/${v.assessed})</td><td>${pct(v.unnecessary_human, v.assessed)} (${v.unnecessary_human}/${v.assessed})</td></tr>`).join('')}</tbody></table></div>` : '<p class="measure-empty">No independent outcomes yet. Production accuracy is not measured.</p>'}
      <details class="measure-details"><summary>Record an outcome</summary><form id="outcome-form" class="measure-form"><label>Claim and assessed policy<select name="case_id" class="text-input" required ${!d.claims.length ? 'disabled' : ''}>${d.claims.map(c => `<option value="${esc(c.id)}">${esc(c.id)} · ${esc(c.version)}</option>`).join('')}</select></label><label>Correct next step at triage<select name="expected" class="text-input" required><option value="">Choose a next step</option>${Object.entries(names).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label><label>Assessor<input name="assessor" class="text-input" required maxlength="160"></label><label class="measure-evidence">Independent evidence and why it changes or confirms triage<textarea name="evidence" class="text-input" required rows="3" maxlength="4000" placeholder="Reference the evidence and assess the facts known at the original decision."></textarea></label><button class="save" ${saving || !d.claims.length ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save outcome'}</button><span id="outcome-status" role="status"></span></form></details>
      ${d.outcomes.length ? `<details class="measure-details"><summary>Inspect ${d.outcomes.length} assessments</summary><div class="measure-table-wrap"><table class="measure-table"><thead><tr><th>Case / policy</th><th>Recorded decision</th><th>Assessed next step</th><th>Assessor / evidence</th></tr></thead><tbody>${d.outcomes.map(e => `<tr><th scope="row">${esc(e.case_id)} · ${esc(e.automated.policy_version)}</th><td>${names[e.automated.recommendation]}</td><td>${names[e.expected]}</td><td>${esc(e.assessor)} · ${esc(when(e.created_at))}<p>${esc(e.evidence)}</p></td></tr>`).join('')}</tbody></table></div></details>` : ''}</section>
      <section class="measure-section"><div class="measure-heading"><h2>Policy-change history</h2><span>Last eight saved comparisons</span></div>${d.comparisons.length ? `<div class="measure-table-wrap"><table class="measure-table"><thead><tr><th>Compared</th><th>Policy</th><th>Changed decisions</th><th>Open rechecks</th><th>Closed retained</th></tr></thead><tbody>${d.comparisons.map(r => `<tr><td>${esc(when(r.at))}</td><th scope="row">${esc(r.baseline)} → ${esc(r.candidate)}</th><td>${r.changed}</td><td>${r.rechecks}</td><td>${r.closed}</td></tr>`).join('')}</tbody></table></div><p class="notice">Historical simulations, including drafts. A saved comparison does not imply approval or activation. Open Validation for the current draft and release controls.</p>` : '<p class="measure-empty">No saved comparisons yet. Compare a policy in Validation to see its impact here.</p>'}</section>
      <section class="measure-section"><div class="measure-heading"><h2>Post-launch measurement plan</h2><span>Proposed operating targets</span></div><p class="notice">Agree these targets with the insurer before launch. Sampling, scheduled alerts and cohort ageing are a manual operating process; this page does not run them automatically.</p>
      <div class="measure-plan">${plan.map(([owner, title, body]) => `<article><p>${owner}</p><div><h3>${title}</h3><p>${body}</p></div></article>`).join('')}</div></section>`;
  }
  async function load() {
    const id = ++requestId; busy = true; error = null; render();
    try {
      const response = await fetch(`/api/measurement${baseline && candidate ? `?baseline=${encodeURIComponent(baseline)}&candidate=${encodeURIComponent(candidate)}` : ''}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load measurement data. Try Refresh data.');
      if (id === requestId) { data = payload; baseline = payload.baseline; candidate = payload.candidate; }
    } catch (e) { if (id === requestId) { error = e.message; baseline = data?.baseline ?? null; candidate = data?.candidate ?? null; } }
    finally { if (id === requestId) { busy = false; render(); } }
  }
  root.addEventListener('change', e => {
    if (!active()) return;
    if (e.target.id === 'measure-baseline') { baseline = e.target.value; load(); }
    if (e.target.id === 'measure-candidate') { candidate = e.target.value; load(); }
  });
  root.addEventListener('click', e => { if (active() && e.target.closest('[data-measure="refresh"]')) { notice = ''; load(); } });
  root.addEventListener('submit', async e => {
    if (!active() || e.target.id !== 'outcome-form') return;
    e.preventDefault(); if (saving) return;
    const form = e.target, button = form.querySelector('button'), status = form.querySelector('#outcome-status');
    saving = true; button.disabled = true; status.textContent = 'Saving…';
    try { const input = Object.fromEntries(new FormData(form)); input.decision_token = data.claims.find(c => c.id === input.case_id)?.decision_token; await request('/api/outcomes', input); notice = 'Outcome saved with its assessed decision and policy.'; saving = false; await load(); }
    catch (err) { status.textContent = err.message; }
    finally { saving = false; if (button.isConnected) { button.disabled = false; button.textContent = 'Save outcome'; } }
  });
  return { load, render };
}
