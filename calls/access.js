import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readText } from '../body.js';

// A shared access code for when the app is reachable from outside (a tunnel or a deploy).
// Off unless ACCESS_CODE is set. Entering the code once sets a cookie; everything else needs it,
// except the claimant's reply form (calls/email.js), where the token in the link is the key.
// On Cloudflare a second code, JUDGE_CODE, opens a separate copy of the data for the jury
// (worker/index.js). Which copy a visitor sees follows from the code their cookie was made from.
// A link like /?code=123456 logs in directly, so it can be shared as one click.

const COOKIE = 'access';
const MAX_AGE_SECS = 12 * 60 * 60;
const MAX_FAILURES_PER_MINUTE = 10; // across all visitors, so guessing a 6-digit code takes months

export const tokenFor = (code) => createHmac('sha256', code).update('claims-review-access').digest('base64url');

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// codes: the access code, or { main, judges } with one code per copy of the data. Unset codes are left out.
const spacesOf = (codes) => Object.entries(typeof codes === 'string' ? { main: codes } : codes ?? {}).filter(([, code]) => code);

// The copy the visitor's cookie gives access to ('main' or 'judges'), or null.
export function spaceOf(cookieHeader, codes) {
  const sent = String(cookieHeader ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  return spacesOf(codes).find(([, code]) => same(sent, tokenFor(code)))?.[0] ?? null;
}

export const hasAccess = (cookieHeader, code) => spaceOf(cookieHeader, code) !== null;

const page = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claimly</title><link rel="icon" href="data:,">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f8; color: #14181d;
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  form { display: grid; gap: 12px; width: min(320px, calc(100vw - 32px)); }
  h1 { margin: 0; font-size: 22px; font-weight: 650; }
  input { height: 44px; padding: 0 12px; border: 1px solid #c3c8ce; border-radius: 6px; font: inherit; font-size: 20px; letter-spacing: 0.2em; }
  button { height: 44px; border: 0; border-radius: 6px; background: #14181d; color: #fff; font: inherit; font-weight: 600; }
  p { margin: 0; color: #a4262c; font-size: 14px; font-weight: 550; }
</style></head>
<body><form method="post" action="/access">
  <h1>Claimly</h1>
  <label for="code">Access code</label>
  <input id="code" name="code" autocomplete="one-time-code" autofocus required>
  ${error ? `<p role="alert">${error}</p>` : ''}
  <button type="submit">Open</button>
</form></body></html>`;

const html = (body, status, headers = {}) => new Response(body, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

async function readCode(request) {
  try {
    return new URLSearchParams(await readText(request, 1024)).get('code')?.trim() ?? '';
  } catch {
    return ''; // too large: treated as a wrong code
  }
}

// Returns a handler that answers the request itself (login page, 401) with a Response,
// or resolves to null when the request may go on. Web Request/Response, so it runs on
// Node (server.js) and in the Cloudflare Worker alike.
export function accessGate(codes) {
  const spaces = spacesOf(codes);
  if (!spaces.length) return async () => null;
  let failures = [];

  function logIn(sent, url, request) {
    const now = Date.now();
    failures = failures.filter((time) => now - time < 60_000);
    if (failures.length >= MAX_FAILURES_PER_MINUTE) {
      return html(page('Too many wrong codes. Wait a minute and try again.'), 429);
    }
    const match = spaces.find(([, code]) => same(sent, code));
    if (!match) {
      failures.push(now);
      return html(page('That code is not right.'), 401);
    }
    const https = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${tokenFor(match[1])}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECS}${https ? '; Secure' : ''}`,
      },
    });
  }

  return async (request) => {
    const url = new URL(request.url);
    // A code in the link logs in, or switches copy, even with a cookie already set.
    if (request.method === 'GET' && url.pathname === '/' && url.searchParams.has('code')) {
      return logIn(url.searchParams.get('code').trim(), url, request);
    }
    if (url.pathname.startsWith('/reply/') || spaceOf(request.headers.get('cookie'), codes)) return null;
    if (request.method === 'POST' && url.pathname === '/access') return logIn(await readCode(request), url, request);

    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Enter the access code first. Reload the page.' }), {
        status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    return html(page(''), 401);
  };
}
