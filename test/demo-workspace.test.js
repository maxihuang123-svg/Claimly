import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDemoWorkspace } from '../demo-workspace.js';
import { fileImports } from '../storage.js';

const csv = readFileSync(new URL('../demo/practice_cases.csv', import.meta.url), 'utf8');
test('demo preparation replaces data, records v1/v2 validation and survives restart and repeated preparation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-workspace-'));
  const options = {
    logs: Object.fromEntries(['reviews', 'policies', 'validation', 'outcomes', 'contacts'].map((name) => [name, join(dir, `${name}.jsonl`)])),
    imports: fileImports(join(dir, 'imports')), engineVersion: 'test',
  };
  let app = createDemoWorkspace(options, csv);
  const prepare = () => app.handle(new Request('http://localhost/api/demo/prepare', { method: 'POST' }));
  const get = async (path) => (await app.handle(new Request(`http://localhost${path}`))).json();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await prepare()).status, 200);
    app = createDemoWorkspace(options, csv);
    const { cases } = await get('/api/cases');
    assert.equal(cases.length, 12);
    const byId = (id) => cases.find((item) => item.case.case_id === id);
    assert.equal(byId('PRA-002').automated.recommendation, 'routine_processing');
    assert.equal(byId('PRA-003').automated.policy_version, 'v2');
    assert.equal(byId('PRA-003').original_automated.policy_version, 'v1');
    assert.equal(byId('PRA-003').needs_recheck, true);
    assert.ok(cases.filter((item) => item.case.case_status === 'closed').every((item) => !item.needs_recheck && item.automated.policy_version === 'v1'));
    const policies = await get('/api/policies');
    assert.equal(policies.current_version, 'v2');
    assert.equal(policies.policies.length, 2);
    const validation = await get('/api/validation?baseline=v1&candidate=v2');
    assert.ok(validation.run);
    assert.equal(validation.stale, false);
  }
});
