import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasAccess, tokenFor } from '../calls/access.js';

test('only the cookie made from the current code gives access', () => {
  assert.equal(hasAccess(`theme=dark; access=${tokenFor('123456')}`, '123456'), true);
  assert.equal(hasAccess(`access=${tokenFor('654321')}`, '123456'), false);
  assert.equal(hasAccess('access=', '123456'), false);
  assert.equal(hasAccess(undefined, '123456'), false);
});
