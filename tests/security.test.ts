import { Hono } from 'hono';
import { it, expect } from 'vitest';
import { createThrottle } from '../src/server/security';
import { ApiError } from '../src/server/storage';

it('resets throttle windows and keeps unrelated limits separate', async () => {
  let now = 1000;
  const throttle = createThrottle(() => now);
  const app = new Hono();
  app.onError((e, c) =>
    e instanceof ApiError ? c.json({ error: e.message }, 429) : c.json({}, 500),
  );
  app.get('/login', (c) => {
    throttle(c, 'login', 1);
    return c.json({ ok: true });
  });
  app.get('/rates', (c) => {
    throttle(c, 'rates', 1);
    return c.json({ ok: true });
  });
  expect((await app.request('/login')).status).toBe(200);
  expect((await app.request('/login')).status).toBe(429);
  expect((await app.request('/rates')).status).toBe(200);
  now += 60000;
  expect((await app.request('/login')).status).toBe(200);
});
