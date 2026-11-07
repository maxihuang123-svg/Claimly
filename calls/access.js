import { createHmac, timingSafeEqual } from 'node:crypto';

// A shared access code for when the app is reachable from outside (a tunnel or a deploy).
// Off unless ACCESS_CODE is set. Entering the code once sets a cookie; everything else needs it.

const COOKIE = 'access';
const MAX_AGE_SECS = 12 * 60 * 60;
const MAX_FAILURES_PER_MINUTE = 10; // across all visitors, so guessing a 6-digit code takes months

export const tokenFor = (code) => createHmac('sha256', code).update('claims-review-access').digest('base64url');

export function hasAccess(cookieHeader, code) {
  const sent = String(cookieHeader ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  const expected = Buffer.from(tokenFor(code));
  return sent.length === expected.length && timingSafeEqual(Buffer.from(sent), expected);
}

const page = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claims review</title><link rel="icon" href="data:,">
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
  <h1>Claims review</h1>
  <label for="code">Access code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required>
  ${error ? `<p role="alert">${error}</p>` : ''}
  <button type="submit">Open</button>
</form></body></html>`;

async function readCode(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024) break;
  }
  return new URLSearchParams(body).get('code')?.trim() ?? '';
}

// Returns a handler that answers the request itself (login page, 401) and resolves to true,
// or resolves to false when the request may go on.
export function accessGate(code) {
  if (!code) return async () => false;
  const token = tokenFor(code);
  let failures = [];

  return async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (hasAccess(request.headers.cookie, code)) return false;

    if (request.method === 'POST' && pathname === '/access') {
      const now = Date.now();
      failures = failures.filter((time) => now - time < 60_000);
      if (failures.length >= MAX_FAILURES_PER_MINUTE) {
        response.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page('Too many wrong codes. Wait a minute and try again.'));
        return true;
      }
      const sent = await readCode(request);
      if (sent.length === code.length && timingSafeEqual(Buffer.from(sent), Buffer.from(code))) {
        const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        response.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECS}${secure}`,
        });
        response.end();
        return true;
      }
      failures.push(now);
      response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page('That code is not right.'));
      return true;
    }

    if (pathname.startsWith('/api/')) {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Enter the access code first. Reload the page.' }));
    } else {
      response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page(''));
    }
    return true;
  };
}
