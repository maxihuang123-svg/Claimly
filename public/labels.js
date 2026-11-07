const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { routine_processing: 'Routine processing', request_information: 'Request information', human_review: 'Human review' };
const versionName = (version) => version === 'draft' ? 'Draft' : `Policy ${version}`;
const sourceText = (source) => source === 'confirmed' ? 'Confirmed for these rules' : source === 'supplied' ? 'Supplied v1 answers' : 'Not confirmed yet · starting from v1 answers';

// One place to set the correct next step for each labelled development example, per policy.
export function createLabelsUI({ root, active, request, flush, onValidation }) {
  const state = { data: null, policy: null, expected: null, busy: false, error: null, notice: null };
  let generation = 0;
  const setup = () => state.data.preview.label_setup;
  const changedIds = () => state.data ? setup().examples.map((e) => e.case_id).filter((id) => state.expected[id] !== setup().expected[id]) : [];
  const dirty = () => changedIds().length > 0;

  function render() {
    if (!active()) return;
    if (!state.data) {
      root.innerHTML = `<div class="page-head"><h1>Expected answers</h1></div><div class="state" role="status">${state.error ? `${esc(state.error)}<br><button class="button" data-labels="reload">Try again</button>` : 'Loading labelled examples…'}</div>`;
      return;
    }
    const { examples, source, reference } = setup();
    const changed = changedIds();
    const fromV1 = examples.filter((e) => state.expected[e.case_id] !== reference[e.case_id]).length;
    const options = `${state.data.draft ? `<option value="draft" ${state.policy === 'draft' ? 'selected' : ''}>Draft</option>` : ''}${state.data.policies.map((p) => `<option value="${p.version}" ${state.policy === p.version ? 'selected' : ''}>Policy ${p.version}${p.version === state.data.current_version ? ' · Current' : ''}</option>`).join('')}`;
    root.innerHTML = `<div class="validation-page labels-page">
      <header class="validation-heading"><div><h1>Expected answers</h1><p>Choose the correct next step for each labelled example. Validation and Measurement score policies against these answers.</p></div></header>
      <section class="comparison-panel"><div class="validation-controls">
        <label class="field"><span>Answers for</span><select class="text-input" id="labels-policy" ${state.busy ? 'disabled' : ''}>${options}</select></label>
        <div class="labels-source" data-source="${esc(source)}"><span>Status</span><strong>${esc(sourceText(source))}</strong></div>
      </div><div class="comparison-scope"><span>${examples.length} development examples · ${fromV1 ? `${fromV1} ${fromV1 === 1 ? "differs" : "differ"} from v1` : 'all match v1'}</span><span>Answers are tied to these policy rules. Editing the rules later needs a new confirmation.</span></div></section>
      ${state.error ? `<p class="validation-alert error" role="alert">${esc(state.error)}</p>` : ''}
      ${source === 'v1_reference' ? `<p class="validation-alert" role="status">These answers start from v1. Check each one under ${esc(versionName(state.policy))}, then save to confirm them.</p>` : ''}
      <div class="validation-table-wrap"><table class="validation-table labels-table"><thead><tr><th>Example</th><th>Claim</th><th>Expected next step</th></tr></thead><tbody>${examples.map((record) => {
        const id = record.case_id, value = state.expected[id];
        const notes = [changed.includes(id) ? '<span class="label-flag unsaved">Unsaved</span>' : '', value !== reference[id] ? `<span class="label-flag">v1: ${esc(names[reference[id]] ?? 'Not set')}</span>` : ''].join('');
        return `<tr ${changed.includes(id) ? 'class="label-changed"' : ''}><td class="label-id">${esc(id)}</td><td><p>${esc(record.claim_summary)}</p>${facts(record)}</td><td><div class="segments" role="radiogroup" aria-label="Expected next step for ${esc(id)}">${Object.entries(names).map(([key, name]) => `<button type="button" class="segment" role="radio" data-outcome="${key}" data-labels="set" data-case="${esc(id)}" data-value="${key}" aria-pressed="${value === key}" aria-checked="${value === key}" ${state.busy ? 'disabled' : ''}>${name}</button>`).join('')}</div>${notes ? `<div class="label-flags">${notes}</div>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="labels-bar" role="region" aria-label="Save expected answers">
        <span class="notice" role="status">${state.notice ? esc(state.notice) : changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : source === 'confirmed' ? 'All answers saved.' : 'Save to confirm these answers for this policy.'}</span>
        ${state.notice && !changed.length ? `<button type="button" class="link" data-labels="validation">Go to Validation</button>` : ''}
        ${changed.length ? `<button type="button" class="button" data-labels="discard" ${state.busy ? 'disabled' : ''}>Discard</button>` : ''}
        <button type="button" class="save" data-labels="save" ${state.busy || (!changed.length && source === 'confirmed') ? 'disabled' : ''}>${state.busy ? 'Saving…' : 'Save expected answers'}</button>
      </div>
    </div>`;
  }
  function facts(record) {
    return `<details class="validation-details"><summary>Input facts</summary><dl class="validation-facts">${Object.entries(record).filter(([k]) => k !== 'claim_summary').map(([k, v]) => `<dt>${esc(k.replaceAll('_', ' '))}</dt><dd>${esc(v === null ? 'Not provided' : v)}</dd>`).join('')}</dl></details>`;
  }
  async function load(policy = state.policy) {
    const seq = ++generation;
    state.error = null; state.busy = true; state.policy = policy; render();
    try {
      await flush();
      const params = new URLSearchParams();
      if (policy) params.set('candidate', policy);
      const response = await fetch(`/api/validation?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not load the labelled examples. Try again.');
      if (seq !== generation) return;
      state.data = data;
      state.expected = { ...data.preview.label_setup.expected };
      state.policy ??= data.draft ? 'draft' : data.current_version;
    } catch (error) { if (seq === generation) { state.error = error.message; state.data = null; } }
    finally { if (seq === generation) { state.busy = false; render(); } }
  }
  async function action(kind, button) {
    if (kind === 'reload') return load();
    if (state.busy) return;
    if (kind === 'validation') return onValidation(state.policy);
    if (kind === 'set') { state.expected[button.dataset.case] = button.dataset.value; state.notice = null; render(); return; }
    if (kind === 'discard') { state.expected = { ...setup().expected }; state.notice = null; render(); return; }
    if (kind !== 'save') return;
    state.busy = true; state.error = null; render();
    try {
      await request('/api/validation/labels', { candidate: state.policy, token: setup().token, expected: { ...state.expected } });
      await load();
      state.notice = `Saved for ${versionName(state.policy)}. Run the comparison in Validation to see the results.`;
    } catch (error) { state.error = error.message; }
    finally { state.busy = false; render(); }
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-labels]');
    if (button && active()) { event.stopPropagation(); action(button.dataset.labels, button); }
  });
  root.addEventListener('change', (event) => {
    if (event.target.id !== 'labels-policy' || !active()) return;
    if (dirty() && !confirm('Discard unsaved expected answers?')) { event.target.value = state.policy; return; }
    state.notice = null;
    load(event.target.value);
  });
  return { render, load: (policy) => { state.notice = null; return load(policy ?? state.policy); }, dirty };
}
