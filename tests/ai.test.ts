import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleTrip } from '../src/domain/fixture';
import { AiRequestSchema, aiContext, projectAiProposal, type AiRequest } from '../src/domain/ai';
import { applyTravel, preconditions } from '../src/domain/travel';
import { AiService } from '../src/server/ai';
import { MockAiProviders } from '../src/server/ai-providers';
import { TripService } from '../src/server/service';
import { FileStorage, ApiError, type Storage } from '../src/server/storage';
import { createApp } from '../src/server/app';
import { hashKey } from '../src/server/auth';

let directory: string, trips: TripService, ai: AiService, providers: MockAiProviders, now: number;
const request = (id = 'job-one', text = 'Siamo in ritardo di 30 minuti'): AiRequest =>
  AiRequestSchema.parse({ id, dayId: 'day-one', stepId: 'square', text });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passo-ai-'));
  trips = new TripService(new FileStorage(directory));
  await trips.create('example-trip', exampleTrip().plan);
  now = Date.now();
  providers = new MockAiProviders();
  ai = new AiService(trips, providers, () => now, 100);
  await ai.budget.configure(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function ready(input = request()) {
  const current = await trips.read('example-trip');
  let job = await ai.create('example-trip', input, current.etag);
  for (let i = 0; i < 10 && ['queued', 'planning', 'routing'].includes(job.status); i++)
    job = await ai.advance('example-trip', job.id);
  return job;
}

describe('AI context, proposals and durable stages', () => {
  it('excludes personal names, booking references, tickets and shared notes from provider context', async () => {
    const value = await trips.read('example-trip');
    value.trip.plan.travellers[0].name = 'SECRET_PERSON';
    value.trip.state.reservations.push({
      id: 'booking-one',
      stepId: 'museum',
      title: 'SECRET_BOOKING_TITLE',
      travellerIds: ['traveller-one'],
      status: 'booked',
      reference: 'SECRET_REFERENCE',
      notes: 'SECRET_BOOKING_NOTES',
    });
    value.trip.state.tickets.push({
      id: 'ticket-one',
      stepId: 'museum',
      title: 'SECRET_QR',
      filename: 'SECRET_FILE.pdf',
      pathname: 'tickets/example-trip/ticket-one/SECRET_PATH.pdf',
      travellerIds: ['traveller-one'],
      contentType: 'application/pdf',
      size: 5,
      status: 'ready',
      uploadedAt: new Date().toISOString(),
    });
    const withNotes = applyTravel(value.trip, {
      id: 'private-note',
      action: { type: 'note', targetId: 'square', text: 'SECRET_NOTE' },
      routes: [],
      expected: preconditions(value.trip, {
        type: 'note',
        targetId: 'square',
        text: 'SECRET_NOTE',
      }),
      at: new Date().toISOString(),
    });
    const context = JSON.stringify(aiContext(withNotes, request()));
    expect(context).not.toContain('SECRET_');
    expect(context).toContain('"booked":true');
  });
  it('creates a reviewable preview without changing the trip, and applies/undoes the batch atomically', async () => {
    const original = await trips.read('example-trip');
    const job = await ready();
    expect(job.status).toBe('ready');
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    const proposal = job.proposals[0];
    const saved = await ai.apply('example-trip', proposal.id, proposal.previewHash, original.etag);
    expect(saved.trip.revision).toBe(original.trip.revision + 1);
    expect(saved.trip.travel!.history).toHaveLength(1);
    expect(saved.trip.travel!.appliedIds).toEqual([proposal.id]);
    expect(
      Date.parse(saved.trip.plan.steps[0].start) - Date.parse(original.trip.plan.steps[0].start),
    ).toBe(30 * 60000);
    const undo = { type: 'undo' as const, historyId: proposal.id };
    const undone = applyTravel(saved.trip, {
      id: 'undo-ai',
      action: undo,
      routes: [],
      expected: preconditions(saved.trip, undo),
      at: new Date().toISOString(),
    });
    expect(undone.plan).toEqual(original.trip.plan);
  });
  it('includes a manual draft and model changes in one approval and one history item', async () => {
    const original = await trips.read('example-trip');
    const action = { type: 'delay' as const, dayId: 'day-one', stepId: 'square', minutes: 15 };
    const input = {
      ...request(),
      draft: {
        id: 'manual-draft',
        action,
        routes: [],
        expected: preconditions(original.trip, action),
        at: new Date().toISOString(),
      },
    };
    const job = await ready(input);
    expect(job.status).toBe('ready');
    expect(job.proposals[0].commands).toHaveLength(2);
    const saved = await ai.apply(
      'example-trip',
      job.proposals[0].id,
      job.proposals[0].previewHash,
      original.etag,
    );
    expect(
      Date.parse(saved.trip.plan.steps[0].start) - Date.parse(original.trip.plan.steps[0].start),
    ).toBe(45 * 60000);
    expect(saved.trip.travel!.history).toHaveLength(1);
  });
  it('deduplicates creates, concurrent advances and repeated applies', async () => {
    const current = await trips.read('example-trip');
    const plan = vi.spyOn(providers, 'plan');
    await Promise.all([
      ai.create('example-trip', request(), current.etag),
      ai.create('example-trip', request(), current.etag),
    ]);
    await Promise.all([
      ai.advance('example-trip', 'job-one'),
      ai.advance('example-trip', 'job-one'),
    ]);
    expect(plan).toHaveBeenCalledTimes(1);
    const job = await ai.advance('example-trip', 'job-one');
    const proposal = job.proposals[0];
    const results = await Promise.all([
      ai.apply('example-trip', proposal.id, proposal.previewHash, current.etag),
      ai.apply('example-trip', proposal.id, proposal.previewHash, current.etag),
    ]);
    expect(results[0].etag).toBe(results[1].etag);
    const retry = await ai.apply('example-trip', proposal.id, proposal.previewHash, current.etag);
    expect(retry.trip.revision).toBe(current.trip.revision + 1);
    await expect(
      ai.create('example-trip', request('job-one', 'Testo diverso'), current.etag),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('checks the preview hash, current ETag, expiry and trip ownership before applying', async () => {
    const original = await trips.read('example-trip');
    const job = await ready();
    const proposal = job.proposals[0];
    await expect(
      ai.apply('example-trip', proposal.id, '0'.repeat(64), original.etag),
    ).rejects.toMatchObject({ status: 409 });
    await expect(ai.get('other-trip', job.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      ai.apply('other-trip', proposal.id, proposal.previewHash, original.etag),
    ).rejects.toMatchObject({ status: 404 });
    const changed = await trips.mutate('example-trip', original.etag, (d) => {
      d.state.taskCompletion['book-museum'] = true;
    });
    await expect(
      ai.apply('example-trip', proposal.id, proposal.previewHash, changed.etag),
    ).rejects.toMatchObject({ status: 412 });
    now += 31 * 60000;
    await expect(
      ai.apply('example-trip', proposal.id, proposal.previewHash, changed.etag),
    ).rejects.toMatchObject({ status: 409 });
    expect((await trips.read('example-trip')).etag).toBe(changed.etag);
  });
  it('restarts only the next saved stage after a service restart; GETs never dispatch', async () => {
    const current = await trips.read('example-trip');
    const plan = vi.spyOn(providers, 'plan');
    await ai.create('example-trip', request(), current.etag);
    for (let i = 0; i < 5; i++) await ai.get('example-trip', 'job-one');
    expect(plan).not.toHaveBeenCalled();
    await ai.advance('example-trip', 'job-one');
    const restarted = new AiService(new TripService(new FileStorage(directory)), providers);
    expect((await restarted.advance('example-trip', 'job-one')).status).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(1);
  });
  it('cancels before dispatch and never retries an ambiguous provider timeout', async () => {
    const current = await trips.read('example-trip');
    const plan = vi.spyOn(providers, 'plan');
    await ai.create('example-trip', request(), current.etag);
    await ai.cancel('example-trip', 'job-one');
    expect((await ai.advance('example-trip', 'job-one')).status).toBe('cancelled');
    expect(plan).not.toHaveBeenCalled();
    plan.mockImplementation(() => new Promise(() => {}));
    await ai.create('example-trip', request('job-two'), current.etag);
    expect((await ai.advance('example-trip', 'job-two')).status).toBe('uncertain');
    await ai.advance('example-trip', 'job-two');
    expect(plan).toHaveBeenCalledTimes(1);
    expect((await ai.budget.status()).active).toBe(1);
    expect((await trips.read('example-trip')).etag).toBe(current.etag);
  });
  it('rejects model attempts to edit completed or booked activities, including downstream bookings without slots', async () => {
    const original = await trips.read('example-trip');
    const current = await trips.mutate('example-trip', original.etag, (d) => {
      d.state.reservations.push({
        id: 'booking',
        stepId: 'museum',
        title: 'Booked',
        travellerIds: ['traveller-one'],
        status: 'booked',
        reference: '',
        notes: '',
      });
    });
    const job = await ready();
    expect(job.status).toBe('failed');
    expect(job.message).toContain('prenotata');
    expect((await trips.read('example-trip')).etag).toBe(current.etag);
    const jobTwo = await ready({ ...request('job-two'), stepId: 'museum' });
    expect(jobTwo.status).toBe('failed');
    const changed = await trips.mutate('example-trip', current.etag, (d) => {
      d.state.progress.square = 'done';
    });
    expect((await ready(request('job-three'))).status).toBe('failed');
    expect((await trips.read('example-trip')).etag).toBe(changed.etag);
  });
  it('enriches routes with existing streets and POIs and separates walking from dwell time', async () => {
    const original = await trips.read('example-trip');
    const route = vi.spyOn(providers, 'route');
    route.mockImplementation(async (query) => {
      const value = await MockAiProviders.prototype.route.call(
        new MockAiProviders(),
        query,
        original.trip,
      );
      value.value.pois[0].visitMinutes = 5;
      return value;
    });
    const job = await ready(request('job-route', 'Rivedi i percorsi e i luoghi'));
    expect(job.status).toBe('ready');
    const proposal = job.proposals[0];
    const preview = projectAiProposal(original.trip, proposal);
    const leg = preview.plan.steps.find((s) => s.id === 'walk');
    expect(leg).toMatchObject({
      kind: 'leg',
      durationMinutes: 20,
      streets: ['Via dei Giardini'],
      estimate: true,
      pois: [{ placeId: 'blue-garden', visitMinutes: 5 }],
    });
    expect(proposal.routes[0].durationMinutes).toBe(15);
    expect(route).toHaveBeenCalledTimes(1);
  });
  it('keeps the atomic apply marker authoritative if the job metadata write fails', async () => {
    const original = await trips.read('example-trip');
    const job = await ready();
    const proposal = job.proposals[0];
    const write = trips.store.write.bind(trips.store);
    let metadataWrites = 0;
    vi.spyOn(trips.store, 'write').mockImplementation(async (path, body, expected, contentType) => {
      if (path === 'ai/jobs/job-one.json' && ++metadataWrites > 1)
        throw new Error('metadata unavailable after commit');
      return write(path, body, expected, contentType);
    });
    const saved = await ai.apply('example-trip', proposal.id, proposal.previewHash, original.etag);
    const retry = await ai.apply('example-trip', proposal.id, proposal.previewHash, original.etag);
    expect(saved.etag).toBe(retry.etag);
    expect(retry.trip.revision).toBe(original.trip.revision + 1);
  });
  it('fails before a provider call when the stage claim cannot be stored', async () => {
    const current = await trips.read('example-trip');
    const plan = vi.spyOn(providers, 'plan');
    await ai.create('example-trip', request(), current.etag);
    const actual = trips.store;
    const broken: Storage = {
      read: actual.read.bind(actual),
      list: actual.list.bind(actual),
      remove: actual.remove.bind(actual),
      stream: actual.stream.bind(actual),
      write: async () => {
        throw new Error('offline storage');
      },
    };
    const failing = new AiService(new TripService(broken), providers);
    await expect(failing.advance('example-trip', 'job-one')).rejects.toThrow('offline storage');
    expect(plan).not.toHaveBeenCalled();
  });
});

describe('AI API capability separation', () => {
  it('protects every AI route and requires a separate operator credential to alter spending', async () => {
    vi.stubEnv('APP_ACCESS_KEY_HASH', hashKey('family-key'));
    vi.stubEnv('AGENT_API_TOKEN_HASH', hashKey('agent-key'));
    vi.stubEnv('AI_ADMIN_TOKEN_HASH', hashKey('operator-key'));
    vi.stubEnv('SESSION_SECRET', 'test-secret-more-than-thirty-two-characters');
    const app = createApp(trips, ai);
    const paths = [
      '/trips/example-trip/ai/requests',
      '/trips/example-trip/ai/requests/job-one',
      '/trips/example-trip/ai/proposals/missing/apply',
      '/ai/admin/status',
    ];
    for (const path of paths)
      expect((await app.request(`http://localhost/api/v2${path}`)).status).toBe(401);
    const admin = (token: string, body?: unknown) =>
      app.request('http://localhost/api/v2/ai/admin/configure', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? { enabled: false }),
      });
    expect((await admin('agent-key')).status).toBe(401);
    expect((await admin('family-key')).status).toBe(401);
    expect((await admin('operator-key', { enabled: false, model: 'changed' })).status).toBe(422);
    expect((await admin('operator-key')).status).toBe(200);
    expect((await ai.budget.status()).enabled).toBe(false);
    expect(
      (
        await app.request('http://localhost/api/v2/trips', {
          headers: { Authorization: 'Bearer operator-key' },
        })
      ).status,
    ).toBe(401);
    const session = await app.request('http://localhost/api/v2/session', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: '{"key":"family-key"}',
    });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const original = await trips.read('example-trip');
    expect(
      (
        await app.request('http://localhost/api/v2/trips/example-trip/ai/requests', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
            'X-Trip-Version': original.etag,
          },
          body: JSON.stringify(request()),
        })
      ).status,
    ).toBe(403);
    await ai.budget.configure(true);
    const made = await app.request('http://localhost/api/v2/trips/example-trip/ai/requests', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
        'X-Trip-Version': original.etag,
      },
      body: JSON.stringify({ ...request(), budget: 100000 }),
    });
    expect(made.status).toBe(422);
    vi.stubEnv('TRAVEL_EDITING_ENABLED', 'false');
    expect(
      (
        await app.request('http://localhost/api/v2/trips/example-trip/ai/requests', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'http://localhost',
            'Content-Type': 'application/json',
            'X-Trip-Version': original.etag,
          },
          body: JSON.stringify(request()),
        })
      ).status,
    ).toBe(403);
  });
  it('leaves AI off when unconfigured and never infers provider access from a browser session', async () => {
    const offlineAi = new AiService(trips, undefined);
    expect(await offlineAi.availability()).toEqual({ enabled: false, mode: 'off' });
    const current = await trips.read('example-trip');
    await expect(offlineAi.create('example-trip', request(), current.etag)).rejects.toBeInstanceOf(
      ApiError,
    );
    expect((await offlineAi.budget.read()).ledger.runs).toHaveLength(0);
  });
});
