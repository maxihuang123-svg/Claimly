import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessGate, hasAccess, spaceOf, tokenFor } from '../calls/access.js';

test('only the cookie made from the current code gives access', () => {
  assert.equal(hasAccess(`theme=dark; access=${tokenFor('123456')}`, '123456'), true);
  assert.equal(hasAccess(`access=${tokenFor('654321')}`, '123456'), false);
  assert.equal(hasAccess('access=', '123456'), false);
  assert.equal(hasAccess(undefined, '123456'), false);
});

test('two codes open two copies, and a code in the link logs in or switches copy', async () => {
  const codes = { main: '123456', judges: 'jury-2026' };
  assert.equal(spaceOf(`access=${tokenFor('123456')}`, codes), 'main');
  assert.equal(spaceOf(`access=${tokenFor('jury-2026')}`, codes), 'judges');
  assert.equal(spaceOf(`access=${tokenFor('000000')}`, codes), null);

  const gate = accessGate(codes);
  const linked = await gate(new Request('https://claimly.test/?code=jury-2026', { headers: { cookie: `access=${tokenFor('123456')}` } }));
  assert.equal(linked.status, 303);
  assert.match(linked.headers.get('set-cookie'), new RegExp(`access=${tokenFor('jury-2026')};`));
  assert.equal((await gate(new Request('https://claimly.test/?code=wrong'))).status, 401);
  assert.equal(await gate(new Request('https://claimly.test/api/cases', { headers: { cookie: `access=${tokenFor('jury-2026')}` } })), null);
});
