// Emails a claimant when the rules find information missing, with a personal link to a short form that asks
// only for what is missing. A clear answer updates the claim the same way a call does (updateCase).
//
//   POST /api/emails                 { case_id } -> send (or send again) the email for one claim
//   GET  /api/documents?id=...       a document a claimant uploaded, for the claims team
//   GET  /reply/<token>              the claimant's form; public, the token is the only key
//   POST /reply/<token>              the claimant's answers
//
// Emails go out through Resend (RESEND_API_KEY). Every claim goes to CLAIMANT_EMAIL for now, because
// the claim data has no contact details. Without both set, nothing is emailed.

import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readBytes, TooLarge } from '../body.js';
import { askFor, canCall, joinList, missingFields, missingItems } from '../public/missing.js';

const RESEND = 'https://api.resend.com';
const DEFAULT_FROM = 'Claimly Claims <onboarding@resend.dev>'; // Resend's test sender, until a domain is set up
const LINK_DAYS = 7;
const MAX_AUTO_EMAILS = 10; // per import, so a large file cannot use up the daily sending quota
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const TOKEN = /^[\w-]{32}$/;

// Answers that settle a blank repair type, as on the call (UPDATES in calls/api.js). "unknown" is kept as a note.
const REPAIR_CHOICES = [
  ['standard', 'No. The car is petrol or diesel, or the high-voltage battery is not affected.'],
  ['ev_high_voltage_battery', 'Yes. The high-voltage battery, its housing or its cables are damaged.'],
  ['unknown', "I'm not sure."],
];
const CLEAR_REPAIR = ['standard', 'ev_high_voltage_battery'];
const DOCUMENTS = { incident_report_present: 'Incident report', itemized_quote_present: 'Itemized repair quote' };
// Recognised by their first bytes, not by what the browser claims.
const FILE_TYPES = [
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
];
const outcome = (automated) => ({
  recommendation: automated.recommendation, policy_version: automated.policy_version, rule_id: automated.rule_id,
});

class EmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
const details = (item) => (missingItems(item).length > 1 ? 'a few more details' : 'one more detail');
const fileType = (bytes) => FILE_TYPES.find(([, magic]) => magic.every((byte, index) => bytes[index] === byte))?.[0] ?? null;

/* The claimant's pages. Plain HTML forms, so they work on any phone without scripts. */

