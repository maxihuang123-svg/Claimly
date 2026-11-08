// Help page.
// Everything the app already knows (reasons, outcomes, policy version, open work) is read live,
// so the instructions stay true when the policy or the reason list changes.

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

// The contact in "Problems or questions": an email address or URL. Fictional for the demo, like claims@claimly.example.
const SUPPORT_CONTACT = 'support@claimly.example';

export const helpIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.5-1.8 2.6M8 11.6h.01"/></svg>';

// When to pick each correction reason. Codes the app doesn't know yet still show with their label.
const REASON_GUIDE = {
  evidence_supports: 'You agree with the system. The evidence backs up its recommendation.',
  resolved_after_review: 'The claim rightly needed a person, and you have now settled it.',
  input_data_wrong: 'A fact on the claim is wrong, for example the amount or a missing document that is actually there. The rule did its job with bad data.',
  rule_misapplied: 'The facts are right, but the rule should not have fired on them.',
  policy_gap: 'The rule worked as written, but the written policy gives the wrong answer for this kind of claim. Rule owners use these to improve the policy.',
  other: 'None of the above. Explain in the note, which is required for this reason.',
};

const OUTCOME_GUIDE = {
  routine_processing: 'Every check passed. The claim goes to normal processing without a full review.',
  request_information: 'Something needed for a decision is missing, such as an incident report, an itemized quote or a blank field like the repair type. The claim appears under Missing information.',
  human_review: 'A check found a risk, for example an injury, disputed liability, a possible duplicate, conflicting evidence, a quote above the limit or a policy that was not active. A person decides.',
};

const GLOSSARY = [
  ['Policy version', 'A numbered set of rules (v1, v2, …). Every recommendation and every review records the version it used.'],
  ['Rule and check', 'A rule is a group of checks. Each check shows OK, Triggered, or Cannot check when a fact is missing.'],
  ['Routed automatically', 'Claims the policy did not send to a person. You can still open and spot-check them.'],
  ['Policy recheck', 'Open claims whose outcome may change under a newly activated policy. They need a review again.'],
  ['Correction', 'A reviewer changed the system’s recommendation. The original stays on record next to the correction.'],
  ['Labelled example', 'A test claim with an agreed correct answer. Used to score policies, never to decide real claims.'],
  ['Baseline', 'The policy version a draft is compared against, usually the current one.'],
  ['Incorrect routine', 'A test claim sent to routine processing that should have gone elsewhere. The costliest kind of mistake.'],
  ['Unnecessary human review', 'A test claim sent to a person that could safely have been routine. Costs time, not money paid out.'],
  ['Independent outcome', 'The correct next step, assessed separately once all evidence is in. The only way to measure accuracy on real claims.'],
];

const section = (id, title, body) => `<section class="help-section" id="help-${id}" aria-labelledby="help-${id}-title">
  <h2 id="help-${id}-title">${title}</h2>${body}</section>`;

