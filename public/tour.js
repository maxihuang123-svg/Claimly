// Guided tour for demos: a box next to each important control, page by page. Started from "Start tutorial"
// in the sidebar or on Help (app.js). Pages redraw on their own (polling, saves), so the highlighted element is
// looked up again by its selector every few hundred milliseconds rather than kept.

const STEPS = [
  {
    page: 'claims', target: '.brand', title: 'Welcome to Claimly',
    text: 'Claimly checks every motor claim against your written policy and suggests the next step. A person decides wherever it matters. This tour shows the whole flow in about a minute.',
  },
  {
    page: 'claims', target: '[data-import]', title: 'Import claims',
    text: 'Upload a CSV file of claims. Every claim is checked against the active policy straight away.',
  },
  {
    page: 'claims', target: '.bento .mix', title: 'Where every claim goes',
    text: 'Each open claim gets one of three next steps: routine processing, request information or human review. Click a step to see its claims.',
  },
  {
    page: 'claims', target: '.table-card .filters', title: 'Work through the queue',
    text: 'Human review lists the claims that need a person. Routed automatically shows the rest, for spot checks.',
  },
  {
    page: 'claims', target: '.claims .rule-trigger', title: 'Why this recommendation?',
    text: 'Point at a recommendation to see the exact rule and the checks behind it.',
  },
  {
    page: 'claims', target: '.claims .review-edit', title: 'Review a decision',
    text: 'Confirm or correct the recommendation and give a reason. Nothing is overwritten: every review is recorded next to the original.',
  },
  {
    page: 'calls', target: '[data-calls-page] .page-head', title: 'Missing information',
    text: 'Claims that cannot move on because something is missing. Claimly asks the claimant for exactly that, by email or by an AI voice call.',
  },
  {
    page: 'calls', target: '[data-call-browser]', title: 'Call the claimant',
    text: 'The AI assistant asks only what is missing. A clear answer updates the claim during the call, and the rules run again.',
    // The call buttons are inside a claim: open one that can still be called, a demo claim if there is one.
    prepare: () => {
      if (document.querySelector('[data-call-browser]')) return;
      const callable = [...document.querySelectorAll('[data-call-row]')].filter((row) => row.querySelector('.c-missing')?.textContent.trim());
      (callable.find((row) => row.dataset.callRow.startsWith('DEMO-')) ?? callable[0])?.click();
    },
  },
  {
    page: 'calls', target: '[data-call-email]', title: 'Or send an email',
    text: 'A link to a short form that asks the same question. New claims get this email automatically when they are imported.',
  },
  {
    page: 'calls', target: '.call-row .c-contact', title: 'Follow it live',
    text: 'The status changes by itself: Email sent or In progress, then Email → Updated or Call → Updated once the claim has moved on.',
  },
  {
    page: 'policies', target: '[data-policy-action="edit"]', title: 'Change the rules safely',
    text: 'The policy is written rules with a version number. A change starts as a draft, and Validation shows which claims would change before it goes live.',
  },
  {
    page: null, target: '.nav [data-page="help"]', title: 'Help any time',
    text: 'Help explains every page. You can start this tour again from there or from the sidebar.',
  },
];

const GAP = 12;
const PAD = 6;
let tour = null; // { index, root, ring, card, timer, goToPage, currentPage }

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

const visible = (element) => {
  const rect = element?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
};

async function waitFor(selector, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 100) {
    if (visible(document.querySelector(selector))) return true;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return false;
}

// Puts the ring around the target and the box beside it, wherever there is room. Without a target the
// ring shrinks to the middle of the screen, which dims everything, and the box sits in the middle.
function place() {
  if (!tour) return;
  const { ring, card } = tour;
  const rect = visible(document.querySelector(STEPS[tour.index].target));
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const maxLeft = innerWidth - width - GAP;
  const maxTop = innerHeight - height - GAP;
  const clamp = (value, max) => Math.max(GAP, Math.min(value, max));

  if (!rect) {
    Object.assign(ring.style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: '0px', height: '0px' });
    Object.assign(card.style, { left: `${clamp((innerWidth - width) / 2, maxLeft)}px`, top: `${clamp((innerHeight - height) / 2, maxTop)}px` });
    return;
  }
  Object.assign(ring.style, {
    left: `${rect.left - PAD}px`, top: `${rect.top - PAD}px`, width: `${rect.width + PAD * 2}px`, height: `${rect.height + PAD * 2}px`,
  });
  let left;
  let top;
  if (rect.bottom + PAD + GAP + height <= innerHeight - GAP) {
    [left, top] = [rect.left, rect.bottom + PAD + GAP];
  } else if (rect.top - PAD - GAP - height >= GAP) {
    [left, top] = [rect.left, rect.top - PAD - GAP - height];
  } else if (rect.right + PAD + GAP + width <= innerWidth - GAP) {
    [left, top] = [rect.right + PAD + GAP, rect.top];
  } else {
    [left, top] = [rect.left - PAD - GAP - width, rect.top];
  }
  Object.assign(card.style, { left: `${clamp(left, maxLeft)}px`, top: `${clamp(top, maxTop)}px` });
}

async function show(index) {
  if (!tour) return;
  tour.index = index;
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  tour.card.innerHTML = `<p class="tour-count">${index + 1} of ${STEPS.length}</p>
    <h2 id="tour-title">${escapeHtml(step.title)}</h2>
    <p>${escapeHtml(step.text)}</p>
    <div class="tour-actions">
      <button type="button" class="link" data-tour="end">${last ? 'Close' : 'Skip tour'}</button>
      <span>${index ? '<button type="button" class="button" data-tour="back">Back</button>' : ''}
      <button type="button" class="save" data-tour="next">${last ? 'Finish' : 'Next'}</button></span>
    </div>`;
  tour.card.querySelector('[data-tour="next"]').focus({ preventScroll: true });

  if (step.page && tour.currentPage() !== step.page) tour.goToPage(step.page);
  step.prepare?.();
  if (await waitFor(step.target)) {
    if (!tour || tour.index !== index) return; // moved on while waiting
    step.prepare?.();
    document.querySelector(step.target).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  place();
}

export function endTour() {
  if (!tour) return;
  clearInterval(tour.timer);
  tour.root.remove();
  removeEventListener('resize', place);
  removeEventListener('scroll', place, true);
  document.removeEventListener('keydown', onKey, true);
  tour = null;
}

function onKey(event) {
  if (!tour || event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'Escape') endTour();
  else if (event.key === 'ArrowRight') move(1);
  else if (event.key === 'ArrowLeft') move(-1);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function move(by) {
  const next = tour.index + by;
  if (next >= STEPS.length) endTour();
  else if (next >= 0) show(next);
}

// goToPage(id) and currentPage() come from app.js, so the tour switches pages the same way the sidebar does.
export function startTour({ goToPage, currentPage }) {
  endTour();
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = '<div class="tour-ring"></div><section class="tour-card" role="dialog" aria-labelledby="tour-title"></section>';
  document.body.append(root);
  tour = {
    index: 0, root, ring: root.querySelector('.tour-ring'), card: root.querySelector('.tour-card'),
    goToPage, currentPage, timer: setInterval(place, 250),
  };
  tour.card.addEventListener('click', (event) => {
    const action = event.target.closest('[data-tour]')?.dataset.tour;
    if (action === 'next') move(1);
    else if (action === 'back') move(-1);
    else if (action === 'end') endTour();
  });
  addEventListener('resize', place);
  addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKey, true);
  show(0);
}
