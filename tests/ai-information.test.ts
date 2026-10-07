import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleTrip } from '../src/domain/fixture';
import { AiRequestSchema, projectAiProposal } from '../src/domain/ai';
import { applyTravel, preconditions } from '../src/domain/travel';
import { AiService } from '../src/server/ai';
import { MockAiProviders } from '../src/server/ai-providers';
import { TripService } from '../src/server/service';
import { FileStorage } from '../src/server/storage';
import { information } from './fixtures/place-information';
import type { EnrichmentQuery } from '../src/server/ai-enrichment';

const now = Date.parse('2026-10-05T12:00:00Z');
class ResearchMock extends MockAiProviders {
  informationAvailable = true;
  enrichmentBound() {
    return 50000;
  }
  enrich = vi.fn(async (_query: EnrichmentQuery, _signal: AbortSignal, _requestId: string) => ({
    value: information(),
    actualCost: 10000,
  }));
}
let directory: string, trips: TripService, ai: AiService, provider: ResearchMock;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passo-research-'));
  trips = new TripService(new FileStorage(directory));
  const trip = exampleTrip();
  trip.plan.places.forEach((p) => (p.coordinates = { lat: 45, lng: 12, verifiedOn: '2026-10-01' }));
  await trips.create(trip.id, trip.plan);
  provider = new ResearchMock();
  ai = new AiService(trips, provider, () => now, 100);
  await ai.budget.configure(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function run(id: string, purpose: 'adapt' | 'information' = 'information') {
  const original = await trips.read('example-trip');
  const request = AiRequestSchema.parse({
    id,
    dayId: 'day-one',
    stepId: 'museum',
    text: purpose === 'information' ? 'Cerca le informazioni' : 'Aggiungi il giardino',
    purpose,
  });
  let job = await ai.create('example-trip', request, original.etag);
  for (let i = 0; i < 16 && ['queued', 'planning', 'routing'].includes(job.status); i++)
    job = await ai.advance('example-trip', id);
  return { job, original };
}
describe('Place research orchestration and approval', () => {
  it('recognizes a selected-stop information question and preserves retry idempotency', async () => {
    const original = await trips.read('example-trip');
    const request = AiRequestSchema.parse({
      id: 'natural-information',
      dayId: 'day-one',
      stepId: 'museum',
      text: 'Controlla orari e prezzi della tappa',
    });
    const plan = vi.spyOn(provider, 'plan');
    const created = await ai.create('example-trip', request, original.etag);
    expect(await ai.create('example-trip', request, original.etag)).toEqual(created);
    let job = created;
    for (let i = 0; i < 5 && ['queued', 'planning'].includes(job.status); i++)
      job = await ai.advance('example-trip', job.id);
    expect(job.status).toBe('ready');
    expect(plan).not.toHaveBeenCalled();
    expect(provider.enrich).toHaveBeenCalledTimes(1);
  });
  it('updates an existing booked stop only after approval, preserves financial state and supports one undo', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      trip.state.reservations.push({
        id: 'booking',
        stepId: 'museum',
        title: 'Synthetic booked slot',
        status: 'booked',
        travellerIds: ['traveller-one'],
        slot: '2026-11-12T10:15:00+01:00',
        paidAmount: 20,
        currency: 'EUR',
        reference: 'PRIVATE_BOOKING',
        notes: 'PRIVATE_NOTE',
      });
    });
    const plan = vi.spyOn(provider, 'plan');
    const { job, original } = await run('information-approval');
    expect(job.status).toBe('ready');
    expect(plan).not.toHaveBeenCalled();
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(job.proposals[0].information).toHaveLength(1);
    expect(job.proposals[0].commands).toHaveLength(0);
    const proposal = job.proposals[0];
    const applied = await ai.apply(
      'example-trip',
      proposal.id,
      proposal.previewHash,
      original.etag,
    );
    expect(applied.trip.plan.places.find((p) => p.id === 'blue-museum')!.information).toEqual(
      information(),
    );
    expect(applied.trip.plan.steps).toEqual(original.trip.plan.steps);
    expect(applied.trip.state).toEqual(original.trip.state);
    expect(applied.trip.plan.costs).toEqual(original.trip.plan.costs);
    expect(applied.trip.travel!.history).toHaveLength(1);
    const action = { type: 'undo' as const, historyId: proposal.id };
    const undone = applyTravel(applied.trip, {
      id: 'undo-information',
      action,
      routes: [],
      expected: preconditions(applied.trip, action),
      at: new Date(now).toISOString(),
    });
    expect(undone.plan.places.find((p) => p.id === 'blue-museum')!.information).toBeUndefined();
    expect(undone.state.reservations).toEqual(original.trip.state.reservations);
    expect(JSON.stringify(provider.enrich.mock.calls)).not.toContain('PRIVATE');
    expect(provider.enrich.mock.calls[0][0]).toEqual({
      name: 'Museo del borgo',
      lat: 45,
      lng: 12,
      visitDate: '2026-11-12',
    });
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0, monthly: 10000 });
  });
  it('reuses date-specific research and avoids charging or proposing an unchanged update', async () => {
    const first = await run('cache-one');
    expect(first.job.status).toBe('ready');
    const second = await run('cache-two');
    expect(second.job.status).toBe('ready');
    expect(provider.enrich).toHaveBeenCalledTimes(1);
    const proposal = second.job.proposals[0];
    await ai.apply('example-trip', proposal.id, proposal.previewHash, second.original.etag);
    const third = await run('cache-three');
    expect(third.job.status).toBe('clarification');
    expect(provider.enrich).toHaveBeenCalledTimes(1);
    expect(third.job.proposals).toHaveLength(0);
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0, monthly: 10000 });
  });
  it('does not dispatch when the request budget cannot reserve research', async () => {
    await ai.budget.configure(true, {
      monthly: 100000,
      daily: 100000,
      request: 30000,
      operations: 12,
    });
    const { job, original } = await run('over-budget');
    expect(job.status).toBe('failed');
    expect(provider.enrich).not.toHaveBeenCalled();
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0, monthly: 0 });
  });
  it('retains known research charges when the evidence cannot be accepted', async () => {
    vi.spyOn(provider, 'enrich').mockResolvedValue({ value: null as never, actualCost: 10000 });
    const { job, original } = await run('invalid-evidence');
    expect(job.status).toBe('failed');
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0, monthly: 10000 });
  });
  it('blocks irrelevant/private logistics research before starting any spending run', async () => {
    const current = await trips.read('example-trip');
    const changed = await trips.mutate('example-trip', current.etag, (trip) => {
      const stop = trip.plan.steps.find((s) => s.id === 'museum')!;
      if (stop.kind === 'stop') stop.category = 'logistics';
    });
    await expect(
      ai.create(
        'example-trip',
        AiRequestSchema.parse({
          id: 'private-research',
          dayId: 'day-one',
          stepId: 'museum',
          text: 'Cerca',
          purpose: 'information',
        }),
        changed.etag,
      ),
    ).rejects.toThrow('locale pubblico');
    expect(provider.enrich).not.toHaveBeenCalled();
    expect((await ai.budget.read()).ledger.runs).toHaveLength(0);
  });
  it('researches added stops once, passes their windows to replanning, and keeps evidence in the approved proposal', async () => {
    const output = {
      message: 'Aggiungo il giardino.',
      clarification: null,
      lookups: [],
      options: [
        {
          title: 'Aggiungi visita',
          explanation: 'Una visita aggiuntiva.',
          actions: [
            {
              type: 'add' as const,
              stepId: null,
              placeId: 'blue-garden',
              title: 'Il giardino',
              minutes: null,
              start: '2026-11-12T12:00:00+01:00',
              durationMinutes: 30,
              afterId: 'museum',
            },
          ],
          routes: [],
          sourceIds: [],
        },
      ],
    };
    const plan = vi.spyOn(provider, 'plan').mockResolvedValue({ value: output, actualCost: 0 });
    vi.spyOn(provider, 'route').mockImplementation(async (query) => ({
      actualCost: 0,
      value: {
        fromPlaceId: query.fromPlaceId,
        toPlaceId: query.toPlaceId,
        pois: [],
        durationMinutes: 15,
        directMinutes: 15,
        extraWalkingMinutes: 0,
        streets: ['Via sintetica'],
        estimate: true,
        provider: 'mock' as const,
        checkedAt: new Date(now).toISOString(),
        geometry: [],
        citations: [],
      },
    }));
    const { job, original } = await run('add-with-research', 'adapt');
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(provider.enrich).toHaveBeenCalledTimes(1);
    expect(
      plan.mock.calls[1][0].places.find((p) => p.id === 'blue-garden')?.visitInformation,
    ).toMatchObject({ visitDate: '2026-11-12', openingHours: { visitStatus: 'open' } });
    const projected = projectAiProposal(original.trip, job.proposals[0]);
    expect(projected.plan.places.find((p) => p.id === 'blue-garden')!.information).toEqual(
      information(),
    );
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
  });
});