export function renderHelp({ container, outcomes, reasons, policyVersion, counts }) {
  const outcomeCodes = Object.keys(outcomes);
  const pill = (code) => `<span class="pill" data-outcome="${code}">${escapeHtml(outcomes[code].name)}</span>`;
  const today = counts.toReview || counts.recheck
    ? `Right now: <strong>${counts.toReview}</strong> ${counts.toReview === 1 ? 'claim waits' : 'claims wait'} for review${counts.recheck ? `, and <strong>${counts.recheck}</strong> need a recheck after a policy change` : ''}.`
    : 'Right now no claim is waiting for review.';
  const contact = SUPPORT_CONTACT
    ? `Contact: <a class="link" href="${SUPPORT_CONTACT.includes('@') ? `mailto:${escapeHtml(SUPPORT_CONTACT)}` : escapeHtml(SUPPORT_CONTACT)}">${escapeHtml(SUPPORT_CONTACT)}</a>.`
    : 'Send it to the person who set up Claimly for your team.';

  container.innerHTML = `<div class="help">
    <div class="page-head"><h1>Help</h1><button type="button" class="button" data-tour-start>Start tutorial</button></div>
    <p class="help-lead">Claimly checks every claim against your written policy (currently <strong>${escapeHtml(policyVersion ?? '…')}</strong>) and suggests one of three next steps. A person makes the call wherever it matters, and every decision is recorded.</p>

    <nav class="help-toc" aria-label="On this page"><ul>
      <li><a href="#help-start">Who uses which page</a></li>
      <li><a href="#help-review">Review a claim</a></li>
      <li><a href="#help-outcomes">The three next steps</a></li>
      <li><a href="#help-reasons">Choosing a reason</a></li>
      <li><a href="#help-missing">Missing information</a></li>
      <li><a href="#help-policy">When the policy changes</a></li>
      <li><a href="#help-quality">Quality pages</a></li>
      <li><a href="#help-terms">Terms</a></li>
      <li><a href="#help-problems">Problems or questions</a></li>
    </ul></nav>

    ${section('start', 'Who uses which page', `
      <div class="help-roles">
        <div><h3>Reviewers</h3><p>Daily work on claims.</p>
          <ul><li><button type="button" class="link" data-page="claims">Claims review</button></li>
          <li><button type="button" class="link" data-page="calls">Missing information</button></li></ul></div>
        <div><h3>Rule owners</h3><p>Keep the policy right and check its quality.</p>
          <ul><li><button type="button" class="link" data-page="policies">Policies</button></li>
          <li><button type="button" class="link" data-page="validation">Validation</button></li>
          <li><button type="button" class="link" data-page="labels">Expected answers</button></li>
          <li><button type="button" class="link" data-page="measurement">Measurement</button></li></ul></div>
      </div>
      <p class="help-today">${today}</p>`)}

    ${section('review', 'Review a claim', `
      <ol class="help-steps">
        <li><strong>Open Claims review.</strong> The <em>Human review</em> filter lists claims that need a person; <em>To review</em> narrows it to the ones nobody has done yet.</li>
        <li><strong>Read the row.</strong> <em>Recommendation</em> is the system’s suggested next step and <em>Why</em> is the short reason. Point at the recommendation to see the exact rule and which checks it triggered.</li>
        <li><strong>Click Review decision</strong> and enter your name as Reviewer.</li>
        <li><strong>Decide.</strong> For a claim sent to ${pill('human_review')}, choose the next step it should take now, pick a reason and add a note if useful. Then <em>Save review</em>.</li>
        <li><strong>Spot-check the rest.</strong> Under <em>Routed automatically</em> you can open any claim and either confirm it or use <em>Change recommendation</em>.</li>
      </ol>`)}

    ${section('outcomes', 'The three next steps', `
      <dl class="help-outcomes">${outcomeCodes.map((code) => `<div><dt>${pill(code)}</dt><dd>${escapeHtml(OUTCOME_GUIDE[code] ?? '')}</dd></div>`).join('')}</dl>
      <p class="help-note">The exact checks behind each step are listed on <button type="button" class="link" data-page="policies">Policies</button>.</p>`)}

    ${section('reasons', 'Choosing a reason', `
      <p>Your reason tells rule owners why a decision was confirmed or changed. Pick the one that fits best:</p>
      <dl class="help-reasons">${reasons.map((reason) => `<div><dt>${escapeHtml(reason.label)}</dt><dd>${escapeHtml(REASON_GUIDE[reason.code] ?? '')}</dd></div>`).join('')}</dl>`)}

    ${section('missing', 'Missing information', `
      <p>Claims sent to ${pill('request_information')} are listed on <button type="button" class="link" data-page="calls">Missing information</button>, with what exactly is missing.</p>
      <p>Claimly asks the claimant for exactly that. When a file is imported, it emails each claimant a link to a short form. From the claim you can also send the email again or start a call with the voice assistant. A clear answer on the form or the call, such as the repair type or an uploaded document, is written to the claim, the rules run again and the claim moves to its new next step without anyone touching it.</p>
      <p>Anything else the claimant says or types is kept as a note on the claim. If it is something new, verify it before changing any fact on the claim.</p>`)}

    ${section('policy', 'When the policy changes', `
      <ol class="help-steps">
        <li><strong>Draft.</strong> On Policies, <em>Edit policy</em> starts a draft of the next version. The current policy keeps running.</li>
        <li><strong>Check the impact.</strong> <em>Review draft</em> opens Validation, which shows every claim whose next step would change, and how the draft scores on the test examples.</li>
        <li><strong>Activate.</strong> Once you are satisfied, enter your name under <em>Approved by</em> on Validation and click <em>Activate draft</em>.</li>
        <li><strong>Recheck.</strong> Open claims whose outcome changes appear under the <em>Policy recheck</em> filter on Claims review and need a review again.</li>
      </ol>`)}

    ${section('quality', 'Quality pages', `
      <dl class="help-reasons">
        <div><dt>Expected answers</dt><dd>The agreed correct next step for each test example. When the rules change, rule owners confirm the answers for the new version.</dd></div>
        <div><dt>Validation</dt><dd>A simulation: which claims would move, and how test results change, before a draft is used. Recorded decisions stay untouched.</dd></div>
        <div><dt>Measurement</dt><dd>Decision quality on test examples, reviewer corrections and independently recorded outcomes. Test results are not the same as accuracy on real claims.</dd></div>
      </dl>`)}

    ${section('terms', 'Terms', `
      <dl class="help-terms">${GLOSSARY.map(([term, text]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(text)}</dd></div>`).join('')}</dl>`)}

    ${section('problems', 'Problems or questions', `
      <p>Something looks wrong? Write down the case ID, what you saw and what you expected. ${contact}</p>`)}
  </div>`;
}
