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
import evaluationCases from './fixtures/ai-evaluation.json';

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
  it('diagnoses contract fields without logging model values, private keys or error messages', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(providers, 'plan').mockResolvedValue({
      actualCost: 0,
      value: {
        message: 'SECRET model response',
        clarification: null,
        options: [],
        lookups: [{ name: 'https://SECRET', area: 'Cracovia' }],
      },
    });
    const before = await trips.read('example-trip');
    const job = await ready(request('invalid-place-contract', 'Aggiungi un castello'));
    expect(job.status).toBe('failed');
    expect(warn).toHaveBeenCalledWith('AI contract rejected', {
      stage: 'model',
      issues: [{ code: 'invalid_format', path: 'lookups.item.name' }],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect((await trips.read('example-trip')).etag).toBe(before.etag);
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0 });
  });
  it('stops after one lookup round even if the model requests another search', async () => {
    const plan = vi.spyOn(providers, 'plan').mockResolvedValue({
      actualCost: 0,
      value: {
        message: 'Cerco.',
        clarification: null,
        options: [],
        lookups: [{ name: 'Wawel', area: 'Cracovia' }],
      },
    });
    const lookup = vi.spyOn(providers, 'lookup');
    const before = await trips.read('example-trip');
    const job = await ready(request('no-search-loop', 'Aggiungi Wawel'));
    expect(job.status).toBe('failed');
    expect(job.message).toContain('ricerca disponibile è terminata');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledOnce();
    expect((await trips.read('example-trip')).etag).toBe(before.etag);
    expect((await ai.budget.status()).reserved).toBe(0);
  });
  it('refuses the second model call when the settled first charge leaves insufficient request budget', async () => {
    await ai.budget.configure(true, {
      monthly: 1_000_000,
      daily: 1_000_000,
      request: 300_000,
      operations: 12,
    });
    vi.spyOn(providers, 'modelBound').mockReturnValue(265_572);
    const plan = vi.spyOn(providers, 'plan').mockResolvedValue({
      actualCost: 40_000,
      value: {
        message: 'Cerco.',
        clarification: null,
        options: [],
        lookups: [{ name: 'Wawel', area: 'Cracovia' }],
      },
    });
    const before = await trips.read('example-trip');
    const job = await ready(request('lookup-cap', 'Aggiungi Wawel'));
    expect(job.status).toBe('failed');
    expect(plan).toHaveBeenCalledOnce();
    expect((await trips.read('example-trip')).etag).toBe(before.etag);
    expect(await ai.budget.status()).toMatchObject({ monthly: 40_000, reserved: 0, active: 0 });
  });
  it('throttles AI mutations at thirty per minute without weakening provider idempotency', async () => {
    vi.stubEnv('AGENT_API_TOKEN_HASH', hashKey('rate-test-agent'));
    const app = createApp(trips, ai);
    const original = await trips.read('example-trip');
    const post = () =>
      app.request('http://localhost/api/v2/trips/example-trip/ai/requests', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer rate-test-agent',
          'Content-Type': 'application/json',
          'X-Trip-Version': original.etag,
        },
        body: JSON.stringify(request('same-rate-job')),
      });
    for (let index = 0; index < 30; index++) expect((await post()).status).toBe(200);
    const rejected = await post();
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await ai.budget.read()).ledger.runs).toHaveLength(1);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
  });
  it('explains the demo replacement limit instead of treating its duration as a timing request', async () => {
    const job = await ready({
      ...request('replace-demo', 'Sostituisci il museo con un’altra visita di 30 minuti'),
      stepId: 'museum',
    });
    expect(job.status).toBe('clarification');
    expect(job.message).toContain('servizio AI attivo');
    expect(job.proposals).toEqual([]);
    expect((await trips.read('example-trip')).trip.plan).toEqual(exampleTrip().plan);
  });
  it('replaces a middle stop with both connections in one approval and one undo', async () => {
    const initial = await trips.read('example-trip');
    await trips.mutate('example-trip', initial.etag, (trip) => {
      const walk = trip.plan.steps.find((step) => step.id === 'walk')!;
      const museum = trip.plan.steps.find((step) => step.id === 'museum')!;
      if (walk.kind !== 'leg' || museum.kind !== 'stop') throw new Error('Invalid fixture');
      trip.plan.steps.push(
        {
          ...walk,
          id: 'walk-back',
          fromPlaceId: 'blue-museum',
          toPlaceId: 'blue-garden',
          start: museum.end,
          end: '2026-11-12T12:00:00+01:00',
          pois: [],
        },
        {
          ...museum,
          id: 'final-stop',
          title: 'Ultima pausa',
          placeId: 'blue-garden',
          start: '2026-11-12T12:00:00+01:00',
          end: '2026-11-12T12:30:00+01:00',
        },
      );
      trip.plan.days[0].stepIds.push('walk-back', 'final-stop');
    });
    const original = await trips.read('example-trip');
    const discover = vi.spyOn(providers, 'discover').mockResolvedValue({
      actualCost: 0,
      value: {
        places: [
          {
            id: 'replacement-park',
            name: 'Parco di prova',
            address: 'Borgo Blu',
            description: 'Fictional replacement',
            details: '',
            trivia: '',
            entrance: '',
            openingHours: '',
            sourceIds: [],
          },
        ],
        sources: [],
        notes: [],
      },
    });
    const plan = vi.spyOn(providers, 'plan').mockResolvedValue({
      actualCost: 0,
      value: {
        lookups: [],
        message: 'Una visita alternativa.',
        clarification: null,
        options: [
          {
            title: 'Parco al posto del museo',
            explanation: 'Synthetic replacement evaluation',
            actions: [
              {
                type: 'skip',
                stepId: 'museum',
                placeId: null,
                title: null,
                minutes: null,
                start: null,
                durationMinutes: null,
                afterId: null,
              },
              {
                type: 'add',
                stepId: null,
                placeId: 'replacement-park',
                title: 'Visita al parco',
                minutes: null,
                start: original.trip.plan.steps.find((step) => step.id === 'museum')!.start,
                durationMinutes: 90,
                afterId: 'square',
              },
            ],
            routes: [],
            sourceIds: [],
          },
        ],
      },
    });
    const route = vi.spyOn(providers, 'route').mockImplementation(async (query) => ({
      actualCost: 0,
      value: {
        fromPlaceId: query.fromPlaceId,
        toPlaceId: query.toPlaceId,
        durationMinutes: 10,
        streets: ['Strada di prova'],
        pois: [],
        estimate: true,
        provider: 'mock',
        checkedAt: new Date(now).toISOString(),
        directMinutes: 10,
        extraWalkingMinutes: 0,
        geometry: [],
        citations: [],
      },
    }));
    const job = await ready({
      ...request('replace-middle', 'Sostituisci il museo con un’altra visita'),
      stepId: 'museum',
    });
    expect(job.status, job.message).toBe('ready');
    expect(discover).toHaveBeenCalledOnce();
    expect(plan.mock.calls[0][0].request.stepId).toBe('museum');
    expect(route).toHaveBeenCalledTimes(3);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    const proposal = job.proposals[0];
    expect(proposal.commands).toHaveLength(2);
    expect(proposal.routes.map((leg) => [leg.fromPlaceId, leg.toPlaceId])).toEqual([
      ['blue-square', 'replacement-park'],
      ['replacement-park', 'blue-garden'],
    ]);
    const applied = await ai.apply(
      'example-trip',
      proposal.id,
      proposal.previewHash,
      original.etag,
    );
    expect(applied.trip.revision).toBe(original.trip.revision + 1);
    expect(applied.trip.travel!.history).toHaveLength(1);
    const stops = applied.trip.plan.days[0].stepIds
      .map((id) => applied.trip.plan.steps.find((step) => step.id === id)!)
      .filter((step) => step.kind === 'stop');
    expect(stops.map((step) => step.placeId)).toEqual([
      'blue-square',
      'replacement-park',
      'blue-garden',
    ]);
    expect(applied.trip.state.progress.museum).toBe('skipped');
    expect(applied.trip.state.reservations).toEqual(original.trip.state.reservations);
    expect(applied.trip.state.tickets).toEqual(original.trip.state.tickets);
    expect(applied.trip.plan.costs).toEqual(original.trip.plan.costs);
    const action = { type: 'undo' as const, historyId: proposal.id };
    const undone = applyTravel(applied.trip, {
      id: 'undo-replacement',
      action,
      routes: [],
      expected: preconditions(applied.trip, action),
      at: new Date(now).toISOString(),
    });
    expect(undone.plan.days).toEqual(original.trip.plan.days);
    expect(
      undone.plan.steps.filter((step) =>
        original.trip.plan.steps.some((old) => old.id === step.id),
      ),
    ).toEqual(original.trip.plan.steps);
  });
  it('rejects forged administrative or cross-day manual drafts before provider dispatch', async () => {
    const plan = vi.spyOn(providers, 'plan');
    const current = await trips.read('example-trip');
    for (const action of [
      { type: 'lock', dayId: 'day-one', stepId: 'square', fixed: false },
      { type: 'restore', dayId: 'day-one' },
      { type: 'note', targetId: 'square', text: 'Private notes do not go to the model' },
      { type: 'move', dayId: 'day-one', stepId: 'square', toDayId: 'other-day' },
      {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'square',
        included: false,
        acknowledgedBooking: true,
      },
    ]) {
      await expect(
        ai.create(
          'example-trip',
          {
            ...request(),
            draft: {
              id: 'forged-manual-draft',
              action,
              routes: [],
              expected: {},
              at: new Date().toISOString(),
            },
          } as AiRequest,
          current.etag,
        ),
      ).rejects.toThrow();
    }
    expect(plan).not.toHaveBeenCalled();
    expect((await ai.budget.status()).active).toBe(0);
    expect((await trips.read('example-trip')).etag).toBe(current.etag);
  });
  it.each(evaluationCases)(
    'rejects unsafe intents before any itinerary write: $id',
    async (scenario) => {
      const original = await trips.read('example-trip');
      // Synthetic model output exercises orchestration gates, not real model quality.
      vi.spyOn(providers, 'plan').mockResolvedValue({
        actualCost: 0,
        value: {
          message: 'Synthetic evaluation',
          clarification: null,
          options: [
            {
              title: 'Evaluation',
              explanation: 'Fictional test case',
              actions: [scenario.action],
              routes: [],
              sourceIds: [],
            },
          ],
        },
      } as unknown as Awaited<ReturnType<MockAiProviders['plan']>>);
      const job = await ready(request(`job-${scenario.id}`));
      expect(job.status).toBe(scenario.expected);
      expect((await trips.read('example-trip')).etag).toBe(original.etag);
    },
  );
  it('passes bounded follow-up history with fresh context and rejects another trip’s conversation', async () => {
    const first = await ready();
    const original = await trips.read('example-trip');
    const proposal = first.proposals[0];
    await ai.apply('example-trip', proposal.id, proposal.previewHash, original.etag);
    const plan = vi.spyOn(providers, 'plan');
    const second = await ready({
      ...request('follow-up', 'Accorcia la visita a 20 minuti'),
      parentJobId: first.id,
    });
    expect(second.status).toBe('ready');
    const context = plan.mock.calls[0][0];
    expect(context.conversation).toHaveLength(1);
    expect(context.conversation[0]).toMatchObject({
      request: 'Siamo in ritardo di 30 minuti',
      previousPlan: true,
    });
    expect(context.steps[0].start).toBe('2026-11-12T08:30:00.000Z');
    await trips.create('another-trip', exampleTrip().plan);
    const other = await trips.read('another-trip');
    await expect(
      ai.create('another-trip', { ...request('wrong-parent'), parentJobId: first.id }, other.etag),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('excludes personal names, booking references, tickets and shared notes from provider context', async () => {
    const value = await trips.read('example-trip');
    value.trip.plan.travellers[0].name = 'SECRET_PERSON';
    value.trip.plan.sources.push(
      {
        id: 'private-source',
        title: 'SECRET_SOURCE',
        description: 'SECRET_DESCRIPTION',
        status: 'user_provided',
        url: 'https://example.com/private?token=SECRET_TOKEN',
      },
      {
        id: 'public-source',
        title: 'Public museum',
        description: 'Public information',
        status: 'verified_official',
        url: 'https://example.com/museum?token=SECRET_TOKEN#SECRET_FRAGMENT',
      },
    );
    value.trip.plan.steps[0].sourceIds = ['private-source', 'public-source'];
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
    expect(context).toContain('https://example.com/museum');
  });
  it('looks up a requested landmark, resumes once, adds both sourced connections after approval, and undoes the schedule', async () => {
    const original = await trips.read('example-trip');
    await ai.budget.configure(true, {
      monthly: 1_000_000,
      daily: 1_000_000,
      request: 300_000,
      operations: 12,
    });
    vi.spyOn(providers, 'modelBound').mockReturnValue(265_572);
    const lookup = vi.spyOn(providers, 'lookup').mockResolvedValue({
      actualCost: 0,
      value: {
        places: [
          {
            id: 'new-garden',
            name: 'Castello del Wawel',
            address: 'Borgo Blu',
            description: 'Fictional evaluation candidate',
            details: '',
            trivia: '',
            entrance: '',
            openingHours: '',
            sourceIds: ['garden-source'],
          },
        ],
        sources: [
          {
            id: 'garden-source',
            title: 'Fictional source',
            description: 'Synthetic test evidence',
            status: 'verified_secondary',
          },
        ],
        notes: [],
      },
    });
    const plan = vi
      .spyOn(providers, 'plan')
      .mockResolvedValueOnce({
        actualCost: 1000,
        value: {
          message: 'Cerco il castello.',
          clarification: null,
          options: [],
          lookups: [{ name: 'Castello del Wawel', area: 'Cracovia' }],
        },
      })
      .mockResolvedValue({
        actualCost: 1000,
        value: {
          lookups: [],
          message: 'Una pausa in più.',
          clarification: null,
          options: [
            {
              title: 'Una sosta al giardino',
              explanation: 'Proposta sintetica di prova',
              actions: [
                {
                  type: 'add',
                  stepId: null,
                  placeId: 'new-garden',
                  title: 'Pausa al giardino',
                  minutes: null,
                  start: '2026-11-12T14:00:00+01:00',
                  durationMinutes: 20,
                  afterId: 'square',
                },
              ],
              routes: [],
              sourceIds: ['garden-source'],
            },
          ],
        },
      });
    vi.spyOn(providers, 'route').mockImplementation(async (query) => ({
      actualCost: 0,
      value: {
        fromPlaceId: query.fromPlaceId,
        toPlaceId: query.toPlaceId,
        durationMinutes: 10,
        streets: ['Strada di prova'],
        pois: [],
        estimate: true,
        provider: 'mock',
        checkedAt: new Date(now).toISOString(),
        directMinutes: 10,
        extraWalkingMinutes: 0,
        geometry: [],
        citations: [],
      },
    }));
    const input = request(
      'add-candidate',
      'aggiungi una tappa al castello di cracovia nel pomeriggio',
    );
    let job = await ai.create('example-trip', input, original.etag);
    job = await ai.advance('example-trip', job.id); // nearby research
    job = await ai.advance('example-trip', job.id); // requests named lookup
    expect(job.status).toBe('planning');
    expect(lookup).not.toHaveBeenCalled();
    // Refresh/restart at the persisted tool boundary must not repeat the first paid call.
    ai = new AiService(trips, providers, () => now, 100);
    job = await ready(input);
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[0][0].lookupAvailable).toBe(true);
    expect(plan.mock.calls[1][0].lookupAvailable).toBe(false);
    expect(plan.mock.calls[1][0].places.some((p) => p.name === 'Castello del Wawel')).toBe(true);
    expect(plan.mock.calls.map((args) => args[2])).toEqual([
      'add-candidate-model',
      'add-candidate-model-1',
    ]);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][0]).toEqual([{ name: 'Castello del Wawel', area: 'Cracovia' }]);
    await ai.advance('example-trip', job.id);
    expect(plan).toHaveBeenCalledTimes(2);
    const ledger = (await ai.budget.read()).ledger;
    expect(
      ledger.runs[0].operations.filter((op) => op.id.includes('model')).map((op) => op.actualCost),
    ).toEqual([1000, 1000]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    const proposal = job.proposals[0];
    expect(proposal.places).toHaveLength(1);
    expect(proposal.routes).toHaveLength(2);
    const applied = await ai.apply(
      'example-trip',
      proposal.id,
      proposal.previewHash,
      original.etag,
    );
    expect(applied.trip.travel!.history).toHaveLength(1);
    expect(applied.trip.plan.days[0].stepIds).toHaveLength(5);
    expect(applied.trip.plan.places.find((p) => p.id === 'new-garden')).toBeDefined();
    expect(applied.trip.plan.costs).toEqual(original.trip.plan.costs);
    expect(applied.trip.state.tickets).toEqual(original.trip.state.tickets);
    const action = { type: 'undo' as const, historyId: proposal.id };
    const undone = applyTravel(applied.trip, {
      id: 'undo-add-ai',
      action,
      routes: [],
      expected: preconditions(applied.trip, action),
      at: new Date(now).toISOString(),
    });
    expect(undone.plan.days).toEqual(original.trip.plan.days);
    expect(
      undone.plan.steps.filter((step) =>
        original.trip.plan.steps.some((old) => old.id === step.id),
      ),
    ).toEqual(original.trip.plan.steps);
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
    vi.spyOn(providers, 'modelBound').mockReturnValue(100);
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
    vi.stubEnv('AI_ADMIN_TOKEN_HASH', hashKey('operator-key-independent-and-long-enough'));
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
    expect(
      (
        await admin('operator-key-independent-and-long-enough', {
          enabled: false,
          model: 'changed',
        })
      ).status,
    ).toBe(422);
    expect((await admin('operator-key-independent-and-long-enough')).status).toBe(200);
    expect((await ai.budget.status()).enabled).toBe(false);
    expect(
      (
        await app.request('http://localhost/api/v2/trips', {
          headers: { Authorization: 'Bearer operator-key-independent-and-long-enough' },
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