const page = (title, body, status = 200) => new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,">
<style>
  body { margin: 0; background: #f7f7f8; color: #14181d; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { display: grid; gap: 20px; max-width: 520px; margin: 0 auto; padding: 40px 20px 64px; }
  .brand { color: #5b636d; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
  h1 { margin: 0; font-size: 24px; font-weight: 650; line-height: 1.25; }
  p { margin: 0; }
  form { display: grid; gap: 20px; }
  fieldset { display: grid; gap: 10px; margin: 0; padding: 16px; border: 1px solid #dfe2e6; border-radius: 8px; background: #fff; }
  legend { float: left; padding: 0; font-size: 17px; font-weight: 650; } /* inside the box, not on its border */
  .choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid #dfe2e6; border-radius: 6px; cursor: pointer; }
  .choice:has(input:checked) { border-color: #14181d; box-shadow: inset 0 0 0 1px #14181d; }
  .choice input { margin-top: 4px; }
  label.field { display: grid; gap: 4px; color: #5b636d; font-size: 14px; }
  input[type=text] { height: 44px; padding: 0 12px; border: 1px solid #c3c8ce; border-radius: 6px; font: inherit; color: #14181d; }
  input[type=file] { font: inherit; font-size: 14px; }
  button { height: 48px; border: 0; border-radius: 6px; background: #14181d; color: #fff; font: inherit; font-weight: 600; }
  .note { color: #5b636d; font-size: 14px; }
  .error { padding: 10px 12px; border-radius: 6px; background: #fdecec; color: #a4262c; font-size: 14px; font-weight: 550; }
</style></head>
<body><main><p class="brand">Claimly · Motor claims</p>${body}
<p class="note">Claimly is a fictional insurer in a demo. We will never ask for bank details, passwords or ID numbers here.</p>
</main></body></html>`, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});

const message = (title, text, status = 200) => page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`, status);

function fieldInput(field) {
  if (field === 'repair_type') {
    return `<fieldset><legend>What is being repaired?</legend>
      <p>Does the repair involve the high-voltage battery of an electric or plug-in hybrid car?</p>
      ${REPAIR_CHOICES.map(([value, label]) => `<label class="choice"><input type="radio" name="repair_type" value="${value}"> ${escapeHtml(label)}</label>`).join('')}
      <label class="field">What is the garage repairing? (optional)<input type="text" name="repair_description" maxlength="300" placeholder="For example: rear bumper"></label>
    </fieldset>`;
  }
  if (DOCUMENTS[field]) {
    return `<fieldset><legend>${DOCUMENTS[field]}</legend>
      <label class="field">A PDF or a photo (JPEG or PNG)<input type="file" name="${field}" accept="application/pdf,image/jpeg,image/png"></label>
    </fieldset>`;
  }
  return `<fieldset><legend>${escapeHtml(capitalize(askFor(field)))}</legend>
    <label class="field">Your answer<input type="text" name="${field}" maxlength="300"></label>
  </fieldset>`;
}

const formPage = (item, fields, error = '') => page(`Claim ${item.case.case_id}`, `
  <h1>Claim ${escapeHtml(item.case.case_id)}: ${details(item)}</h1>
  <p>Before your claim can move on, we still need ${escapeHtml(joinList(missingItems(item)))}. It takes under a minute.</p>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" enctype="multipart/form-data">
    ${fields.map(fieldInput).join('')}
    <button type="submit">Send answer</button>
  </form>`, error ? 400 : 200);

/* The email */

function emailFor(item, link) {
  const id = item.case.case_id;
  const needed = joinList(missingItems(item));
  return {
    subject: `Claim ${id}: ${details(item)} ${missingItems(item).length > 1 ? 'are' : 'is'} needed`,
    text: `Hello,\n\nWe are processing your motor claim ${id}. Before it can move on, we still need ${needed}.\n\n`
      + `It takes under a minute: ${link}\n\nThe link works for ${LINK_DAYS} days. We will never ask for bank details, passwords or ID numbers.\n\n`
      + 'Claimly Claims\n(Claimly is a fictional insurer in a demo.)',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5;color:#14181d;max-width:520px">
      <p style="color:#5b636d;font-size:14px;font-weight:600">Claimly · Motor claims</p>
      <p>Hello,</p>
      <p>We are processing your motor claim <strong>${escapeHtml(id)}</strong>. Before it can move on, we still need <strong>${escapeHtml(needed)}</strong>.</p>
      <p>It takes under a minute.</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#14181d;color:#fff;font-weight:600;text-decoration:none">Answer now</a></p>
      <p style="color:#5b636d;font-size:14px">The link works for ${LINK_DAYS} days. We will never ask for bank details, passwords or ID numbers.</p>
      <p>Claimly Claims</p>
      <p style="color:#5b636d;font-size:12px">Claimly is a fictional insurer in a demo.</p>
    </div>`,
  };
}

// documents: { save(id, bytes), read(id) } (storage.js). updateCase as in calls/api.js.
export function createEmailApi({ env, findItem, contacts, documents, updateCase, fetch = globalThis.fetch }) {
  const dryRun = Boolean(env.EMAIL_DRY_RUN); // the judges' copy: recorded as sent, nothing is delivered
  const configured = () => dryRun || Boolean(env.RESEND_API_KEY && env.CLAIMANT_EMAIL);
  const emailsFor = (caseId) => contacts.all().filter((contact) => contact.channel === 'email' && contact.case_id === caseId);

  // Records one contact per claim first, so every link exists before its email goes out, then sends them together.
  async function send(items, origin, initiatedBy) {
    if (!dryRun && !env.RESEND_API_KEY) throw new EmailError(500, 'RESEND_API_KEY is not set on the server.');
    if (!dryRun && !env.CLAIMANT_EMAIL) throw new EmailError(500, 'CLAIMANT_EMAIL is not set on the server.');
    const base = env.PUBLIC_URL ?? origin;
    const sent = items.map((item) => ({ item, contact: contacts.add({
      channel: 'email',
      case_id: item.case.case_id,
      initiated_by: initiatedBy,
      to: dryRun ? 'the claimant' : env.CLAIMANT_EMAIL,
      ...(dryRun ? { simulated: true } : {}),
      missing_items: missingItems(item),
      policy_version: item.automated.policy_version,
      rule_id: item.automated.rule_id,
      token: randomBytes(24).toString('base64url'),
      expires_at: new Date(Date.now() + LINK_DAYS * 86_400_000).toISOString(),
      reply: null,
    }) }));
    if (dryRun) return sent.map(({ contact }) => contacts.update(contact.id, { sent_at: new Date().toISOString() }));
    let patch;
    try {
      const response = await fetch(`${RESEND}/emails/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(sent.map(({ item, contact }) => ({
          from: env.EMAIL_FROM ?? DEFAULT_FROM, to: [contact.to], ...emailFor(item, `${base}/reply/${contact.token}`),
        }))),
      });
      patch = response.ok ? { sent_at: new Date().toISOString() }
        : { error: `Resend ${response.status}: ${(await response.text()).slice(0, 300)}` };
    } catch (error) {
      patch = { error: `Resend could not be reached: ${error.message}` };
    }
    return sent.map(({ contact }) => contacts.update(contact.id, patch));
  }

  // After an upload: one email for each new or changed open claim that is missing information and was never emailed.
  // Leaves the import alone if it fails: the claims team sees the failure on the Missing information page.
  async function sendAfterImport(caseIds, origin) {
    if (!configured()) return [];
    const items = caseIds.map(findItem).filter((item) => item && canCall(item) && !emailsFor(item.case.case_id).length);
    if (!items.length) return [];
    try {
      return await send(items.slice(0, MAX_AUTO_EMAILS), origin, 'Automatic, after import');
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async function sendOne(request) {
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBytes(request, MAX_JSON_BYTES)));
    } catch {
      throw new EmailError(400, 'Request is not valid JSON.');
    }
    const item = findItem(String(body.case_id ?? ''));
    if (!item) throw new EmailError(404, `Unknown case ${body.case_id}.`);
    if (!canCall(item)) throw new EmailError(400, 'Emails are only for open claims that need more information.');
    const [contact] = await send([item], new URL(request.url).origin, 'Claimly app');
    return json({ contact }, contact.error ? 502 : 201);
  }

  function document(url) {
    const id = url.searchParams.get('id') ?? '';
    const meta = contacts.all().flatMap((contact) => contact.reply?.documents ?? []).find((doc) => doc.id === id);
    const bytes = meta && documents.read(id);
    if (!bytes) return json({ error: 'Unknown document.' }, 404);
    const name = meta.name.replace(/[^\w.-]+/g, '_');
    return new Response(bytes, { headers: {
      'Content-Type': meta.type, 'Content-Disposition': `inline; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    } });
  }

  // The contact behind a link, and what the claimant may still answer. Returns a Response when the form is not shown.
  function open(token) {
    const contact = TOKEN.test(token) ? contacts.all().find((entry) => entry.token === token) : null;
    if (!contact) return { closed: message('Link not valid', 'This link is not valid. Please use the link in your latest email.', 404) };
    if (contact.reply) {
      return { closed: message('Thank you', `We received your answer for claim ${contact.case_id}. A claims handler will be in touch if anything else is needed.`) };
    }
    if (Date.now() > Date.parse(contact.expires_at)) {
      return { closed: message('Link expired', 'This link has expired. Please email claims@claimly.example with your claim number.', 410) };
    }
    const item = findItem(contact.case_id);
    if (!item || !canCall(item)) {
      return { closed: message('Nothing is needed', 'We have everything we need for this claim. Thank you.') };
    }
    return { contact, item, fields: missingFields(item) };
  }

  async function reply(request, token) {
    // Read the whole form before looking at the contact, so two submissions cannot both pass the checks below.
    let form;
    const files = new Map();
    try {
      const bytes = await readBytes(request, MAX_REPLY_BYTES);
      form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type') ?? '' } }).formData();
      for (const [name, value] of form) {
        if (typeof value !== 'string' && value.size) files.set(name, { name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
    } catch (error) {
      const found = open(token);
      if (found.closed) return found.closed;
      return formPage(found.item, found.fields, error instanceof TooLarge
        ? 'The files are too large. Together they can be at most 8 MB.' : 'The form could not be read. Please try again.');
    }
    const found = open(token);
    if (found.closed) return found.closed;
    const { contact, item, fields } = found;

    const answers = {};
    const notes = {};
    const uploads = [];
    for (const field of fields) {
      const value = form.get(field);
      if (DOCUMENTS[field]) {
        const file = files.get(field);
        if (!file) continue;
        const type = fileType(file.bytes);
        if (!type) return formPage(item, fields, `${DOCUMENTS[field]}: please upload a PDF, JPEG or PNG file.`);
        uploads.push({ field, bytes: file.bytes, meta: { id: randomUUID(), field, name: String(file.name || field).slice(0, 120), type, size: file.bytes.length } });
      } else if (field === 'repair_type') {
        if (REPAIR_CHOICES.some(([choice]) => choice === value)) answers.repair_type = value;
        const description = String(form.get('repair_description') ?? '').trim().slice(0, 300);
        if (description) notes.repair_description = description;
      } else {
        const text = String(value ?? '').trim().slice(0, 300);
        if (text) notes[field] = text;
      }
    }
    if (!Object.keys(answers).length && !Object.keys(notes).length && !uploads.length) {
      return formPage(item, fields, 'Please answer at least one question.');
    }

    for (const upload of uploads) documents.save(upload.meta.id, upload.bytes);
    // A clear repair type and an uploaded document fill their fields; free text stays a note for a person.
    const changes = {
      ...(CLEAR_REPAIR.includes(answers.repair_type) ? { repair_type: answers.repair_type } : {}),
      ...Object.fromEntries(uploads.map((upload) => [upload.field, true])),
    };
    const at = new Date().toISOString();
    const applied = Object.keys(changes).length && item.case.case_status === 'open'
      ? { at, changes, before: outcome(item.automated), after: outcome(updateCase(item.case.case_id, changes)) }
      : null;
    contacts.update(contact.id, {
      reply: { at, answers, notes, documents: uploads.map((upload) => upload.meta) }, ...(applied ? { applied } : {}),
    });
    return new Response(null, { status: 303, headers: { Location: `/reply/${token}` } });
  }

  // Returns null for paths that are not ours, so the caller can carry on routing.
  return {
    sendAfterImport,
    async handle(request) {
      const url = new URL(request.url);
      const token = url.pathname.match(/^\/reply\/([^/]+)$/)?.[1];
      if (!token && url.pathname !== '/api/emails' && url.pathname !== '/api/documents') return null;
      try {
        if (token && request.method === 'GET') {
          const found = open(token);
          return found.closed ?? formPage(found.item, found.fields);
        }
        if (token && request.method === 'POST') return await reply(request, token);
        if (request.method === 'POST' && url.pathname === '/api/emails') return await sendOne(request);
        if (request.method === 'GET' && url.pathname === '/api/documents') return document(url);
        return json({ error: 'Not found.' }, 404);
      } catch (error) {
        if (error instanceof EmailError) return json({ error: error.message }, error.status);
        console.error(error);
        return json({ error: 'The server could not complete that request.' }, 500);
      }
    },
  };
}
