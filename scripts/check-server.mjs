import assert from 'node:assert/strict';
// Execute emitted JavaScript with Node's native ESM loader, without tsx or Vite.
// This catches production module-resolution failures before deployment.
import api from '../.server-build/api/index.js';
import { createApp } from '../.server-build/src/server/app.js';
import { hashKey } from '../.server-build/src/server/auth.js';

assert.equal(typeof api, 'function');
process.env.APP_ACCESS_KEY_HASH = hashKey('server-build-test-key');
process.env.SESSION_SECRET = 'server-build-test-session-secret-at-least-thirty-two';
const app = createApp();
const origin = 'https://trip.example';
const health = await app.request(`${origin}/api/v1/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true });
const login = await app.request(`${origin}/api/v1/session`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'server-build-test-key' }),
});
assert.equal(login.status, 200);
assert.match(login.headers.get('set-cookie'), /HttpOnly/);
assert.match(login.headers.get('set-cookie'), /Secure/);
console.log('Native Node server check passed: imports, health, secure login.');
