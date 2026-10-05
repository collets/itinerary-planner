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
import { SignJWT } from 'jose';
import { PlanSchema } from '../src/domain/schema';
import * as blob from '@vercel/blob';
import * as blobClient from '@vercel/blob/client';
vi.mock('@vercel/blob', async (original) => {
  const actual = await original<typeof import('@vercel/blob')>();
  return { ...actual, issueSignedToken: vi.fn(actual.issueSignedToken) };
});
vi.mock('@vercel/blob/client', async (original) => {
  const actual = await original<typeof import('@vercel/blob/client')>();
  return { ...actual, handleUploadPresigned: vi.fn(actual.handleUploadPresigned) };
});
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
      ...(etag ? { 'X-Trip-Version': etag } : {}),
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('private API and edits', () => {
  it('keeps private routes protected in both API versions and rejects forged credentials', async () => {
    const routes = [
      '/trips',
      '/config',
      '/openapi.json',
      '/trips/example-trip',
      '/trips/example-trip/plan',
      '/trips/example-trip/history',
      '/trips/example-trip/travel/history',
      '/trips/example-trip/tickets/missing/file',
    ];
    for (const version of ['v1', 'v2'])
      for (const path of routes)
        expect((await app.request(`http://localhost/api/${version}${path}`)).status).toBe(401);
    const forgedHeaders: Record<string, string>[] = [
      { Cookie: 'passo_session=forged' },
      { Authorization: 'Bearer wrong' },
      { Authorization: 'Bearer test-browser-key' },
    ];
    for (const headers of forgedHeaders)
      expect((await app.request('http://localhost/api/v2/trips', { headers })).status).toBe(401);
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(hashKey(key))
      .setIssuer('passo')
      .setAudience('passo-browser')
      .setExpirationTime(1)
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    expect(
      (
        await app.request('http://localhost/api/v2/trips', {
          headers: { Cookie: `passo_session=${expired}` },
        })
      ).status,
    ).toBe(401);
    const loggedIn = await call('/api/v2/session', 'POST', { key }, undefined, {
      Origin: 'http://localhost',
    });
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
    for (const origin of [undefined, 'https://evil.example', 'null']) {
      const response = await app.request(
        'http://localhost/api/v2/trips/example-trip/tasks/book-museum',
        {
          method: 'PATCH',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
          },
          body: '{"done":true}',
        },
      );
      expect(response.status).toBe(403);
    }
    vi.stubEnv('APP_ACCESS_KEY_HASH', hashKey('rotated-key'));
    expect(
      (await app.request('http://localhost/api/v2/trips', { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });
  it('authenticates before parsing private bodies and bounds actual bytes despite dishonest lengths', async () => {
    const read = vi.spyOn(service, 'read');
    expect(
      (
        await app.request('http://localhost/api/v2/trips/example-trip/tickets/missing/file', {
          method: 'PUT',
          body: new Uint8Array(100000),
        })
      ).status,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const oversized = JSON.stringify({ key: 'x'.repeat(2048) });
    expect(
      (
        await app.request('http://localhost/api/v2/session', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            'Content-Type': 'application/json',
            'Content-Length': '1',
          },
          body: oversized,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call('/api/v2/trips/example-trip/tasks/book-museum', 'PATCH', {
          done: true,
          padding: 'x'.repeat(65536),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await app.request('http://localhost/api/v2/trips', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request('http://localhost/api/v2/trips', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400);
  });
  it('throttles repeated login attempts without accessing storage', async () => {
    const read = vi.spyOn(service, 'read');
    for (let i = 0; i < 20; i++)
      expect(
        (
          await call('/api/v2/session', 'POST', { key: 'wrong' }, undefined, {
            Origin: 'http://localhost',
          })
        ).status,
      ).toBe(401);
    const blocked = await call('/api/v1/session', 'POST', { key }, undefined, {
      Origin: 'http://localhost',
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated upload tokens and unsigned completion callbacks', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'blob');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test_test');
    const finalize = vi.spyOn(service, 'finalize');
    const read = vi.spyOn(service, 'read');
    const request = (body: unknown, headers = {}) =>
      app.request('http://localhost/api/v2/uploads/blob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (
        await request({
          type: 'blob.generate-client-token',
          payload: { pathname: 'tickets/example-trip/unknown/original.pdf' },
        })
      ).status,
    ).toBe(401);
    expect((await request({ type: 'unexpected' })).status).toBe(400);
    expect(
      (await request({ type: 'blob.upload-completed', payload: {} })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await request(
          { type: 'blob.upload-completed', payload: {} },
          { 'x-vercel-signature': '00'.repeat(32) },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(finalize).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects filesystem escape paths and excessive catalog sizes', async () => {
    const store = new FileStorage(directory);
    for (const path of ['/tmp/outside', '../outside', 'trips/../../outside'])
      await expect(store.read(path)).rejects.toMatchObject({ status: 400 });
    const plan = exampleTrip().plan;
    plan.steps = Array.from({ length: 2001 }, () => plan.steps[0]);
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });
  it('scopes OIDC upload delegation to one pending ticket and rejects alternate paths', async () => {
    vi.stubEnv('STORAGE_DRIVER', 'blob');
    vi.stubEnv('BLOB_STORE_ID', 'store_test');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    const value = await service.read('example-trip');
    const made = await call(
      '/api/v2/trips/example-trip/tickets',
      'POST',
      {
        title: 'Test',
        filename: 'test.pdf',
        stepId: 'museum',
        travellerIds: ['traveller-one'],
        contentType: 'application/pdf',
        size: 128,
      },
      value.etag,
    );
    const ticket = (await made.json()).trip.state.tickets[0];
    const issue = vi.mocked(blob.issueSignedToken).mockResolvedValue({
      delegationToken: 'test',
      clientSigningToken: 'test',
      validUntil: Date.now() + 600000,
    });
    vi.mocked(blobClient.handleUploadPresigned).mockImplementation(async (options) => {
      if (options.body.type !== 'blob.generate-presigned-url') throw new Error('Unexpected event');
      await options.getSignedToken(
        options.body.payload.pathname,
        options.body.payload.clientPayload,
        false,
      );
      return { type: 'blob.upload-completed', response: 'ok' };
    });
    const event = (pathname: string) => ({
      type: 'blob.generate-presigned-url',
      payload: {
        pathname,
        clientPayload: JSON.stringify({ tripId: 'example-trip', ticketId: ticket.id }),
        multipart: false,
      },
    });
    expect(
      (
        await call(
          '/api/v2/uploads/blob',
          'POST',
          event('tickets/example-trip/another/original.pdf'),
        )
      ).status,
    ).toBe(403);
    expect(issue).not.toHaveBeenCalled();
    expect((await call('/api/v2/uploads/blob', 'POST', event(ticket.pathname))).status).toBe(200);
    expect(issue).toHaveBeenCalledWith({
      pathname: ticket.pathname,
      operations: ['put'],
      allowedContentTypes: ['application/pdf'],
      maximumSizeInBytes: 128,
      validUntil: expect.any(Number),
    });
    expect(issue.mock.calls[0][0].validUntil! - Date.now()).toBeLessThanOrEqual(600000);
    expect((await call('/api/v2/config')).status).toBe(200);
    expect((await (await call('/api/v2/config')).json()).presignedUploads).toBe(true);
  });
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
    const success = responses.find((r) => r.status === 200)!;
    expect(success.headers.get('etag')).toBeNull();
    const updated = await success.json();
    expect(updated.etag).not.toBe(value.etag);
    expect(updated.etag).toBe((await service.read('example-trip')).etag);
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

describe('version 2 travel API', () => {
  it('allows authenticated browser previews, commits with CAS and deduplicates retries', async () => {
    const { preconditions } = await import('../src/domain/travel');
    const initial = await service.read('example-trip');
    const action = { type: 'delay' as const, dayId: 'day-one', stepId: 'square', minutes: 30 };
    const command = {
      id: crypto.randomUUID(),
      action,
      routes: [],
      expected: preconditions(initial.trip, action),
      at: new Date().toISOString(),
    };
    const session = await call('/api/v2/session', 'POST', { key }, undefined, {
      Origin: 'http://localhost',
    });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const browser = (operation: string, etag?: string) =>
      app.request(`http://localhost/api/v2/trips/example-trip/travel/${operation}`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
          ...(etag ? { 'X-Trip-Version': etag } : {}),
        },
        body: JSON.stringify(command),
      });
    expect((await browser('preview')).status).toBe(200);
    expect((await service.read('example-trip')).etag).toBe(initial.etag);
    expect((await browser('apply')).status).toBe(428);
    const saved = await browser('apply', initial.etag);
    expect(saved.status).toBe(200);
    const result = await saved.json();
    expect(result.trip.schemaVersion).toBe('2');
    const retry = await browser('apply', initial.etag);
    expect(retry.status).toBe(200);
    expect((await retry.json()).etag).toBe(result.etag);
    expect((await call('/api/v1/trips/example-trip')).status).toBe(426);
    expect(
      (
        await call('/api/v1/trips/example-trip', 'GET', undefined, undefined, {
          'x-passo-api-version': '2',
        })
      ).status,
    ).toBe(426);
    expect((await call('/api/v2/trips/example-trip/travel/original')).status).toBe(200);
    expect((await call('/api/v2/trips/example-trip/travel/history')).status).toBe(200);
  });
  it('merges an independent note, refuses a stale day, and keeps data readable when editing is disabled', async () => {
    const { preconditions } = await import('../src/domain/travel');
    const original = await service.read('example-trip');
    const delay = { type: 'delay' as const, dayId: 'day-one', stepId: 'square', minutes: 15 };
    const make = (action: Parameters<typeof preconditions>[1]) => ({
      id: crypto.randomUUID(),
      action,
      routes: [],
      expected: preconditions(original.trip, action),
      at: new Date().toISOString(),
    });
    const saved = await service.travel(
      'example-trip',
      make({ type: 'note', targetId: 'square', text: 'Coffee' }),
      original.etag,
    );
    const committed = await call(
      '/api/v2/trips/example-trip/travel/apply',
      'POST',
      make(delay),
      saved.etag,
    );
    expect(committed.status).toBe(200);
    const current = await committed.json();
    const conflicted = await call(
      '/api/v2/trips/example-trip/travel/apply',
      'POST',
      make(delay),
      current.etag,
    );
    expect(conflicted.status).toBe(409);
    vi.stubEnv('TRAVEL_EDITING_ENABLED', 'false');
    expect(
      (await call('/api/v2/trips/example-trip/travel/apply', 'POST', make(delay), current.etag))
        .status,
    ).toBe(403);
    expect((await call('/api/v2/trips/example-trip')).status).toBe(200);
  });
});
