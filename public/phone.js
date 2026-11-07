// A full-screen phone call, as the claimant sees it: an incoming call that rings, then the call itself.
// It lives on <body>, outside the page, so redraws of the page never interrupt a call.
// The voice session is run by the caller of showIncomingCall; this module only draws and rings.

import { startRingtone } from './ringtone.js';

const RING_TIMEOUT_MS = 30000; // unanswered calls stop ringing, like a real phone
const VIBRATION = [400, 200, 400, 2000]; // matches the double ring in ringtone.js
const ENDED_MS = 1500;

const icon = (body, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;
const HANDSET = '<path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>';
const MIC = '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>';
const SLASH = '<path stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 4l16 16"/>';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

// Starts ringing at once, so call it from a tap: browsers only play sound after one.
// Handlers: onAccept(), onDecline(), onHangUp(), onMute(muted). Returns controls for the call in progress.
export function showIncomingCall({ caller, detail, onAccept, onDecline, onHangUp, onMute }) {
  const screen = document.createElement('div');
  screen.className = 'phone';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  screen.setAttribute('aria-label', `Call from ${caller}`);
  document.body.append(screen);
  document.documentElement.classList.add('phone-open');

  let phase = 'ringing'; // ringing, connecting, connected, ended
  let muted = false;
  let speaking = false;
  let seconds = 0;
  let clockTimer = null;
  let wakeLock = null;

  let stopRing = startRingtone();
  navigator.vibrate?.(Array(10).fill(VIBRATION).flat());
  const ringTimeout = setTimeout(() => decline(), RING_TIMEOUT_MS);

  function silence() {
    stopRing?.();
    stopRing = null;
    navigator.vibrate?.(0);
    clearTimeout(ringTimeout);
  }

  function status() {
    if (phase === 'ringing') return 'Incoming call';
    if (phase === 'connecting') return 'Connecting';
    if (phase === 'connected') return clock(seconds);
    return seconds ? `Call ended, ${clock(seconds)}` : 'Call ended';
  }

  function draw(message = '') {
    screen.dataset.phase = phase;
    const ringing = phase === 'ringing';
    screen.innerHTML = `
      <div class="phone-caller">
        <p class="phone-status" aria-live="polite">${escapeHtml(status())}</p>
        <h2 class="phone-name">${escapeHtml(caller)}</h2>
        <p class="phone-detail">${escapeHtml(detail)}</p>
      </div>
      <div class="phone-avatar" data-speaking="${speaking}"><span>${escapeHtml(initials(caller))}</span></div>
      ${message ? `<p class="phone-message" role="alert">${escapeHtml(message)}</p>` : ''}
      <div class="phone-actions">${ringing ? `
        <div class="phone-action"><button type="button" class="phone-button phone-decline" data-phone="decline" aria-label="Decline">${icon(HANDSET)}</button><span>Decline</span></div>
        <div class="phone-action"><button type="button" class="phone-button phone-accept" data-phone="accept" aria-label="Accept">${icon(HANDSET)}</button><span>Accept</span></div>`
        : phase === 'ended' ? (message ? '<div class="phone-action"><button type="button" class="phone-button phone-close" data-phone="close" aria-label="Close">&times;</button><span>Close</span></div>' : '') : `
        <div class="phone-action"><button type="button" class="phone-button phone-mute" data-phone="mute" aria-pressed="${muted}" aria-label="Mute" ${phase === 'connected' ? '' : 'disabled'}>${icon(MIC + (muted ? SLASH : ''))}</button><span>${muted ? 'Unmute' : 'Mute'}</span></div>
        <div class="phone-action"><button type="button" class="phone-button phone-decline" data-phone="hangup" aria-label="End call">${icon(HANDSET)}</button><span>End</span></div>`}
      </div>`;
  }

  function close() {
    silence();
    clearInterval(clockTimer);
    wakeLock?.release().catch(() => {});
    screen.remove();
    document.documentElement.classList.remove('phone-open');
  }

  function decline() {
    if (phase !== 'ringing') return;
    close();
    onDecline?.();
  }

  function accept() {
    silence();
    phase = 'connecting';
    draw();
    navigator.wakeLock?.request('screen').then((lock) => { wakeLock = lock; }).catch(() => {});
    onAccept();
  }

  screen.addEventListener('click', (event) => {
    const action = event.target.closest('[data-phone]')?.dataset.phone;
    if (action === 'accept') accept();
    else if (action === 'decline') decline();
    else if (action === 'close') close();
    else if (action === 'hangup') onHangUp();
    else if (action === 'mute') {
      muted = !muted;
      onMute(muted);
      draw();
    }
  });

  draw();
  screen.querySelector('[data-phone="accept"]').focus();

  return {
    connected() {
      if (phase !== 'connecting') return;
      phase = 'connected';
      clockTimer = setInterval(() => {
        seconds += 1;
        screen.querySelector('.phone-status').textContent = status();
      }, 1000);
      draw();
    },
    speaking(value) {
      speaking = value;
      screen.querySelector('.phone-avatar')?.setAttribute('data-speaking', String(value));
    },
    ended() {
      if (phase === 'ended') return;
      phase = 'ended';
      clearInterval(clockTimer);
      draw();
      setTimeout(close, ENDED_MS);
    },
    failed(message) {
      phase = 'ended';
      clearInterval(clockTimer);
      draw(message);
    },
  };
}
