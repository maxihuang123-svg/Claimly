import { createApp } from './handler.js';
import { POLICY_V2 } from './policies.js';
import { asLog } from './storage.js';

const SEED = '000-demo.v1.csv';

// The seed import is also the durable marker: restarting preserves the prepared workspace.
export function createDemoWorkspace(options, demoCases) {
  let app;
  function open() {
    const prepared = options.imports.list().some(({ name }) => name === SEED);
    app = createApp({ ...options, ...(prepared ? {
      baseCases: null, startPolicies: [POLICY_V2], env: { ...options.env, EMAIL_DRY_RUN: 'true' },
    } : {}) });
  }
  open();
  return {
    get items() { return app.items; },
    get policies() { return app.policies; },
    async handle(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/demo/prepare') return app.handle(request);
      for (const target of Object.values(options.logs)) asLog(target).clear();
      options.imports.clear();
      options.imports.save(SEED, demoCases);
      open();
      // Record the v1/v2 comparison and rerun the labelled tests under v2.
      const result = await app.handle(new Request('http://internal/api/validation/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseline: 'v1', candidate: 'v2', reviewer: 'Demo preparation' }),
      }));
      if (!result.ok) return result;
      return new Response(JSON.stringify({ prepared: true, cases: app.items.size, policy_version: app.policies.current.version }),
        { headers: { 'Content-Type': 'application/json' } });
    },
  };
}
