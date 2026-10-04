import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, openapi } from '../src/server/app';
import { TripService } from '../src/server/service';
import { FileStorage } from '../src/server/storage';
import { hashKey } from '../src/server/auth';
import { exampleTrip } from '../src/domain/fixture';
import { exchangeRate } from '../src/server/rates';
let directory: string, service: TripService, app: ReturnType<typeof createApp>;
const token = 'test-agent-token',
  key = 'test-browser-key';
const call = (
  path: string,
  method = 'GET',
  body?: unknown,
  etag?: string,
  extra: Record<string, string> = {},
) =>
  app.request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passo-test-'));
  vi.stubEnv('APP_ACCESS_KEY_HASH', hashKey(key));
  vi.stubEnv('AGENT_API_TOKEN_HASH', hashKey(token));
  vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-thirty-two-characters');
  vi.stubEnv('STORAGE_DRIVER', 'file');
  service = new TripService(new FileStorage(directory));
  app = createApp(service);
  await service.create('example-trip', exampleTrip().plan);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('private API and edits', () => {
  it('blocks unauthenticated reads and cross-origin login, issues HttpOnly sessions', async () => {
    expect((await app.request('http://localhost/api/v1/trips')).status).toBe(401);
    expect(
      (
        await call('/api/v1/session', 'POST', { key }, undefined, {
          Origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    const response = await call('/api/v1/session', 'POST', { key }, undefined, {
      Origin: 'http://localhost',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const read = await app.request('http://localhost/api/v1/trips', {
      headers: { Cookie: cookie },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    const plan = await app.request('http://localhost/api/v1/trips/example-trip/plan', {
      method: 'PUT',
      headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify(exampleTrip().plan),
    });
    expect(plan.status).toBe(403);
  });
  it('requires ETags and permits only one concurrent write', async () => {
    const value = await service.read('example-trip');
    expect(
      (await call('/api/v1/trips/example-trip/tasks/book-museum', 'PATCH', { done: true })).status,
    ).toBe(428);
    const responses = await Promise.all([
      call('/api/v1/trips/example-trip/tasks/book-museum', 'PATCH', { done: true }, value.etag),
      call('/api/v1/trips/example-trip/progress/square', 'PATCH', { status: 'done' }, value.etag),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
  });
  it('preserves live state on plan edit and restores only the plan', async () => {
    let value = await service.read('example-trip');
    value = await service.mutate('example-trip', value.etag, (d) => {
      d.state.progress.square = 'done';
    });
    const plan = structuredClone(value.trip.plan);
    plan.title = 'A new title';
    const edit = await call('/api/v1/trips/example-trip/plan', 'PUT', plan, value.etag);
    expect(edit.status).toBe(200);
    const edited = await edit.json();
    expect(edited.trip.state.progress.square).toBe('done');
    const restore = await call(
      `/api/v1/trips/example-trip/restore/${value.trip.revision}`,
      'POST',
      {},
      edited.etag,
    );
    expect(restore.status).toBe(200);
    const restored = await restore.json();
    expect(restored.trip.plan.title).toBe(value.trip.plan.title);
    expect(restored.trip.state.progress.square).toBe('done');
  });
  it('supports plan patches, dry runs and rejects prototype writes', async () => {
    const value = await service.read('example-trip');
    const preview = await call(
      '/api/v1/trips/example-trip/plan?dryRun=true',
      'PUT',
      { ...value.trip.plan, title: 'Preview' },
      value.etag,
    );
    expect(preview.status).toBe(200);
    expect((await service.read('example-trip')).etag).toBe(value.etag);
    const bad = await call(
      '/api/v1/trips/example-trip/plan',
      'PATCH',
      [{ op: 'add', path: '/__proto__/polluted', value: true }],
      value.etag,
    );
    expect(bad.status).toBe(422);
    const good = await call(
      '/api/v1/trips/example-trip/plan',
      'PATCH',
      [{ op: 'replace', path: '/title', value: 'Patched' }],
      value.etag,
    );
    expect(good.status).toBe(200);
  });
  it('validates file contents, serves original bytes privately and protects attached steps', async () => {
    const bytes = await readFile('public/icon-192.png');
    let value = await service.read('example-trip');
    const created = await call(
      '/api/v1/trips/example-trip/tickets',
      'POST',
      {
        title: 'Ingresso',
        filename: 'biglietto.png',
        stepId: 'museum',
        travellerIds: ['traveller-one'],
        size: bytes.length,
        contentType: 'image/png',
      },
      value.etag,
    );
    expect(created.status).toBe(200);
    const data = await created.json(),
      ticket = data.trip.state.tickets[0];
    const uploaded = await app.request(
      `http://localhost/api/v1/trips/example-trip/tickets/${ticket.id}/file`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: bytes },
    );
    expect(uploaded.status).toBe(200);
    const download = await call(`/api/v1/trips/example-trip/tickets/${ticket.id}/file`);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    expect(
      (await app.request(`http://localhost/api/v1/trips/example-trip/tickets/${ticket.id}/file`))
        .status,
    ).toBe(401);
    value = await service.read('example-trip');
    const removed = structuredClone(value.trip.plan);
    removed.steps = removed.steps.filter((s) => s.id !== 'museum');
    removed.days[0].stepIds.pop();
    removed.costs = [];
    removed.tasks = [];
    expect((await call('/api/v1/trips/example-trip/plan', 'PUT', removed, value.etag)).status).toBe(
      422,
    );
  });
  it('rejects disguised executable files', async () => {
    const value = await service.read('example-trip');
    const made = await call(
      '/api/v1/trips/example-trip/tickets',
      'POST',
      {
        title: 'Fake',
        filename: 'fake.pdf',
        stepId: 'museum',
        travellerIds: ['traveller-one'],
        size: 6,
        contentType: 'application/pdf',
      },
      value.etag,
    );
    const ticket = (await made.json()).trip.state.tickets[0];
    const response = await app.request(
      `http://localhost/api/v1/trips/example-trip/tickets/${ticket.id}/file`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: '<html>' },
    );
    expect(response.status).toBe(400);
    expect(await service.store.read(ticket.pathname)).toBeNull();
  });
  it('returns a machine-readable schema', () => {
    expect(openapi().components.schemas.Plan).toHaveProperty('properties');
    expect(openapi().paths).toHaveProperty('/trips/{id}/plan');
  });
});
describe('euro exchange rates', () => {
  it('uses ECB data, caches for 24 hours and falls back to the dated rate on outage', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ date: '2026-10-02', base: 'PLN', quote: 'EUR', rate: 0.234 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const rate = await exchangeRate('PLN', service.store);
    expect(rate.euroPerUnit).toBe(0.234);
    expect(rate.source).toContain('/providers/ecb/');
    await exchangeRate('PLN', service.store);
    expect(fetch).toHaveBeenCalledTimes(1);
    const stored = await service.store.read('rates/pln.json');
    await service.store.write(
      'rates/pln.json',
      new TextEncoder().encode(JSON.stringify({ ...rate, fetchedAt: '2020-01-01T00:00:00Z' })),
      stored!.etag,
    );
    fetch.mockRejectedValue(new Error('Offline'));
    expect((await exchangeRate('PLN', service.store)).asOf).toBe('2026-10-02');
  });
});
