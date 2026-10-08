import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exampleTrip } from '../src/domain/fixture';
import {
  aiContext,
  AiRequestSchema,
  type AiContext,
  type AiIntent,
  type AiModelOutputInput,
} from '../src/domain/ai';
import { emptyConstraints, retainConstraints, type AiTask } from '../src/domain/ai-task';
import { dayInsights, undoChoices } from '../src/domain/ai-insights';
import { AI_CAPABILITIES } from '../src/domain/ai-capabilities';
import { applyTravel, preconditions } from '../src/domain/travel';
import { AiService } from '../src/server/ai';
import { MockAiProviders } from '../src/server/ai-providers';
import { FileStorage } from '../src/server/storage';
import { TripService } from '../src/server/service';
import { information } from './fixtures/place-information';
import scenarios from './fixtures/ai-conversations.json';

const now = Date.parse('2026-10-05T12:00:00Z');
const task = (goals: AiTask['goals'] = ['answer']): AiTask => ({
  goals,
  targetStepIds: ['museum'],
  constraints: emptyConstraints(),
  pendingQuestion: null,
});
const action = (type: AiIntent['type'] = 'timing', stepId = 'museum'): AiIntent => ({
  type,
  stepId,
  placeId: null,
  title: null,
  minutes: type === 'delay' ? 30 : null,
  start: null,
  durationMinutes: type === 'timing' ? 30 : null,
  afterId: null,
});
const reply = (changes: Partial<AiModelOutputInput> = {}): AiModelOutputInput => ({
  message: 'Risposta sintetica per la verifica.',
  clarification: null,
  lookups: [],
  options: [],
  ...changes,
});
const option = (actions: AiIntent[] = [action()]) => ({
  title: 'Proposta di prova',
  explanation: 'Modifica sintetica da confermare.',
  actions,
  routes: [],
  sourceIds: [],
});

class FoundationProvider extends MockAiProviders {
  informationAvailable = true;
  enrichmentBound() {
    return 20;
  }
  enrich = vi.fn(async () => ({ value: information(), actualCost: 2 }));
}
let directory: string, trips: TripService, provider: FoundationProvider, ai: AiService;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'passo-foundation-'));
  trips = new TripService(new FileStorage(directory));
  await trips.create('example-trip', exampleTrip().plan);
  provider = new FoundationProvider();
  ai = new AiService(trips, provider, () => now, 100);
  await ai.budget.configure(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function run(id: string, text: string, extras: Record<string, unknown> = {}) {
  const original = await trips.read('example-trip');
  let job = await ai.create(
    'example-trip',
    AiRequestSchema.parse({ id, text, dayId: 'day-one', stepId: 'museum', ...extras }),
    original.etag,
  );
  for (let i = 0; i < 20 && ['queued', 'planning', 'routing'].includes(job.status); i++)
    job = await ai.advance('example-trip', id);
  return { job, original };
}

describe('Phase 0–2 conversation contracts (scripted providers, not language-quality scores)', () => {
  const discovery = () => ({
    places: [
      {
        id: 'public-candidate',
        name: 'Museo del borgo',
        address: 'Borgo Blu',
        description: 'Luogo sintetico, mai usato con fornitori reali.',
        details: '',
        trivia: '',
        entrance: '',
        openingHours: '',
        sourceIds: ['candidate-source'],
        coordinates: { lat: 45, lng: 12, verifiedOn: '2026-10-01' },
      },
    ],
    sources: [
      {
        id: 'candidate-source',
        title: 'Fonte sintetica',
        url: 'https://example.com/place',
        description: 'Coordinate sintetiche per il test.',
        status: 'verified_secondary' as const,
        verifiedOn: '2026-10-01',
      },
    ],
    notes: [],
  });
  it.each(scenarios)('$id: $prompt', async (scenario) => {
    let value = reply({ task: task() });
    switch (scenario.kind) {
      case 'information':
        value = reply({ task: task(['research']), informationRequests: ['museum'] });
        break;
      case 'answer':
        break;
      case 'delay':
        value = reply({ task: task(['propose']), options: [option([action('delay')])] });
        break;
      case 'timing':
        value = reply({ task: task(['propose']), options: [option()] });
        break;
      case 'keep-conflict': {
        const t = task(['propose']);
        t.constraints.keepStepIds = ['museum'];
        value = reply({ task: t, options: [option()] });
        break;
      }
      case 'finish-conflict': {
        const t = task(['propose']);
        t.constraints.finishBy = '2026-11-12T10:00:00+01:00';
        value = reply({ task: t, options: [option()] });
        break;
      }
      case 'walking-conflict': {
        const t = task(['propose']);
        t.constraints.maxWalkingMinutes = 0;
        value = reply({ task: t, options: [option()] });
        break;
      }
      case 'avoid-conflict': {
        const t = task(['propose']);
        t.constraints.avoidPlaceIds = ['blue-museum'];
        value = reply({ task: t, options: [option()] });
        break;
      }
      case 'window-conflict': {
        const t = task(['propose']);
        t.constraints.visitNotBefore = '2026-11-12T14:00:00+01:00';
        value = reply({
          task: t,
          options: [option([{ ...action(), start: '2026-11-12T10:30:00+01:00' }])],
        });
        break;
      }
      case 'opening-unknown': {
        const t = task(['propose']);
        t.constraints.requireOpenPlaceIds = ['blue-museum'];
        value = reply({ task: t, options: [option()] });
        break;
      }
      case 'read-only-write':
        value = reply({ task: task(['answer']), options: [option()] });
        break;
      case 'invalid-information':
        value = reply({ task: task(['research']), informationRequests: ['unknown-stop'] });
        break;
      case 'invalid-place':
        value = reply({
          task: task(['propose']),
          options: [
            option([
              {
                ...action('add'),
                stepId: null,
                placeId: 'invented-place',
                title: 'Luogo inventato',
                durationMinutes: 30,
              },
            ]),
          ],
        });
        break;
      case 'invalid-history':
        value = reply({
          task: task(['undo']),
          historyRequest: 'unknown-history',
          options: [option([])],
        });
        break;
      case 'too-many-lookups':
        value = reply({
          lookups: Array.from({ length: 3 }, () => ({ name: 'Museo', area: 'Borgo Blu' })),
        });
        break;
      case 'invalid-location':
        value = reply({
          task: task(['propose']),
          locationRequests: [{ placeId: 'blue-museum', candidateId: 'invented-place' }],
          options: [option()],
        });
        break;
      case 'forbidden-action':
        value = reply({ options: [option([{ ...action(), type: 'book' } as never])] });
        break;
      case 'forbidden-field':
        value = { ...reply(), credentials: 'never-permitted' } as never;
        break;
      default:
        throw new Error(`Scenario lacks an oracle: ${scenario.kind}`);
    }
    vi.spyOn(provider, 'plan').mockResolvedValue({ value, actualCost: 0 });
    const { job, original } = await run(scenario.id, scenario.prompt);
    expect(job.status, job.message).toBe(scenario.expectedStatus);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    if (scenario.kind === 'information') {
      expect(provider.enrich).toHaveBeenCalledOnce();
      expect(job.proposals[0].commands).toEqual([]);
      expect(job.proposals[0].routes).toEqual([]);
    }
    if (scenario.expectedStatus === 'answered') expect(job.proposals).toEqual([]);
    if (scenario.expectedStatus === 'failed') expect(job.proposals).toEqual([]);
    expect(await ai.budget.status()).toMatchObject({ active: 0, reserved: 0 });
  });

  it('persists the research question, validates a choice and resolves si grazie after a service restart', async () => {
    const t = task(['research']);
    t.pendingQuestion = {
      question: 'Quale museo?',
      choices: [
        { id: 'the-museum', label: 'Museo del borgo', stepId: 'museum', placeId: 'blue-museum' },
      ],
    };
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, clarification: 'Quale museo?' }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({ task: task(['research']), informationRequests: ['museum'] }),
        actualCost: 0,
      });
    const first = await run('question', 'Orari e prezzi?');
    expect(first.job.status).toBe('clarification');
    ai = new AiService(trips, provider, () => now, 100);
    const next = await run('answer-question', 'si grazie', {
      stepId: 'square',
      parentJobId: first.job.id,
      choiceId: 'the-museum',
    });
    expect(next.job.status, next.job.message).toBe('ready');
    expect(plan.mock.calls[1][0].task).toEqual(t);
    expect(plan.mock.calls[1][0].selectedChoice?.id).toBe('the-museum');
    expect(next.job.proposals[0].commands).toEqual([]);
    await expect(
      run('forged-choice', 'sì', { parentJobId: first.job.id, choiceId: 'forged' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await ai.budget.read()).ledger.runs).toHaveLength(2);
  });

  it('resolves a manual stop location from evidence, retains its ID and undoes the coordinate update', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      trip.plan.places[0].coordinates = { lat: 45.001, lng: 12.001, verifiedOn: '2026-10-01' };
    });
    vi.spyOn(provider, 'lookup').mockResolvedValue({ actualCost: 0, value: discovery() });
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({
          task: task(['propose']),
          lookups: [{ name: 'Museo del borgo', area: 'Borgo Blu' }],
        }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({
          task: task(['propose']),
          locationRequests: [{ placeId: 'blue-museum', candidateId: 'public-candidate' }],
          options: [
            {
              ...option([]),
              routes: [{ fromPlaceId: 'blue-square', toPlaceId: 'blue-museum', poiPlaceIds: [] }],
            },
          ],
        }),
        actualCost: 0,
      });
    const { job, original } = await run(
      'resolve-location',
      'Ricalcola il percorso verso la tappa manuale',
    );
    expect(job.status, job.message).toBe('ready');
    const p = job.proposals[0];
    expect(p.locations).toHaveLength(1);
    expect(p.places).toEqual([]);
    expect(
      (await trips.read('example-trip')).trip.plan.places.find((p) => p.id === 'blue-museum')!
        .coordinates,
    ).toBeUndefined();
    const saved = await ai.apply('example-trip', p.id, p.previewHash, original.etag);
    expect(saved.trip.plan.places.find((p) => p.id === 'blue-museum')!.coordinates).toEqual(
      discovery().places[0].coordinates,
    );
    expect(
      saved.trip.plan.steps.filter((s) => s.kind === 'stop' && s.placeId === 'blue-museum'),
    ).toHaveLength(1);
    const a = { type: 'undo' as const, historyId: p.id };
    const competing = structuredClone(saved.trip);
    competing.plan.places.find((p) => p.id === 'blue-museum')!.coordinates!.lat += 0.01;
    expect(() =>
      applyTravel(competing, {
        id: 'conflicting-undo',
        action: a,
        expected: preconditions(competing, a),
        routes: [],
        at: new Date(now).toISOString(),
      }),
    ).toThrow('cambiate');
    const restored = applyTravel(saved.trip, {
      id: 'undo-location',
      action: a,
      expected: preconditions(saved.trip, a),
      routes: [],
      at: new Date(now).toISOString(),
    });
    expect(restored.plan.places.find((p) => p.id === 'blue-museum')!.coordinates).toBeUndefined();
    expect(restored.plan.places.find((p) => p.id === 'blue-museum')!.sourceIds).toEqual(
      original.trip.plan.places.find((p) => p.id === 'blue-museum')!.sourceIds,
    );
  });

  it('researches a discovered public place without adding a dummy stop', async () => {
    vi.spyOn(provider, 'lookup').mockResolvedValue({ actualCost: 0, value: discovery() });
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({
          task: task(['research']),
          lookups: [{ name: 'Museo del borgo', area: 'Borgo Blu' }],
        }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({ task: task(['research']), placeInformationRequests: ['public-candidate'] }),
        actualCost: 0,
      });
    const { job, original } = await run(
      'new-place-question',
      'Cerca informazioni su un altro luogo pubblico',
    );
    expect(job.status, job.message).toBe('answered');
    expect(job.proposals).toEqual([]);
    expect(job.facts).toHaveLength(1);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(provider.enrich).toHaveBeenCalledOnce();
  });

  it('turns a landmark-coordinate prose stall into an add preview within the same bounded request', async () => {
    const t = { ...task(['research', 'propose']), changeIntent: 'add-stop' as const };
    const lookup = vi
      .spyOn(provider, 'lookup')
      .mockResolvedValue({ value: discovery(), actualCost: 0 });
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, lookups: [{ name: 'Fabbrica del borgo', area: 'Borgo Blu' }] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({
          task: t,
          message: 'La posizione non è un ingresso verificato. Posso proporre una visita esterna.',
        }),
        actualCost: 0,
      })
      .mockImplementationOnce(async (context) => {
        expect(context.planningFeedback).toContain('changeIntent');
        expect(context.remainingPlanningPasses).toBe(0);
        const candidate = context.places.find((p) => p.id === 'public-candidate')!;
        expect(candidate).toMatchObject({
          origin: 'discovered',
          publicResearchAllowed: true,
          scheduledStepIds: [],
          location: { hasCoordinates: true },
        });
        return {
          value: reply({
            task: t,
            options: [
              option([
                {
                  ...action('add'),
                  stepId: null,
                  placeId: candidate.id,
                  title: 'Visita esterna indicativa',
                  start: '2026-11-12T14:00:00+01:00',
                  durationMinutes: 20,
                  afterId: 'museum',
                },
              ]),
            ],
          }),
          actualCost: 0,
        };
      });
    vi.spyOn(provider, 'route').mockImplementation(async (query) => ({
      actualCost: 0,
      value: {
        fromPlaceId: query.fromPlaceId,
        toPlaceId: query.toPlaceId,
        durationMinutes: 10,
        distanceKm: 0.5,
        streets: ['Via sintetica'],
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
    const { job, original } = await run(
      'landmark-stall',
      'Aggiungi una visita esterna alla fabbrica alle 14',
      { stepId: undefined },
    );
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][0]).toEqual([
      { name: 'Fabbrica del borgo', area: 'Borgo Blu' },
      { name: 'Museo del borgo', area: 'Borgo Blu' },
    ]);
    expect(provider.enrich).not.toHaveBeenCalled();
    expect(job.proposals[0].commands.some((c) => c.action.type === 'add')).toBe(true);
    expect(job.proposals[0].warnings.some((w) => w.includes('non un ingresso verificato'))).toBe(
      true,
    );
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    const saved = await ai.apply(
      'example-trip',
      job.proposals[0].id,
      job.proposals[0].previewHash,
      original.etag,
    );
    expect(
      saved.trip.plan.steps.filter((s) => s.kind === 'stop' && s.placeId === 'public-candidate'),
    ).toHaveLength(1);
    expect(saved.trip.state).toEqual(original.trip.state);
  });

  it.each([false, true])(
    'adds a stop and its sourced public anchor atomically, repairing an omitted mapping=%s',
    async (omitMapping) => {
      Object.assign(provider, { validateRoute: vi.fn() });
      const current = await trips.read('example-trip');
      await trips.mutate('example-trip', current.etag, (trip) => {
        trip.plan.places[0].coordinates = { lat: 45.001, lng: 12.001, verifiedOn: '2026-10-01' };
      });
      const found = discovery();
      found.places[0].name = 'Fabbrica sintetica';
      found.places.push({ ...found.places[0], id: 'public-anchor', name: 'Museo del borgo' });
      const lookup = vi
        .spyOn(provider, 'lookup')
        .mockResolvedValue({ actualCost: 0, value: found });
      const route = vi.spyOn(provider, 'route').mockImplementation(async (query) => ({
        actualCost: 0,
        value: {
          fromPlaceId: query.fromPlaceId,
          toPlaceId: query.toPlaceId,
          durationMinutes: 10,
          distanceKm: 0.5,
          streets: ['Via sintetica'],
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
      const t = { ...task(['propose']), changeIntent: 'add-stop' as const };
      const plan = vi
        .spyOn(provider, 'plan')
        .mockResolvedValueOnce({
          value: reply({ task: t, lookups: [{ name: 'Fabbrica sintetica', area: 'Borgo Blu' }] }),
          actualCost: 0,
        })
        .mockResolvedValueOnce({
          value: reply({
            task: t,
            locationRequests: omitMapping
              ? []
              : [{ placeId: 'blue-museum', candidateId: 'public-anchor' }],
            options: [
              option([
                {
                  ...action('add'),
                  stepId: null,
                  placeId: 'public-candidate',
                  title: 'Fabbrica sintetica',
                  afterId: 'museum',
                  start: '2026-11-12T14:00:00+01:00',
                  durationMinutes: 20,
                },
              ]),
            ],
          }),
          actualCost: 0,
        })
        .mockImplementationOnce(async (context) => {
          expect(omitMapping).toBe(true);
          expect(context.remainingPlanningPasses).toBe(0);
          expect(context.planningFeedback).toContain('blue-museum');
          expect(context.planningFeedback).toContain('locationRequests');
          expect(route).not.toHaveBeenCalled();
          expect(lookup).toHaveBeenCalledOnce();
          return {
            actualCost: 0,
            value: reply({
              task: t,
              locationRequests: [{ placeId: 'blue-museum', candidateId: 'public-anchor' }],
              options: [
                option([
                  {
                    ...action('add'),
                    stepId: null,
                    placeId: 'public-candidate',
                    title: 'Fabbrica sintetica',
                    afterId: 'museum',
                    start: '2026-11-12T14:00:00+01:00',
                    durationMinutes: 20,
                  },
                ]),
              ],
            }),
          };
        });
      const { job, original } = await run(
        'add-with-public-anchor',
        'Aggiungi una fabbrica alle 14',
        {
          stepId: undefined,
        },
      );
      expect(job.status, job.message).toBe('ready');
      expect(plan).toHaveBeenCalledTimes(omitMapping ? 3 : 2);
      expect(lookup).toHaveBeenCalledOnce();
      expect(lookup.mock.calls[0][0]).toHaveLength(2);
      expect(provider.enrich).not.toHaveBeenCalled();
      expect(
        route.mock.calls[0][1].plan.places.find((p) => p.id === 'blue-museum')!.coordinates,
      ).toEqual(found.places[1].coordinates);
      expect((await trips.read('example-trip')).etag).toBe(original.etag);
      const saved = await ai.apply(
        'example-trip',
        job.proposals[0].id,
        job.proposals[0].previewHash,
        original.etag,
      );
      expect(saved.trip.plan.places.find((p) => p.id === 'blue-museum')!.coordinates).toEqual(
        found.places[1].coordinates,
      );
      expect(saved.trip.plan.days[0].stepIds).toContain(
        saved.trip.plan.steps.find((s) => s.kind === 'stop' && s.placeId === 'public-candidate')!
          .id,
      );
      expect(saved.trip.state).toEqual(original.trip.state);
    },
  );

  it('fails honestly after three prose-only passes and cannot downgrade an unfinished add to an answer', async () => {
    const t = { ...task(['propose']), changeIntent: 'add-stop' as const };
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, message: 'Propongo una nuova tappa.' }),
        actualCost: 0,
      })
      .mockResolvedValue({
        value: reply({
          task: { ...task(), changeIntent: null },
          message: 'Ho aggiunto la visita.',
        }),
        actualCost: 0,
      });
    const { job, original } = await run('empty-add', 'Aggiungi una tappa');
    expect(plan).toHaveBeenCalledTimes(3);
    expect(job.status).toBe('failed');
    expect(job.message).toContain('Non è stata generata una proposta applicabile');
    expect(job.task?.changeIntent).toBe('add-stop');
    expect(job.proposals).toEqual([]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    const status = await ai.budget.status();
    expect(status.reserved).toBe(0);
    expect(status.active).toBe(0);
  });

  it('keeps a research prerequisite inside the unfinished schedule task', async () => {
    const t = { ...task(['research', 'propose']), changeIntent: 'adjust-stops' as const };
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, informationRequests: ['museum'] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({ value: reply({ task: t, options: [option()] }), actualCost: 0 });
    const { job, original } = await run(
      'research-before-change',
      'Controlla gli orari e accorcia la visita',
    );
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(job.proposals[0].commands).toHaveLength(1);
    expect(job.proposals[0].information).toHaveLength(1);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
  });

  it('associates a sourced position with a public POI that has no existing stop', async () => {
    vi.spyOn(provider, 'lookup').mockResolvedValue({ value: discovery(), actualCost: 0 });
    const t = { ...task(['propose']), changeIntent: 'location-only' as const };
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, lookups: [{ name: 'Giardino segreto', area: 'Borgo Blu' }] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({
          task: t,
          locationRequests: [{ placeId: 'blue-garden', candidateId: 'public-candidate' }],
          options: [option([])],
        }),
        actualCost: 0,
      });
    const { job, original } = await run(
      'public-poi-position',
      'Verifica la posizione del giardino pubblico',
    );
    expect(job.status, job.message).toBe('ready');
    expect(job.proposals[0].locations[0].placeId).toBe('blue-garden');
    expect(job.proposals[0].commands).toEqual([]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
  });
  it('keeps private logistics out of the broadened public-location association boundary', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      const stop = trip.plan.steps.find((s) => s.id === 'museum')!;
      if (stop.kind === 'stop') stop.category = 'logistics';
    });
    vi.spyOn(provider, 'lookup').mockResolvedValue({ value: discovery(), actualCost: 0 });
    const t = { ...task(['propose']), changeIntent: 'location-only' as const };
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, lookups: [{ name: 'Luogo pubblico', area: 'Borgo Blu' }] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({
          task: t,
          locationRequests: [{ placeId: 'blue-museum', candidateId: 'public-candidate' }],
          options: [option([])],
        }),
        actualCost: 0,
      });
    const { job, original } = await run('private-position', 'Rivedi la posizione');
    expect(job.status).toBe('failed');
    expect(job.proposals).toEqual([]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(provider.enrich).not.toHaveBeenCalled();
  });

  it('repairs a post-lookup clarification/action conflict without repeating discovery or exceeding three passes', async () => {
    const t = { ...task(['propose']), changeIntent: 'adjust-stops' as const };
    const lookup = vi
      .spyOn(provider, 'lookup')
      .mockResolvedValue({ value: discovery(), actualCost: 0 });
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, lookups: [{ name: 'Luogo pubblico', area: 'Borgo Blu' }] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({ task: t, clarification: 'Vuoi procedere?', options: [option()] }),
        actualCost: 0,
      })
      .mockImplementationOnce(async (context) => {
        expect(context.planningFeedback).toContain('operazioni incompatibili');
        expect(context.lookupAvailable).toBe(false);
        return { value: reply({ task: t, options: [option()] }), actualCost: 0 };
      });
    const { job, original } = await run('question-action-conflict', 'Accorcia la visita');
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledOnce();
    const ledger = (await ai.budget.read()).ledger;
    expect(
      ledger.runs[0].operations.filter((o) => o.id.includes('-model')).map((o) => o.id),
    ).toEqual([
      'question-action-conflict-model',
      'question-action-conflict-model-1',
      'question-action-conflict-model-2',
    ]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
  });

  it('repairs a missing public location before routing when the planner omitted lookup', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      trip.plan.places[0].coordinates = { lat: 45.001, lng: 12.001, verifiedOn: '2026-10-01' };
    });
    Object.assign(provider, { validateRoute: vi.fn() });
    const lookup = vi
      .spyOn(provider, 'lookup')
      .mockResolvedValue({ actualCost: 0, value: discovery() });
    const route = vi.spyOn(provider, 'route');
    const routeOption = {
      ...option([]),
      routes: [{ fromPlaceId: 'blue-square', toPlaceId: 'blue-museum', poiPlaceIds: [] }],
    };
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: task(['propose']), options: [routeOption] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({
          task: task(['propose']),
          locationRequests: [{ placeId: 'blue-museum', candidateId: 'public-candidate' }],
          options: [routeOption],
        }),
        actualCost: 0,
      });
    const original = await trips.read('example-trip');
    const request = AiRequestSchema.parse({
      id: 'repair',
      dayId: 'day-one',
      text: 'Rivedi il percorso',
    });
    await ai.create('example-trip', request, original.etag);
    await ai.advance('example-trip', request.id);
    expect(route).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    const { job } = await run(request.id, request.text, { stepId: undefined });
    expect(job.status, job.message).toBe('ready');
    expect(lookup).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
    expect(
      route.mock.calls[0][1].plan.places.find((p) => p.id === 'blue-museum')!.coordinates,
    ).toEqual(discovery().places[0].coordinates);
    expect(job.trace?.filter((t) => t.stage === 'lookup')).toHaveLength(1);
  });

  it('preserves evidenced candidates across clarification and accepts a widget choice', async () => {
    vi.spyOn(provider, 'lookup').mockResolvedValue({ actualCost: 0, value: discovery() });
    const t = task(['research']);
    t.pendingQuestion = {
      question: 'Questo luogo?',
      choices: [
        {
          id: 'candidate-choice',
          label: 'Museo del borgo',
          placeId: 'public-candidate',
          stepId: null,
        },
      ],
    };
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({
          task: task(['research']),
          lookups: [{ name: 'Museo del borgo', area: 'Borgo Blu' }],
        }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({ task: t, clarification: 'Questo luogo?' }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({
        value: reply({ task: task(['research']), placeInformationRequests: ['public-candidate'] }),
        actualCost: 0,
      });
    const first = await run('candidates', 'Quale museo?', { stepId: undefined });
    expect(first.job.status).toBe('clarification');
    const next = await run('chosen-candidate', 'Il primo', {
      parentJobId: first.job.id,
      choiceId: 'candidate-choice',
      stepId: undefined,
    });
    expect(next.job.status).toBe('answered');
    expect(plan.mock.calls[2][0].candidatePlaceIds).toContain('public-candidate');
    expect(plan.mock.calls[2][0].selectedChoice?.placeId).toBe('public-candidate');
  });

  it('researches and reschedules atomically, keeps payments and supports conflict-safe undo', async () => {
    const t = task(['research', 'propose']);
    t.constraints.requireOpenPlaceIds = ['blue-museum'];
    vi.spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        value: reply({ task: t, informationRequests: ['museum'], options: [option()] }),
        actualCost: 0,
      })
      .mockResolvedValueOnce({ value: reply({ task: t, options: [option()] }), actualCost: 0 });
    const { job, original } = await run(
      'compound',
      'Controlla se aperto e accorcia la visita a mezz’ora',
    );
    expect(job.status, job.message).toBe('ready');
    const proposal = job.proposals[0];
    expect(proposal.information).toHaveLength(1);
    expect(proposal.commands).toHaveLength(1);
    const applied = await ai.apply(
      'example-trip',
      proposal.id,
      proposal.previewHash,
      original.etag,
    );
    expect(applied.trip.travel!.history).toHaveLength(1);
    expect(applied.trip.state).toEqual(original.trip.state);
    expect(applied.trip.plan.steps.find((s) => s.id === 'museum')!.end).toBe(
      '2026-11-12T09:45:00.000Z',
    );
    const undo = { type: 'undo' as const, historyId: proposal.id };
    const restored = applyTravel(applied.trip, {
      id: 'undo',
      action: undo,
      expected: preconditions(applied.trip, undo),
      routes: [],
      at: new Date(now).toISOString(),
    });
    expect(restored.plan.steps).toEqual(original.trip.plan.steps);
    expect(restored.plan.places.find((p) => p.id === 'blue-museum')!.information).toBeUndefined();
  });

  it('returns researched facts even when a conditional change is infeasible', async () => {
    const closed = information();
    closed.openingHours = { ...closed.openingHours!, visitStatus: 'closed', windows: [] };
    provider.enrich.mockResolvedValue({ value: closed, actualCost: 2 });
    const t = task(['research', 'propose']);
    t.constraints.requireOpenPlaceIds = ['blue-museum'];
    vi.spyOn(provider, 'plan').mockResolvedValue({
      value: reply({ task: t, informationRequests: ['museum'], options: [option()] }),
      actualCost: 0,
    });
    const { job, original } = await run('closed', 'Se aperto accorcia la visita');
    expect(job.status).toBe('failed');
    expect(job.failure).toBe('evidence');
    expect(job.facts).toHaveLength(1);
    expect(job.proposals).toEqual([]);
    expect((await trips.read('example-trip')).etag).toBe(original.etag);
    expect(provider.enrich).toHaveBeenCalledOnce();
  });

  it('exposes only declared read/propose capabilities and excludes private operational data', () => {
    const trip = exampleTrip();
    trip.plan.travellers[0].name = 'SECRET_TRAVELER';
    trip.state.reservations.push({
      id: 'private',
      stepId: 'museum',
      status: 'booked',
      title: 'SECRET_TITLE',
      reference: 'SECRET_CODE',
      notes: 'SECRET_NOTES',
      travellerIds: ['traveller-one'],
      paidAmount: 20,
      currency: 'EUR',
    });
    const context = aiContext(
      trip,
      AiRequestSchema.parse({ id: 'context', dayId: 'day-one', text: 'Costi' }),
      [],
      now,
    );
    expect(JSON.stringify(context)).not.toContain('SECRET');
    expect(context.insights.costs.EUR).not.toHaveProperty('paid');
    expect(dayInsights(trip, 'day-one', now).costs.EUR.paid).toBe(20);
    expect(AI_CAPABILITIES.every((c) => ['read', 'propose'].includes(c.permission))).toBe(true);
    expect(AI_CAPABILITIES.map((c) => c.id)).not.toContain('apply_proposal');
  });

  it('offers a version-bound undo proposal without invoking routing or research', async () => {
    const original = await trips.read('example-trip');
    const a = {
      type: 'timing' as const,
      dayId: 'day-one',
      stepId: 'museum',
      durationMinutes: 30,
      following: true,
    };
    const changed = await trips.mutate(
      'example-trip',
      original.etag,
      (trip) =>
        Object.assign(
          trip,
          applyTravel(trip, {
            id: 'manual',
            action: a,
            expected: preconditions(trip, a),
            routes: [],
            at: new Date(now).toISOString(),
          }),
        ),
      true,
    );
    expect(undoChoices(changed.trip, 'day-one')[0].available).toBe(true);
    vi.spyOn(provider, 'plan').mockResolvedValue({
      actualCost: 0,
      value: reply({ task: task(['undo']), historyRequest: 'manual', options: [option([])] }),
    });
    const route = vi.spyOn(provider, 'route');
    const { job } = await run('undo-proposal', 'Annulla l’ultima modifica');
    expect(job.status, job.message).toBe('ready');
    expect(route).not.toHaveBeenCalled();
    expect(provider.enrich).not.toHaveBeenCalled();
    const p = job.proposals[0],
      restored = await ai.apply('example-trip', p.id, p.previewHash, changed.etag);
    expect(restored.trip.plan.steps).toEqual(original.trip.plan.steps);
  });

  it('computes group estimates, unknown costs and dated euro conversions locally', () => {
    const trip = exampleTrip();
    trip.plan.costs[0].currency = 'PLN';
    trip.plan.costs.push({ ...trip.plan.costs[0], id: 'unknown', min: null, max: null });
    trip.state.exchangeRates.push({
      currency: 'PLN',
      euroPerUnit: 0.25,
      asOf: '2026-10-01',
      fetchedAt: new Date(now).toISOString(),
      source: 'https://example.com/fx',
    });
    expect(dayInsights(trip, 'day-one', now).costs.PLN).toEqual({
      min: 30,
      max: 30,
      unknown: 1,
      paid: 0,
      euro: { min: 7.5, max: 7.5, asOf: '2026-10-01' },
    });
    expect(dayInsights(trip, 'day-one', Date.parse('2026-11-12T09:30:00+01:00'))).toMatchObject({
      currentStepId: 'square',
      remainingMinutes: 135,
    });
  });
  it('keeps saved research citations distinct and usable in subsequent schedule proposals', async () => {
    const original = await trips.read('example-trip');
    await trips.mutate('example-trip', original.etag, (trip) => {
      trip.plan.places[0].information = information();
      trip.plan.places.find((p) => p.id === 'blue-museum')!.information = {
        ...information(),
        website: { url: 'https://other.example/', sourceIds: ['official'] },
        sources: [{ ...information().sources[0], url: 'https://other.example/' }],
      };
    });
    vi.spyOn(provider, 'plan').mockImplementation(async (context: AiContext) => {
      const place = context.places.find((p) => p.id === 'blue-museum')!;
      const id = place.visitInformation!.sources[0].id;
      expect(context.sources.find((s) => s.id === id)?.url).toBe('https://other.example/');
      expect(new Set(context.sources.map((s) => s.id)).size).toBe(context.sources.length);
      expect(place.visitInformation!.price!.sourceIds).toEqual([id]);
      return {
        value: reply({ task: task(['propose']), options: [{ ...option(), sourceIds: [id] }] }),
        actualCost: 0,
      };
    });
    const { job } = await run('cached-citation', 'Accorcia la visita');
    expect(job.status, job.message).toBe('ready');
    expect(job.proposals[0].citations.some((s) => s.url === 'https://other.example/')).toBe(true);
  });
  it.each(['1700-11-12T17:00:00+01:00', '2026-11-12T23:30:00Z'])(
    'rejects a deadline outside the selected local day (%s)',
    async (finishBy) => {
      const t = task(['propose']);
      t.constraints.finishBy = finishBy;
      vi.spyOn(provider, 'plan').mockResolvedValue({
        value: reply({ task: t, options: [option()] }),
        actualCost: 0,
      });
      const { job, original } = await run('wrong-date', 'Accorcia la visita');
      expect(job.status).toBe('failed');
      expect(job.message).toContain('giornata selezionata');
      expect((await trips.read('example-trip')).etag).toBe(original.etag);
    },
  );

  it('keeps task constraints across a brief follow-up without replaying a stale proposal', async () => {
    const t = task(['propose']);
    t.constraints.keepStepIds = ['square'];
    t.constraints.preferences = ['pause frequenti'];
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({ actualCost: 0, value: reply({ task: t, options: [option()] }) })
      .mockImplementationOnce(async (context: AiContext) => ({
        actualCost: 0,
        value: reply({
          task: { ...context.task!, pendingQuestion: null },
          options: [option([action('delay')])],
        }),
      }));
    const first = await run('first-option', 'Mantieni la piazza e accorcia il museo');
    const p = first.job.proposals[0];
    await ai.apply('example-trip', p.id, p.previewHash, first.original.etag);
    const next = await run('refine', 'Invece spostalo di mezz’ora', { parentJobId: first.job.id });
    expect(next.job.status).toBe('ready');
    expect(plan.mock.calls[1][0].task?.constraints).toEqual(t.constraints);
    expect(next.job.proposals[0].baseEtag).not.toBe(p.baseEtag);
    await expect(ai.apply('example-trip', p.id, p.previewHash, p.baseEtag)).resolves.toHaveProperty(
      'trip',
    );
  });
  it('retains actual payments for archived visits without adding their estimates to the active day', () => {
    let trip = exampleTrip();
    const skip = {
      type: 'skip' as const,
      dayId: 'day-one',
      stepId: 'museum',
      included: false,
      acknowledgedBooking: false,
    };
    trip = applyTravel(trip, {
      id: 'skip-paid',
      action: skip,
      expected: preconditions(trip, skip),
      routes: [],
      at: new Date(now).toISOString(),
    });
    trip.state.reservations.push({
      id: 'paid',
      stepId: 'museum',
      status: 'booked',
      title: 'Ingresso',
      reference: '',
      notes: '',
      travellerIds: ['traveller-one'],
      paidAmount: 20,
      currency: 'EUR',
    });
    expect(dayInsights(trip, 'day-one', now).costs.EUR).toMatchObject({ min: 0, max: 0, paid: 20 });
  });
  it('never relaxes hard constraints during internal reasoning passes', () => {
    const previous = {
      ...emptyConstraints(),
      keepStepIds: ['museum'],
      avoidPlaceIds: ['blue-square'],
      requireOpenPlaceIds: ['blue-museum'],
      maxWalkingMinutes: 20,
      finishBy: '2026-11-12T12:00:00+01:00',
      visitNotBefore: '2026-11-12T09:00:00+01:00',
      visitNotAfter: '2026-11-12T11:00:00+01:00',
    };
    expect(retainConstraints(previous, emptyConstraints())).toEqual(previous);
    expect(
      retainConstraints(previous, {
        ...emptyConstraints(),
        maxWalkingMinutes: 10,
        finishBy: '2026-11-12T13:00:00+01:00',
        visitNotBefore: '2026-11-12T10:00:00+01:00',
        visitNotAfter: '2026-11-12T12:00:00+01:00',
      }),
    ).toMatchObject({
      maxWalkingMinutes: 10,
      finishBy: previous.finishBy,
      visitNotBefore: '2026-11-12T10:00:00+01:00',
      visitNotAfter: previous.visitNotAfter,
    });
  });
  it('refines with measured walking times, keeps the deadline and reuses the identical route', async () => {
    const initial = task(['propose']);
    initial.constraints.finishBy = '2026-11-12T11:15:00+01:00';
    const routeQuery = { fromPlaceId: 'blue-square', toPlaceId: 'blue-museum', poiPlaceIds: [] };
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        actualCost: 0,
        value: reply({
          task: initial,
          options: [{ ...option([{ ...action(), durationMinutes: 60 }]), routes: [routeQuery] }],
        }),
      })
      .mockResolvedValueOnce({
        actualCost: 0,
        value: reply({
          task: task(['propose']),
          options: [{ ...option([{ ...action(), durationMinutes: 45 }]), routes: [routeQuery] }],
        }),
      });
    const originalRoute = provider.route.bind(provider);
    const route = vi.spyOn(provider, 'route').mockImplementation(async (...args) => {
      const result = await originalRoute(...args);
      result.value.durationMinutes = result.value.directMinutes = 30;
      return result;
    });
    const { job, original } = await run('measured-refinement', 'Terminiamo entro le 11:15');
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledOnce();
    expect(plan.mock.calls[1][0].routeResults[0].walkingMinutes).toBe(30);
    expect(job.task!.constraints.finishBy).toBe(initial.constraints.finishBy);
    const p = job.proposals[0];
    const applied = await ai.apply('example-trip', p.id, p.previewHash, original.etag);
    expect(applied.trip.plan.steps.find((s) => s.id === 'museum')!.end).toBe(
      '2026-11-12T10:15:00.000Z',
    );
    expect((await ai.budget.read()).ledger.runs[0].operations.map((o) => o.id)).toEqual([
      'measured-refinement-model',
      'measured-refinement-route-0',
      'measured-refinement-model-1',
    ]);
  });
  it('invalidates an unapplied proposal after a correction even if the itinerary version is unchanged', async () => {
    vi.spyOn(provider, 'plan').mockResolvedValue({
      actualCost: 0,
      value: reply({ task: task(['propose']), options: [option()] }),
    });
    const first = await run('superseded', 'Accorcia la visita');
    const p = first.job.proposals[0];
    const next = await run('corrected', 'No, rivaluta la proposta', { parentJobId: first.job.id });
    expect(next.job.status).toBe('ready');
    expect((await trips.read('example-trip')).etag).toBe(first.original.etag);
    expect((await ai.get('example-trip', first.job.id)).status).toBe('cancelled');
    await expect(
      ai.apply('example-trip', p.id, p.previewHash, first.original.etag),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('shortens a visit before applying a delay so the coordinated batch preserves a booked anchor', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      trip.state.reservations.push({
        id: 'anchor',
        stepId: 'museum',
        status: 'booked',
        title: 'Visita prenotata',
        reference: '',
        notes: '',
        travellerIds: ['traveller-one'],
        slot: trip.plan.steps.find((s) => s.id === 'museum')!.start,
      });
    });
    const t = task(['propose']);
    t.constraints.keepStepIds = ['museum'];
    vi.spyOn(provider, 'plan').mockResolvedValue({
      actualCost: 0,
      value: reply({
        task: t,
        options: [option([action('delay', 'square'), action('timing', 'square')])],
      }),
    });
    const { job, original } = await run(
      'coordinated-delay',
      'Siamo in ritardo, riduci la prima visita e mantieni la prenotazione',
      { stepId: 'square' },
    );
    expect(job.status, job.message).toBe('ready');
    const p = job.proposals[0];
    expect(p.commands.map((c) => c.action.type)).toEqual(['timing', 'delay']);
    const saved = await ai.apply('example-trip', p.id, p.previewHash, original.etag);
    expect(saved.trip.plan.steps.find((s) => s.id === 'museum')).toEqual(
      original.trip.plan.steps.find((s) => s.id === 'museum'),
    );
    expect(saved.trip.state.reservations).toEqual(original.trip.state.reservations);
  });
  it('reconsiders a failed schedule with deterministic feedback and a distinct reserved model operation', async () => {
    const current = await trips.read('example-trip');
    await trips.mutate('example-trip', current.etag, (trip) => {
      trip.state.reservations.push({
        id: 'anchor',
        stepId: 'museum',
        status: 'booked',
        title: 'Visita prenotata',
        reference: '',
        notes: '',
        travellerIds: ['traveller-one'],
        slot: trip.plan.steps.find((s) => s.id === 'museum')!.start,
      });
    });
    const plan = vi
      .spyOn(provider, 'plan')
      .mockResolvedValueOnce({
        actualCost: 0,
        value: reply({ task: task(['propose']), options: [option([action('delay', 'square')])] }),
      })
      .mockResolvedValueOnce({
        actualCost: 0,
        value: reply({
          task: task(['propose']),
          options: [option([action('delay', 'square'), action('timing', 'square')])],
        }),
      });
    const { job } = await run(
      'refine-conflict',
      'Mantieni la prenotazione anche se siamo in ritardo',
      { stepId: 'square' },
    );
    expect(job.status, job.message).toBe('ready');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0].planningFeedback).toContain('vincoli');
    expect(plan.mock.calls.map((call) => call[2])).toEqual([
      'refine-conflict-model',
      'refine-conflict-model-1',
    ]);
    expect((await ai.budget.read()).ledger.runs[0].operations).toHaveLength(2);
  });
});
