import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PlaceInformationSchema,
  informationFresh,
  visitWindowStatus,
  type PlaceInformationUpdate,
} from '../domain/place-information.js';
import { validateResearchQuery, type EnrichmentQuery } from './ai-enrichment.js';
import { confirmationReply, informationQuestion } from '../domain/ai-request.js';
import {
  AiTaskSchema,
  emptyConstraints,
  retainConstraints,
  type AiTask,
} from '../domain/ai-task.js';
import { AI_CAPABILITIES, AI_LIMITS, AI_STAGE_POLICY } from '../domain/ai-capabilities.js';
import { dayInsights, undoChoices } from '../domain/ai-insights.js';
import { Id, type Trip } from '../domain/schema.js';
import {
  AiRequestSchema,
  AiModelOutputSchema,
  AiRouteSchema,
  AiProposalSchema,
  AiDiscoverySchema,
  AiPlaceLookupsSchema,
  AiLocationUpdateSchema,
  AiPlanError,
  aiContext,
  withDiscovery,
  intentAction,
  orderAiIntents,
  projectAiProposal,
  type AiRequest,
  type AiProposal,
  type AiProposalInput,
  type AiLocationUpdate,
  type AiContext,
} from '../domain/ai.js';
import {
  applyTravel,
  preconditions,
  routeNeeds,
  TravelError,
  type TravelCommand,
} from '../domain/travel.js';
import { AiBudgetError } from '../domain/ai-budget.js';
import { AiBudgetService } from './ai-budget.js';
import { ApiError, type Storage } from './storage.js';
import { TripService } from './service.js';
import type { AiProviders, RouteQuery } from './ai-providers.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const terminal = new Set([
  'ready',
  'answered',
  'clarification',
  'failed',
  'uncertain',
  'cancelled',
  'applying',
  'applied',
]);
const JobSchema = z
  .object({
    id: Id,
    tripId: Id,
    request: AiRequestSchema,
    requestHash: z.string(),
    baseEtag: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    status: z.enum([
      'queued',
      'running',
      'planning',
      'routing',
      'ready',
      'answered',
      'clarification',
      'failed',
      'uncertain',
      'cancelled',
      'applying',
      'applied',
    ]),
    stage: z.enum(['research', 'model', 'lookup', 'information', 'routes', 'finalize', 'done']),
    modelRounds: z.number().int().min(0).max(AI_LIMITS.modelRounds).default(0),
    feedback: z.enum(['schedule', 'constraints']).nullable().default(null),
    task: AiTaskSchema.nullable().default(null),
    selectedChoice: AiTaskSchema.shape.pendingQuestion
      .unwrap()
      .shape.choices.element.nullable()
      .default(null),
    locations: z.array(AiLocationUpdateSchema).max(2).default([]),
    failure: z.enum(['budget', 'usage', 'evidence', 'conflict', 'provider', 'contract']).optional(),
    trace: z
      .array(
        z
          .object({
            stage: z.enum(['research', 'model', 'lookup', 'information', 'routes', 'finalize']),
            outcome: z.enum(['done', 'clarification', 'failed']),
            milliseconds: z.number().int().min(0).max(120000),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    informationRound: z.number().int().min(0).max(1).default(0),
    informationOnly: z.boolean().default(false),
    informationQueue: z.array(Id).max(2).default([]),
    informationIndex: z.number().int().min(0).max(2).default(0),
    information: z
      .array(z.object({ placeId: Id, information: PlaceInformationSchema }).strict())
      .max(2)
      .default([]),
    lookupRound: z.number().int().min(0).max(1).default(0),
    message: z.string().max(4000),
    owner: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    output: AiModelOutputSchema.optional(),
    discovery: AiDiscoverySchema.default({ places: [], sources: [], notes: [] }),
    queue: z
      .array(z.object({ fromPlaceId: Id, toPlaceId: Id, poiPlaceIds: z.array(Id).max(3) }).strict())
      .max(6)
      .default([]),
    routeIndex: z.number().int().min(0).max(6).default(0),
    routeCalls: z.number().int().min(0).max(6).default(0),
    routes: z.array(AiRouteSchema).max(6).default([]),
    proposalIds: z.array(Id).max(2).default([]),
    supersededBy: Id.optional(),
  })
  .strict();
type Job = z.infer<typeof JobSchema>;
export type AiJobView = {
  id: string;
  tripId: string;
  dayId: string;
  status: Job['status'];
  message: string;
  createdAt: string;
  expiresAt: string;
  mock: boolean;
  proposals: AiProposal[];
  task?: AiTask | null;
  facts?: PlaceInformationUpdate[];
  insights?: ReturnType<typeof dayInsights>;
  failure?: Job['failure'];
  trace?: Job['trace'];
};

export const previewHash = (trip: Trip) =>
  hash({ plan: trip.plan, state: trip.state, travel: trip.travel });

export class AiService {
  budget: AiBudgetService;
  constructor(
    private trips: TripService,
    private providers: AiProviders | undefined,
    private now: () => number = Date.now,
    private timeoutMs: number = AI_STAGE_POLICY.timeoutMilliseconds,
  ) {
    this.budget = new AiBudgetService(trips.store, now);
  }
  private get store(): Storage {
    return this.trips.store;
  }
  private jobPath(id: string) {
    return `ai/jobs/${Id.parse(id)}.json`;
  }
  private proposalPath(id: string) {
    return `ai/proposals/${Id.parse(id)}.json`;
  }
  private provider() {
    if (!this.providers) throw new ApiError(503, 'Assistenza AI non ancora configurata.');
    return this.providers;
  }
  private async conversation(tripId: string, request: AiRequest, currentEtag: string) {
    const messages: ReturnType<typeof aiContext>['conversation'] = [];
    let id = request.parentJobId;
    const seen = new Set<string>();
    while (id && messages.length < 3) {
      if (seen.has(id)) throw new ApiError(409, 'Conversazione non valida.');
      seen.add(id);
      const { job } = await this.readJob(tripId, id);
      const applied =
        job.status === 'applying' &&
        (await this.trips.read(tripId)).trip.travel?.appliedIds.some((proposalId) =>
          job.proposalIds.includes(proposalId),
        );
      if (
        job.request.dayId !== request.dayId ||
        !terminal.has(job.status) ||
        (job.status === 'applying' && !applied)
      )
        throw new ApiError(
          409,
          'Attendi la richiesta in corso o inizia una nuova conversazione per questa giornata.',
        );
      messages.unshift({
        request: job.request.text.slice(0, 700),
        response: applied
          ? 'La proposta precedente è stata applicata al programma.'
          : job.message.slice(0, 1000),
        options:
          job.output?.options.map(
            (option) => `${option.title}: ${option.explanation.slice(0, 400)}`,
          ) ?? [],
        previousPlan: job.baseEtag !== currentEtag,
      });
      id = job.request.parentJobId;
    }
    return messages;
  }
  async availability() {
    if (!this.providers) return { enabled: false, mode: 'off' as const };
    const budget = await this.budget.status();
    return { enabled: budget.enabled, mode: this.providers.mode, capabilities: AI_CAPABILITIES };
  }
  private async readJob(tripId: string, id: string) {
    const item = await this.store.read(this.jobPath(id));
    if (!item) throw new ApiError(404, 'Richiesta AI non disponibile.');
    const job = JobSchema.parse(JSON.parse(new TextDecoder().decode(item.body)));
    if (job.tripId !== tripId) throw new ApiError(404, 'Richiesta AI non disponibile.');
    return { job, etag: item.etag };
  }
  private async changeJob(tripId: string, id: string, fn: (job: Job) => void) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { job, etag } = await this.readJob(tripId, id);
      fn(job);
      try {
        await this.store.write(this.jobPath(id), encode(JobSchema.parse(job)), etag);
        return job;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 412)) throw error;
      }
    }
    throw new ApiError(409, 'Richiesta AI aggiornata da un altro dispositivo.');
  }
  private async supersedeParent(job: Job) {
    if (!job.request.parentJobId) return;
    await this.changeJob(job.tripId, job.request.parentJobId, (parent) => {
      if (parent.status === 'ready' && !parent.supersededBy) parent.supersededBy = job.id;
    });
  }
  async get(tripId: string, id: string): Promise<AiJobView> {
    // Trip existence is checked even for cached jobs; deleted trips stay private.
    const { trip } = await this.trips.read(tripId);
    const { job } = await this.readJob(tripId, id);
    const proposals: AiProposal[] = [];
    for (const proposalId of job.proposalIds) {
      const item = await this.store.read(this.proposalPath(proposalId));
      if (item) {
        const proposal = AiProposalSchema.parse(JSON.parse(new TextDecoder().decode(item.body)));
        if (proposal.tripId !== tripId || proposal.jobId !== id)
          throw new ApiError(503, 'Proposta AI non valida.');
        proposals.push(proposal);
      }
    }
    const abandoned = job.status === 'running' && this.now() - Date.parse(job.startedAt!) > 50_000;
    const applied = job.proposalIds.some((proposalId) =>
      trip.travel?.appliedIds.includes(proposalId),
    );
    return {
      id: job.id,
      tripId,
      dayId: job.request.dayId,
      status: applied
        ? 'applied'
        : abandoned
          ? 'uncertain'
          : job.supersededBy && job.status === 'ready'
            ? 'cancelled'
            : job.status,
      message: applied
        ? 'Proposta applicata al programma condiviso.'
        : abandoned
          ? 'Richiesta interrotta. La spesa deve essere verificata; non viene riavviata automaticamente.'
          : job.supersededBy && job.status === 'ready'
            ? 'Questa proposta è stata sostituita da una richiesta successiva.'
            : job.message,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      mock: this.providers?.mode === 'mock',
      proposals,
      task: job.task,
      facts: job.information,
      insights: trip.plan.days.some((d) => d.id === job.request.dayId)
        ? dayInsights(trip, job.request.dayId, this.now())
        : undefined,
      failure: job.failure,
      trace: job.trace,
    };
  }
  async create(tripId: string, raw: AiRequest, expected?: string) {
    const request = AiRequestSchema.parse(raw);
    if (!expected) throw new ApiError(428, 'Aggiorna il viaggio prima di chiedere assistenza.');
    const requestHash = hash({ tripId, request, expected });
    const previous = await this.store.read(this.jobPath(request.id));
    if (previous) {
      const { job } = await this.readJob(tripId, request.id);
      if (job.requestHash !== requestHash)
        throw new ApiError(409, 'ID della richiesta già utilizzato per un’altra modifica.');
      await this.supersedeParent(job);
      return this.get(tripId, request.id);
    }
    // Keyword recovery is restricted to records written before structured tasks.
    // New general requests always go through semantic planning.
    if (!request.draft && request.parentJobId && confirmationReply(request.text)) {
      // Recover the original question through an old misclassified confirmation,
      // but never cross an intervening schedule request or another selected stop.
      let parentId: string | undefined = request.parentJobId;
      const seen = new Set<string>();
      for (let n = 0; parentId && n < 3 && !seen.has(parentId); n++) {
        seen.add(parentId);
        const { job: parent } = await this.readJob(tripId, parentId);
        if (
          parent.request.dayId !== request.dayId ||
          (request.stepId && parent.request.stepId && request.stepId !== parent.request.stepId)
        )
          break;
        if (
          !parent.task &&
          (parent.request.purpose === 'information' || informationQuestion(parent.request.text))
        ) {
          request.purpose = 'information';
          request.stepId ??= parent.request.stepId;
          break;
        }
        if (!confirmationReply(parent.request.text)) break;
        parentId = parent.request.parentJobId;
      }
    }
    const provider = this.provider();
    const { trip, etag } = await this.trips.read(tripId);
    if (etag !== expected)
      throw new ApiError(412, 'Il programma è cambiato. Aggiorna prima di chiedere assistenza.');
    const draft = request.draft ? applyTravel(trip, request.draft) : trip;
    let task: AiTask | null = null;
    let selectedChoice: Job['selectedChoice'] = null;
    let inheritedDiscovery: Job['discovery'] = { places: [], sources: [], notes: [] };
    if (request.parentJobId) {
      const { job: parent } = await this.readJob(tripId, request.parentJobId);
      // Selecting another card does not answer or erase the conversation's
      // pending question. The semantic planner sees both task and selected stop.
      if (parent.request.dayId === request.dayId && parent.status !== 'cancelled')
        task = parent.task;
      if (
        task &&
        ['ready', 'clarification', 'answered', 'applied'].includes(parent.status) &&
        Date.parse(parent.expiresAt) > this.now()
      )
        inheritedDiscovery = parent.discovery;
      if (request.choiceId) {
        if (Date.parse(parent.expiresAt) <= this.now())
          throw new ApiError(409, 'La domanda è scaduta. Richiedi una nuova valutazione.');
        selectedChoice =
          task?.pendingQuestion?.choices.find((c) => c.id === request.choiceId) ?? null;
        if (!selectedChoice)
          throw new ApiError(409, 'Questa scelta non appartiene alla domanda corrente.');
        if (selectedChoice.stepId) request.stepId = selectedChoice.stepId;
      }
    } else if (request.choiceId)
      throw new ApiError(409, 'La scelta richiede una domanda precedente.');
    const context = aiContext(
      withDiscovery(draft, inheritedDiscovery),
      request,
      inheritedDiscovery.places.map((p) => p.id),
      this.now(),
    );
    if (request.purpose === 'information')
      task = {
        goals: ['research'],
        targetStepIds: request.stepId ? [request.stepId] : [],
        constraints: emptyConstraints(),
        pendingQuestion: null,
      };
    context.task = task;
    context.selectedChoice = selectedChoice;
    context.conversation = await this.conversation(tripId, request, etag);
    if (request.purpose === 'information') {
      if (request.draft)
        throw new AiPlanError('invalid', 'Le informazioni non modificano il programma.');
      if (!provider.informationAvailable || !provider.enrich || !provider.enrichmentBound)
        throw new ApiError(
          503,
          'La ricerca delle informazioni richiede il servizio AI con ricerca web attiva.',
        );
      if (request.stepId) this.informationTarget(draft, request.stepId, request.dayId);
      provider.enrichmentBound();
    }
    provider.modelBound(context); // Pricing and input caps fail before starting a job.
    const timestamp = new Date(this.now()).toISOString();
    const job = JobSchema.parse({
      id: request.id,
      tripId,
      request,
      requestHash,
      baseEtag: etag,
      createdAt: timestamp,
      expiresAt: new Date(this.now() + 30 * 60_000).toISOString(),
      status: 'queued',
      task,
      selectedChoice,
      informationOnly: request.purpose === 'information',
      discovery: inheritedDiscovery,
      informationQueue:
        request.purpose === 'information'
          ? draft.plan.steps.flatMap((s) =>
              s.id === request.stepId && s.kind === 'stop' ? [s.placeId] : [],
            )
          : [],
      stage:
        request.purpose === 'information'
          ? request.stepId
            ? 'information'
            : 'model'
          : request.preference === 'scenic'
            ? 'research'
            : 'model',
      message: 'Richiesta pronta. Il programma resta invariato.',
    });
    await this.budget.start({ id: request.id, scope: tripId, requestHash });
    try {
      await this.store.write(this.jobPath(job.id), encode(job), 'create');
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        const { job: concurrent } = await this.readJob(tripId, job.id);
        if (concurrent.requestHash === requestHash) {
          await this.supersedeParent(concurrent);
          return this.get(tripId, job.id);
        }
      }
      await this.budget.cancel(job.id).catch(() => {});
      throw error;
    }
    await this.supersedeParent(job);
    return this.get(tripId, job.id);
  }
  private async bounded<T>(fn: (signal: AbortSignal) => Promise<T>, research = false) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (research)
              console.warn('AI research deadline reached', { milliseconds: this.timeoutMs });
            controller.abort();
            reject(new Error('AI stage deadline'));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private withInformation(trip: Trip, updates: PlaceInformationUpdate[]): Trip {
    const enriched = structuredClone(trip);
    for (const update of updates) {
      const place = enriched.plan.places.find((p) => p.id === update.placeId);
      if (place) place.information = update.information;
    }
    return enriched;
  }
  private withLocations(trip: Trip, locations: AiLocationUpdate[]) {
    const draft = structuredClone(trip);
    for (const update of locations) {
      const place = draft.plan.places.find((p) => p.id === update.placeId);
      if (!place) throw new AiPlanError('invalid', 'Luogo non disponibile.');
      place.coordinates = update.coordinates;
    }
    return draft;
  }
  private validateTask(task: AiTask, context: AiContext) {
    const steps = new Set(context.steps.map((s) => s.id));
    const places = new Set(context.places.map((p) => p.id));
    const dayDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: context.day.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (
      [
        task.constraints.finishBy,
        task.constraints.visitNotBefore,
        task.constraints.visitNotAfter,
      ].some((instant) => instant && dayDate.format(new Date(instant)) !== context.day.date)
    )
      throw new AiPlanError(
        'invalid',
        'Il vincolo di orario deve appartenere alla giornata selezionata.',
      );
    if (
      [...task.targetStepIds, ...task.constraints.keepStepIds].some((id) => !steps.has(id)) ||
      [...task.constraints.avoidPlaceIds, ...task.constraints.requireOpenPlaceIds].some(
        (id) => !places.has(id),
      ) ||
      task.pendingQuestion?.choices.some(
        (c) => (c.stepId && !steps.has(c.stepId)) || (c.placeId && !places.has(c.placeId)),
      ) ||
      (task.pendingQuestion &&
        new Set(task.pendingQuestion.choices.map((c) => c.id)).size !==
          task.pendingQuestion.choices.length)
    )
      throw new AiPlanError(
        'invalid',
        'Il contesto della richiesta contiene riferimenti non disponibili.',
      );
  }
  private validateConstraints(before: Trip, after: Trip, job: Job) {
    const c = job.task?.constraints;
    if (!c) return;
    const day = after.plan.days.find((d) => d.id === job.request.dayId)!;
    const steps = day.stepIds.map((id) => after.plan.steps.find((s) => s.id === id)!);
    for (const id of c.keepStepIds) {
      const old = before.plan.steps.find((s) => s.id === id)!,
        current = steps.find((s) => s.id === id);
      if (!current || current.start !== old.start || current.end !== old.end)
        throw new AiPlanError(
          'invalid',
          'La proposta non mantiene una tappa che hai chiesto di conservare.',
        );
    }
    if (steps.some((s) => s.kind === 'stop' && c.avoidPlaceIds.includes(s.placeId)))
      throw new AiPlanError('invalid', 'La proposta include un luogo che hai chiesto di evitare.');
    const walking = steps.reduce(
      (sum, s) => sum + (s.kind === 'leg' && s.mode === 'walk' ? s.durationMinutes : 0),
      0,
    );
    if (c.maxWalkingMinutes !== null && walking > c.maxWalkingMinutes)
      throw new AiPlanError(
        'invalid',
        'Il tempo a piedi supera il limite richiesto. Valuta meno tappe o un altro mezzo.',
      );
    if (c.finishBy && steps.some((s) => Date.parse(s.end) > Date.parse(c.finishBy!)))
      throw new AiPlanError('invalid', 'La giornata non termina entro l’orario richiesto.');
    for (const s of steps.filter(
      (s) =>
        s.kind === 'stop' &&
        (!before.plan.days.find((d) => d.id === job.request.dayId)!.stepIds.includes(s.id) ||
          before.plan.steps.find((old) => old.id === s.id)?.start !== s.start),
    )) {
      if (
        (c.visitNotBefore && Date.parse(s.start) < Date.parse(c.visitNotBefore)) ||
        (c.visitNotAfter && Date.parse(s.end) > Date.parse(c.visitNotAfter))
      )
        throw new AiPlanError(
          'invalid',
          'La visita proposta non rientra nella fascia oraria richiesta.',
        );
    }
    for (const id of c.requireOpenPlaceIds) {
      const info = after.plan.places.find((p) => p.id === id)?.information;
      const visits = steps.filter((s) => s.kind === 'stop' && s.placeId === id);
      if (
        !visits.length ||
        !informationFresh(info, day.date, this.now()) ||
        visits.some(
          (s) =>
            visitWindowStatus(info!, s.start, s.end, s.timezone ?? after.plan.timezone) !== 'fits',
        )
      )
        throw new AiPlanError(
          'invalid',
          'L’apertura nella fascia richiesta non è verificata. Puoi valutare una visita esterna o un’alternativa.',
        );
    }
  }
  private researchQuery(trip: Trip, placeId: string, dayId: string): EnrichmentQuery {
    const place = trip.plan.places.find((p) => p.id === placeId);
    const c = place?.coordinates;
    if (!place) throw new AiPlanError('invalid', 'Luogo non disponibile.');
    const fresh =
      c &&
      Date.parse(c.verifiedOn) <= this.now() &&
      this.now() - Date.parse(c.verifiedOn) <= 365 * 24 * 3600_000;
    const area = trip.plan.destinations.slice(0, 3).join(', ').trim();
    const publicArea = /^[\p{L}\p{M}\p{N} .,:'’()-]{1,160}$/u.test(area) ? area : undefined;
    const query = {
      name: place.name.slice(0, 160),
      ...(publicArea ? { area: publicArea } : {}),
      ...(fresh ? { lat: c.lat, lng: c.lng } : {}),
      visitDate: trip.plan.days.find((d) => d.id === dayId)!.date,
    };
    validateResearchQuery(query);
    return query;
  }
  private informationTarget(trip: Trip, stepId: string, dayId: string) {
    const step = trip.plan.steps.find((s) => s.id === stepId);
    if (
      step?.kind !== 'stop' ||
      !['visit', 'meal', 'free-time'].includes(step.category) ||
      !trip.plan.days.find((d) => d.id === dayId)?.stepIds.includes(stepId)
    )
      throw new AiPlanError(
        'invalid',
        'Scegli una visita o un locale pubblico della giornata per aggiornare le informazioni.',
      );
    this.researchQuery(trip, step.placeId, dayId);
    return step.placeId;
  }
  private collectRoutes(trip: Trip, job: Job): RouteQuery[] {
    trip = this.withLocations(
      this.withInformation(withDiscovery(trip, job.discovery), job.information),
      job.locations,
    );
    const queue: RouteQuery[] = [];
    const context = aiContext(
      job.request.draft ? applyTravel(trip, job.request.draft) : trip,
      job.request,
      job.discovery.places.map((p) => p.id),
      this.now(),
    );
    const allowed = new Set(context.places.map((p) => p.id));
    const add = (query: RouteQuery) => {
      if (
        ![query.fromPlaceId, query.toPlaceId, ...query.poiPlaceIds].every((id) => allowed.has(id))
      )
        throw new AiPlanError(
          'invalid',
          'L’assistente deve usare i luoghi presenti nel contesto verificato.',
        );
      if (!queue.some((q) => JSON.stringify(q) === JSON.stringify(query))) queue.push(query);
    };
    for (const option of job.output!.options) {
      let draft = job.request.draft ? applyTravel(trip, job.request.draft) : trip;
      option.routes.forEach(add);
      for (const [index, intent] of option.actions.entries()) {
        const action = intentAction(
          draft,
          job.request.dayId,
          intent,
          `${hash(job.id).slice(0, 40)}-trial-${index}`,
        );
        if (intent.type === 'add' && (!intent.placeId || !allowed.has(intent.placeId)))
          throw new AiPlanError(
            'invalid',
            'La nuova tappa deve usare un luogo presente nel contesto verificato.',
          );
        const needs = routeNeeds(draft, action);
        needs.forEach((r) =>
          add({ fromPlaceId: r.fromPlaceId, toPlaceId: r.toPlaceId, poiPlaceIds: [] }),
        );
        draft = applyTravel(draft, {
          id: `${hash(job.id).slice(0, 40)}-trial-${index}`,
          action,
          routes: needs,
          expected: preconditions(draft, action),
          at: job.createdAt,
        });
      }
    }
    if (queue.length > 6)
      throw new AiPlanError(
        'invalid',
        'Sono richiesti troppi percorsi. Dividi la modifica in richieste più piccole.',
      );
    return queue;
  }
  private proposal(trip: Trip, job: Job, index: number): AiProposal {
    const original = trip;
    trip = this.withLocations(
      this.withInformation(withDiscovery(trip, job.discovery), job.information),
      job.locations,
    );
    const option = job.output!.options[index];
    let draft = job.request.draft ? applyTravel(trip, job.request.draft) : trip;
    const commands: TravelCommand[] = job.request.draft ? [job.request.draft] : [];
    if (job.output?.historyRequest) {
      if (
        index ||
        option.actions.length ||
        option.routes.length ||
        job.information.length ||
        job.locations.length ||
        job.request.draft ||
        !undoChoices(original, job.request.dayId).some(
          (h) => h.id === job.output!.historyRequest && h.available,
        )
      )
        throw new AiPlanError(
          'invalid',
          'L’annullamento richiede una modifica disponibile della giornata e una proposta separata.',
        );
      const action = { type: 'undo' as const, historyId: job.output.historyRequest };
      const command = {
        id: `${hash(job.id).slice(0, 40)}-undo`,
        action,
        routes: [],
        expected: preconditions(draft, action),
        at: job.createdAt,
      };
      draft = applyTravel(draft, command);
      commands.push(command);
    }
    for (const [i, intent] of option.actions.entries()) {
      const action = intentAction(
        draft,
        job.request.dayId,
        intent,
        `${hash(job.id).slice(0, 40)}-option-${index}-${i}`,
      );
      const needs = routeNeeds(draft, action);
      const routes = needs.map((need) => {
        const result = job.routes.find(
          (r) =>
            r.fromPlaceId === need.fromPlaceId && r.toPlaceId === need.toPlaceId && !r.pois.length,
        );
        if (!result) throw new AiPlanError('invalid', 'Mancano i dati di un nuovo collegamento.');
        return { ...need, durationMinutes: result.durationMinutes };
      });
      const command: TravelCommand = {
        id: `${hash(job.id).slice(0, 40)}-option-${index}-${i}`,
        action,
        routes,
        expected: preconditions(draft, action),
        at: job.createdAt,
      };
      draft = applyTravel(draft, command);
      commands.push(command);
    }
    const context = aiContext(
      trip,
      job.request,
      job.discovery.places.map((p) => p.id),
    );
    const citations = option.sourceIds.map((id) => {
      const source = context.sources.find((s) => s.id === id);
      if (!source)
        throw new AiPlanError('invalid', 'Una fonte suggerita non appartiene alla giornata.');
      return {
        title: source.title,
        ...(source.url ? { url: source.url } : {}),
        description: source.description,
        estimate: !source.status.startsWith('verified_'),
      };
    });
    const needed = new Set(
      routeNeedsForCommands(trip, commands).map((r) => `${r.fromPlaceId}:${r.toPlaceId}`),
    );
    const routes = job.routes.filter(
      (r) =>
        draft.plan.days
          .find((day) => day.id === job.request.dayId)
          ?.stepIds.some((id) => {
            const step = draft.plan.steps.find((step) => step.id === id);
            return (
              step?.kind === 'leg' &&
              step.mode === 'walk' &&
              step.fromPlaceId === r.fromPlaceId &&
              step.toPlaceId === r.toPlaceId
            );
          }) &&
        (option.routes.some(
          (q) =>
            q.fromPlaceId === r.fromPlaceId &&
            q.toPlaceId === r.toPlaceId &&
            JSON.stringify(q.poiPlaceIds) === JSON.stringify(r.pois.map((p) => p.placeId)),
        ) ||
          (needed.has(`${r.fromPlaceId}:${r.toPlaceId}`) &&
            !r.pois.length &&
            !option.routes.some(
              (q) => q.fromPlaceId === r.fromPlaceId && q.toPlaceId === r.toPlaceId,
            ))),
    );
    const proposal: AiProposalInput = {
      id: `proposal-${hash(job.id).slice(0, 40)}-${index}`,
      tripId: job.tripId,
      jobId: job.id,
      dayId: job.request.dayId,
      baseEtag: job.baseEtag,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      title: option.title,
      explanation: option.explanation,
      warnings: [
        'Le proposte non modificano o cancellano prenotazioni. Verifica aperture e disponibilità.',
        ...job.discovery.notes.filter((note) =>
          note.startsWith('Informazioni non verificate per '),
        ),
      ],
      commands,
      information: job.information.filter((update) =>
        draft.plan.days
          .find((d) => d.id === job.request.dayId)
          ?.stepIds.some((id) => {
            const step = draft.plan.steps.find((s) => s.id === id);
            return step?.kind === 'stop' && step.placeId === update.placeId;
          }),
      ),
      locations: job.locations,
      places: job.discovery.places.filter(
        (p) =>
          commands.some(
            (command) => command.action.type === 'add' && command.action.stop.placeId === p.id,
          ) || routes.some((route) => route.pois.some((poi) => poi.placeId === p.id)),
      ),
      sources: job.discovery.sources.filter(
        (source) =>
          job.locations.some((l) => l.sourceIds.includes(source.id)) ||
          option.sourceIds.includes(source.id) ||
          job.discovery.places.some(
            (p) =>
              p.sourceIds.includes(source.id) &&
              (commands.some(
                (command) => command.action.type === 'add' && command.action.stop.placeId === p.id,
              ) ||
                routes.some((route) => route.pois.some((poi) => poi.placeId === p.id))),
          ),
      ),
      routes,
      citations: [...citations, ...routes.flatMap((r) => r.citations)].slice(0, 20),
    };
    const projected = projectAiProposal(original, proposal);
    this.validateConstraints(original, projected, job);
    for (const update of proposal.information ?? []) {
      const day = projected.plan.days.find((d) => d.id === job.request.dayId)!;
      for (const step of projected.plan.steps.filter(
        (s) => s.kind === 'stop' && s.placeId === update.placeId && day.stepIds.includes(s.id),
      )) {
        if (
          visitWindowStatus(
            update.information,
            step.start,
            step.end,
            step.timezone ?? projected.plan.timezone,
          ) === 'outside'
        )
          proposal.warnings.push(
            `Gli orari di «${step.title}» non rientrano nell’apertura indicata: verifica l’accesso o valuta una visita esterna.`,
          );
      }
    }
    // Check original protected anchors independently of model/manual draft output.
    for (const before of original.plan.steps.filter(
      (s) =>
        original.state.progress[s.id] === 'done' ||
        original.travel?.locks[s.id] ||
        (s.kind === 'leg' && s.mode === 'flight') ||
        original.state.reservations.some((r) => r.stepId === s.id && r.status === 'booked'),
    )) {
      const after = projected.plan.steps.find((s) => s.id === before.id)!;
      if (
        before.start !== after.start ||
        before.end !== after.end ||
        original.plan.days.some((d) => d.stepIds.includes(before.id)) !==
          projected.plan.days.some((d) => d.stepIds.includes(before.id))
      )
        throw new AiPlanError(
          'invalid',
          'La proposta cambierebbe un’attività completata, prenotata o fissa. Modifica le tappe attorno.',
        );
    }
    return AiProposalSchema.parse({ ...proposal, previewHash: previewHash(projected) });
  }
  async advance(tripId: string, id: string) {
    const provider = this.provider();
    let { job } = await this.readJob(tripId, id);
    if (terminal.has(job.status)) return this.get(tripId, id);
    if (job.status === 'running') {
      if (this.now() - Date.parse(job.startedAt!) > 50_000) {
        await this.cancel(tripId, id);
        await this.changeJob(tripId, id, (j) => {
          j.status = 'uncertain';
          j.message = 'Richiesta interrotta. La spesa deve essere verificata prima di riprovare.';
        });
      }
      return this.get(tripId, id);
    }
    const { trip, etag } = await this.trips.read(tripId);
    if (etag !== job.baseEtag || Date.parse(job.expiresAt) <= this.now()) {
      await this.cancel(tripId, id);
      throw new ApiError(
        412,
        'Il programma è cambiato o la richiesta è scaduta. Crea una nuova proposta.',
      );
    }
    const owner = randomUUID();
    try {
      job = await this.changeJob(tripId, id, (j) => {
        if (terminal.has(j.status) || j.status === 'running')
          throw new ApiError(409, 'Richiesta già in corso.');
        j.status = 'running';
        j.owner = owner;
        j.startedAt = new Date(this.now()).toISOString();
        j.message =
          j.stage === 'research'
            ? 'Cerco luoghi vicini usando solo informazioni pubbliche…'
            : j.stage === 'lookup'
              ? 'Cerco il luogo richiesto e la sua posizione nelle fonti pubbliche…'
              : j.stage === 'information'
                ? 'Cerco orari, prezzi e informazioni nelle fonti pubbliche…'
                : j.stage === 'model'
                  ? 'Valuto la giornata e gli orari fissi…'
                  : j.stage === 'routes'
                    ? 'Controllo il percorso e i luoghi lungo la strada…'
                    : 'Preparo il confronto con il programma attuale…';
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return this.get(tripId, id);
      throw error;
    }
    const stageStarted = performance.now();
    const update = async (fn: (value: Job) => void) =>
      this.changeJob(tripId, id, (j) => {
        if (j.owner !== owner || j.status !== 'running') return;
        j.task = job.task;
        j.modelRounds = job.modelRounds;
        j.locations = job.locations;
        fn(j);
        if (job.stage !== 'done')
          j.trace.push({
            stage: job.stage,
            outcome: ['failed', 'uncertain'].includes(j.status)
              ? 'failed'
              : (j.status as Job['status']) === 'clarification'
                ? 'clarification'
                : 'done',
            milliseconds: Math.min(120000, Math.round(performance.now() - stageStarted)),
          });
        delete j.owner;
        delete j.startedAt;
      });
    try {
      if (job.stage === 'research') {
        const draft = job.request.draft ? applyTravel(trip, job.request.draft) : trip;
        const context = aiContext(draft, job.request);
        const operation = `${id}-research`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash({ day: context.day, places: context.places }),
          maxCost: provider.discoveryBound(),
        });
        const discovery = AiDiscoverySchema.parse(
          await this.budget.dispatch(id, operation, () =>
            this.bounded((signal) => provider.discover(context, draft, signal)),
          ),
        );
        withDiscovery(trip, discovery);
        await update((j) => {
          j.discovery = discovery;
          j.stage = 'model';
          j.status = 'planning';
        });
      } else if (job.stage === 'model') {
        if (job.modelRounds >= AI_LIMITS.modelRounds)
          throw new AiPlanError(
            'invalid',
            'Il limite di valutazioni è raggiunto. Dividi la richiesta in obiettivi più piccoli.',
          );
        const enriched = this.withLocations(
          this.withInformation(withDiscovery(trip, job.discovery), job.information),
          job.locations,
        );
        const context = aiContext(
          job.request.draft ? applyTravel(enriched, job.request.draft) : enriched,
          job.request,
          job.discovery.places.map((p) => p.id),
          this.now(),
        );
        context.task = job.task;
        context.selectedChoice = job.selectedChoice;
        context.planningFeedback = job.feedback
          ? 'La proposta precedente non rispetta il programma o i vincoli richiesti. Usa tempi misurati e calcoli locali per correggerla; se non è fattibile, spiega il conflitto senza inventare una soluzione.'
          : null;
        context.routeResults = job.routes.map((route) => ({
          fromPlaceId: route.fromPlaceId,
          toPlaceId: route.toPlaceId,
          walkingMinutes: route.durationMinutes,
          pauseMinutes: route.pois.reduce((sum, p) => sum + p.visitMinutes, 0),
          poiPlaceIds: route.pois.map((p) => p.placeId),
          estimate: route.estimate,
        }));
        context.toolsAvailable = {
          discovery: !!provider.lookup && job.lookupRound === 0,
          information: !!provider.informationAvailable && job.informationRound === 0,
          routing: true,
        };
        context.researchNotes = job.discovery.notes;
        context.lookupAvailable =
          job.request.purpose !== 'information' && job.lookupRound === 0 && !!provider.lookup;
        context.conversation = await this.conversation(tripId, job.request, etag);
        const operation = job.modelRounds ? `${id}-model-${job.modelRounds}` : `${id}-model`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash(context),
          maxCost: provider.modelBound(context),
        });
        const raw = await this.budget.dispatch(id, operation, () =>
          this.bounded((signal) => provider.plan(context, signal, operation)),
        );
        const output = AiModelOutputSchema.parse(raw);
        output.options.forEach((option) => {
          option.actions = orderAiIntents(enriched, option.actions);
        });
        const task = output.task ?? {
          goals: output.historyRequest
            ? ['undo']
            : output.informationRequests.length || output.placeInformationRequests.length
              ? ['research']
              : output.options.length || output.lookups.length
                ? ['propose']
                : ['answer'],
          targetStepIds: output.informationRequests.length
            ? output.informationRequests
            : job.request.stepId
              ? [job.request.stepId]
              : [],
          constraints: job.task?.constraints ?? emptyConstraints(),
          pendingQuestion: output.clarification
            ? { question: output.clarification, choices: [] }
            : null,
        };
        if (job.modelRounds > 0 && job.task)
          task.constraints = retainConstraints(job.task.constraints, task.constraints);
        this.validateTask(task, context);
        job.task = task;
        if (
          !!task.pendingQuestion !== !!output.clarification ||
          (output.clarification &&
            (output.options.length ||
              output.lookups.length ||
              output.informationRequests.length ||
              output.placeInformationRequests.length ||
              output.locationRequests.length ||
              output.historyRequest))
        )
          throw new AiPlanError(
            'invalid',
            'La domanda di chiarimento deve precedere ricerche e modifiche.',
          );
        const writes =
          output.options.some((o) => o.actions.length || o.routes.length) ||
          output.locationRequests.length ||
          output.historyRequest;
        if (writes && !task.goals.some((g) => ['propose', 'compare', 'undo'].includes(g)))
          throw new AiPlanError(
            'invalid',
            'Una risposta informativa non può modificare il programma.',
          );
        if (output.historyRequest && (!task.goals.includes('undo') || output.options.length !== 1))
          throw new AiPlanError('invalid', 'Scegli una modifica dalla cronologia da annullare.');
        job.modelRounds++;
        if (job.request.purpose === 'information') {
          if (
            output.options.length ||
            output.lookups.length ||
            output.locationRequests.length ||
            output.historyRequest ||
            output.placeInformationRequests.length ||
            (output.informationRequests.length && output.clarification)
          )
            throw new AiPlanError(
              'invalid',
              'Una richiesta di informazioni non può modificare il programma o calcolare percorsi.',
            );
        }
        if (output.lookups.length) {
          if (!context.lookupAvailable)
            throw new AiPlanError(
              'invalid',
              'La ricerca disponibile è terminata. Specifica il luogo o scegli uno dei risultati trovati.',
            );
          if (
            output.options.length ||
            output.clarification ||
            output.informationRequests.length ||
            output.placeInformationRequests.length ||
            output.locationRequests.length ||
            output.historyRequest
          )
            throw new AiPlanError('invalid', 'La ricerca di un luogo deve precedere la proposta.');
          await update((j) => {
            j.output = output;
            j.stage = 'lookup';
            j.status = 'planning';
            j.message = 'Cerco il luogo richiesto nelle fonti pubbliche…';
          });
          return this.get(tripId, id);
        }
        for (const mapping of output.locationRequests) {
          const target = context.places.find((p) => p.id === mapping.placeId);
          const candidate = job.discovery.places.find((p) => p.id === mapping.candidateId);
          const coords = candidate?.coordinates;
          const sourceIds =
            candidate?.sourceIds.filter((id) =>
              job.discovery.sources.some((s) => s.id === id && s.status.startsWith('verified_')),
            ) ?? [];
          if (
            !target ||
            !context.steps.some(
              (s) =>
                s.kind === 'stop' &&
                'placeId' in s &&
                s.placeId === target.id &&
                ['visit', 'meal', 'free-time'].includes(s.category),
            ) ||
            !candidate ||
            !coords ||
            !sourceIds.length ||
            Date.parse(coords.verifiedOn) > this.now() ||
            this.now() - Date.parse(coords.verifiedOn) > 365 * 24 * 3600_000
          )
            throw new AiPlanError(
              'invalid',
              'La posizione proposta richiede un luogo pubblico e coordinate da una fonte verificata.',
            );
          const update = {
            placeId: target.id,
            candidateId: candidate.id,
            candidateName: candidate.name.slice(0, 160),
            coordinates: coords,
            sourceIds,
          };
          if (!job.locations.some((l) => l.placeId === update.placeId)) job.locations.push(update);
          else if (
            JSON.stringify(job.locations.find((l) => l.placeId === update.placeId)) !==
            JSON.stringify(update)
          )
            throw new AiPlanError(
              'invalid',
              'La posizione del luogo è stata individuata in modo incoerente.',
            );
        }
        if (job.locations.length > 2)
          throw new AiPlanError(
            'invalid',
            'Sono richieste troppe posizioni nella stessa richiesta.',
          );
        if (
          output.placeInformationRequests.some(
            (id) => !job.discovery.places.some((p) => p.id === id),
          )
        )
          throw new AiPlanError(
            'invalid',
            'La ricerca deve usare un luogo pubblico individuato nelle fonti.',
          );
        const requestedInformation = [
          ...output.informationRequests.map((stepId) =>
            this.informationTarget(trip, stepId, job.request.dayId),
          ),
          ...output.placeInformationRequests,
        ];
        if (
          job.informationRound &&
          requestedInformation.some(
            (placeId) =>
              !job.information.some((u) => u.placeId === placeId) &&
              !informationFresh(
                enriched.plan.places.find((p) => p.id === placeId)?.information,
                context.day.date,
                this.now(),
              ),
          )
        )
          throw new AiPlanError(
            'invalid',
            'La ricerca disponibile è terminata. Richiedi le altre informazioni separatamente.',
          );
        if (requestedInformation.length && !provider.informationAvailable)
          throw new AiPlanError(
            'invalid',
            'La ricerca web non è disponibile. Puoi consultare le informazioni già salvate e le fonti della tappa.',
          );
        if (job.informationRound === 0 && provider.informationAvailable && provider.enrich) {
          const ids = [
            ...new Set([
              ...requestedInformation,
              ...output.options.flatMap((o) =>
                o.actions
                  .filter((a) => a.type === 'add')
                  .flatMap((a) => (a.placeId ? [a.placeId] : [])),
              ),
            ]),
          ];
          if (ids.length > 2)
            throw new AiPlanError(
              'invalid',
              'Posso ricercare al massimo due luoghi per richiesta. Scegli quelli prioritari.',
            );
          if (ids.length) {
            // Validate public target identity before persisting a paid research stage.
            ids.forEach((placeId) => this.researchQuery(enriched, placeId, job.request.dayId));
            await update((j) => {
              j.output = output;
              j.informationOnly = !writes && !job.request.draft;
              j.informationQueue = ids;
              j.stage = 'information';
              j.status = 'planning';
            });
            return this.get(tripId, id);
          }
        }
        job.output = output;
        let queue: RouteQuery[];
        try {
          queue = this.collectRoutes(trip, job);
        } catch (error) {
          if (
            error instanceof TravelError &&
            job.modelRounds < AI_LIMITS.modelRounds &&
            !job.informationOnly &&
            !output.historyRequest
          ) {
            await update((j) => {
              j.output = output;
              j.feedback = 'schedule';
              j.stage = 'model';
              j.status = 'planning';
              j.message = 'Rivedo le modifiche per conservare gli impegni fissi…';
            });
            return this.get(tripId, id);
          }
          throw error;
        }
        // Recover missing public locations before any routing dispatch. The
        // traveler need not know coordinates even if the planner omitted lookup.
        if (
          queue.length &&
          provider.validateRoute &&
          context.lookupAvailable &&
          job.modelRounds < AI_LIMITS.modelRounds
        ) {
          const missing = [
            ...new Set(queue.flatMap((q) => [q.fromPlaceId, q.toPlaceId, ...q.poiPlaceIds])),
          ].filter(
            (id) =>
              !context.places.find((p) => p.id === id)?.location.hasCoordinates &&
              !job.locations.some((location) => location.placeId === id),
          );
          if (
            missing.length &&
            missing.length <= 2 &&
            missing.every((id) =>
              context.steps.some(
                (s) =>
                  s.kind === 'stop' &&
                  'placeId' in s &&
                  s.placeId === id &&
                  ['visit', 'meal', 'free-time'].includes(s.category),
              ),
            )
          ) {
            const lookups = AiPlaceLookupsSchema.parse(
              missing.map((id) => ({
                name: context.places.find((p) => p.id === id)!.name,
                area: context.day.destinations.join(', ').slice(0, 80),
              })),
            );
            await update((j) => {
              j.output = { ...output, lookups };
              j.stage = 'lookup';
              j.status = 'planning';
              j.message =
                'Individuo la posizione del luogo nelle fonti pubbliche prima di calcolare il percorso…';
            });
            return this.get(tripId, id);
          }
        }
        await update((j) => {
          j.output = output;
          j.queue = queue.filter(
            (query) =>
              !job.routes.some(
                (r) =>
                  r.fromPlaceId === query.fromPlaceId &&
                  r.toPlaceId === query.toPlaceId &&
                  JSON.stringify(r.pois.map((p) => p.placeId)) ===
                    JSON.stringify(query.poiPlaceIds),
              ),
          );
          j.routeIndex = 0;
          j.feedback = null;
          j.stage =
            output.clarification || !output.options.length
              ? 'done'
              : j.queue.length
                ? 'routes'
                : 'finalize';
          j.status =
            j.stage === 'done'
              ? output.clarification
                ? 'clarification'
                : 'answered'
              : j.queue.length
                ? 'routing'
                : 'planning';
          j.message = output.clarification ?? output.message;
        });
        if (output.clarification || !output.options.length) await this.budget.finish(id);
      } else if (job.stage === 'lookup') {
        if (job.lookupRound !== 0 || !provider.lookup || !job.output?.lookups.length)
          throw new AiPlanError('invalid', 'Ricerca non disponibile.');
        const operation = `${id}-lookup`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash(job.output.lookups),
          maxCost: provider.discoveryBound(),
        });
        const found = AiDiscoverySchema.parse(
          await this.budget.dispatch(id, operation, () =>
            this.bounded((signal) => provider.lookup!(job.output!.lookups, trip, signal)),
          ),
        );
        // Prefer requested landmarks. Preserve already collected evidence for duplicate IDs.
        const places = [
          ...found.places.map((p) => job.discovery.places.find((old) => old.id === p.id) ?? p),
          ...job.discovery.places.filter((p) => !found.places.some((f) => f.id === p.id)),
        ].slice(0, 6);
        const sourceIds = new Set(places.flatMap((p) => p.sourceIds));
        const sources = [
          ...job.discovery.sources,
          ...found.sources.filter((s) => !job.discovery.sources.some((old) => old.id === s.id)),
        ]
          .filter((s) => sourceIds.has(s.id))
          .slice(0, 6);
        const discovery = AiDiscoverySchema.parse({
          places,
          sources,
          notes: [
            'Ricerca per nome completata. Usa i risultati per proporre la modifica; non chiedere di creare manualmente il luogo.',
            ...found.notes,
            ...job.discovery.notes,
          ].slice(0, 6),
        });
        withDiscovery(trip, discovery);
        await update((j) => {
          j.discovery = discovery;
          j.lookupRound = 1;
          j.stage = 'model';
          j.status = 'planning';
        });
      } else if (job.stage === 'information') {
        if (!provider.informationAvailable || !provider.enrich || !provider.enrichmentBound)
          throw new AiPlanError('invalid', 'Ricerca delle informazioni non disponibile.');
        const placeId = job.informationQueue[job.informationIndex];
        const enriched = this.withLocations(withDiscovery(trip, job.discovery), job.locations);
        const query = this.researchQuery(enriched, placeId, job.request.dayId);
        const cachePath = `ai/information/${hash({ version: 1, query })}.json`;
        const cached = await this.store.read(cachePath);
        let cachedValue: unknown;
        try {
          cachedValue = cached ? JSON.parse(new TextDecoder().decode(cached.body)) : undefined;
        } catch {
          /* A corrupt private cache is never evidence. */
        }
        const parsed = PlaceInformationSchema.safeParse(cachedValue);
        const existing = enriched.plan.places.find((p) => p.id === placeId)?.information;
        let information = informationFresh(existing, query.visitDate, this.now())
          ? existing
          : parsed?.success && informationFresh(parsed.data, query.visitDate, this.now())
            ? parsed.data
            : undefined;
        if (!information) {
          const operation = `${id}-information-${job.informationIndex}`;
          await this.budget.reserve(id, {
            id: operation,
            fingerprint: hash(query),
            maxCost: provider.enrichmentBound(),
          });
          const value = await this.budget.dispatch(id, operation, () =>
            this.bounded((signal) => provider.enrich!(query, signal, operation), true),
          );
          if (!value && !job.informationOnly) {
            // Known charges are already settled. Missing optional facts must not
            // prevent a separately sourced place/route proposal. Never retry.
            await update((j) => {
              j.discovery.notes = [
                ...j.discovery.notes,
                `Informazioni non verificate per «${query.name}»: orari, prezzi e dettagli restano da verificare.`,
              ].slice(-6);
              j.informationIndex++;
              const done = j.informationIndex >= j.informationQueue.length;
              j.informationRound = done ? 1 : 0;
              j.stage = done ? 'model' : 'information';
              j.status = 'planning';
            });
            return this.get(tripId, id);
          }
          if (!value)
            throw new AiPlanError(
              'invalid',
              'La ricerca non ha fornito informazioni verificabili. Il programma resta invariato.',
            );
          information = PlaceInformationSchema.parse(value);
          try {
            await this.store.write(cachePath, encode(information), cached?.etag ?? 'create');
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 412)) throw error;
          }
        }
        const unchanged =
          job.informationOnly && JSON.stringify(existing) === JSON.stringify(information);
        await update((j) => {
          j.information.push({ placeId, information: information! });
          j.informationIndex++;
          const done = j.informationIndex >= j.informationQueue.length;
          j.informationRound = done ? 1 : 0;
          j.stage = done ? (j.informationOnly ? 'finalize' : 'model') : 'information';
          j.status = 'planning';
          const saveable = j.information.some((u) =>
            trip.plan.days
              .find((d) => d.id === j.request.dayId)!
              .stepIds.some((id) => {
                const s = trip.plan.steps.find((s) => s.id === id)!;
                return s.kind === 'stop' && s.placeId === u.placeId;
              }),
          );
          if (done && j.informationOnly)
            j.output = AiModelOutputSchema.parse({
              message: unchanged
                ? 'Le informazioni sono già aggiornate per questa data. Nessuna nuova ricerca o modifica.'
                : saveable
                  ? 'Ho raccolto le informazioni del luogo. Controlla fonti, data e prezzi prima di confermare.'
                  : 'Ho raccolto le informazioni del luogo. Consulta fonti, data e prezzi qui sotto; il programma resta invariato.',
              clarification: null,
              lookups: [],
              informationRequests: [],
              options:
                unchanged || !saveable
                  ? []
                  : [
                      {
                        title: 'Aggiorna le informazioni della tappa',
                        explanation:
                          'Aggiunge informazioni consultate nelle fonti pubbliche. Orari del programma, prenotazioni e stima originale dei costi restano invariati.',
                        actions: [],
                        routes: [],
                        sourceIds: [],
                      },
                    ],
            });
          if (
            done &&
            j.informationOnly &&
            (!saveable ||
              (unchanged &&
                j.information.every(
                  (u) =>
                    JSON.stringify(
                      enriched.plan.places.find((p) => p.id === u.placeId)?.information,
                    ) === JSON.stringify(u.information),
                )))
          ) {
            j.stage = 'done';
            j.status = 'answered';
            j.message = j.output!.message;
          }
        });
        const after = (await this.readJob(tripId, id)).job;
        if (after.stage === 'done') await this.budget.finish(id);
      } else if (job.stage === 'routes') {
        if (job.routeCalls >= AI_LIMITS.routes)
          throw new AiPlanError(
            'invalid',
            'Il limite di percorsi è raggiunto. Scegli una modifica più piccola.',
          );
        const query = job.queue[job.routeIndex];
        const enriched = this.withLocations(
          this.withInformation(withDiscovery(trip, job.discovery), job.information),
          job.locations,
        );
        provider.validateRoute?.(query, enriched);
        const operation = `${id}-route-${job.routeCalls}`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash(query),
          maxCost: provider.routeBound(query),
        });
        const route = AiRouteSchema.parse(
          await this.budget.dispatch(id, operation, () =>
            this.bounded((signal) => provider.route(query, enriched, signal)),
          ),
        );
        if (
          route.fromPlaceId !== query.fromPlaceId ||
          route.toPlaceId !== query.toPlaceId ||
          JSON.stringify(route.pois.map((p) => p.placeId)) !== JSON.stringify(query.poiPlaceIds)
        )
          throw new AiPlanError(
            'invalid',
            'Il fornitore ha restituito un percorso diverso dalla richiesta.',
          );
        await update((j) => {
          j.routes.push(route);
          j.routeCalls++;
          j.routeIndex++;
          j.stage = j.routeIndex >= j.queue.length ? 'finalize' : 'routes';
          j.status = 'routing';
        });
      } else if (job.stage === 'finalize') {
        let proposals: AiProposal[];
        try {
          proposals = job.output!.options.map((_, index) => this.proposal(trip, job, index));
        } catch (error) {
          if (
            (error instanceof TravelError || error instanceof AiPlanError) &&
            job.modelRounds < AI_LIMITS.modelRounds &&
            !job.informationOnly &&
            !job.output!.historyRequest &&
            job.task?.goals.some((g) => ['propose', 'compare'].includes(g))
          ) {
            await update((j) => {
              j.feedback = 'constraints';
              j.stage = 'model';
              j.status = 'planning';
              j.message = 'Confronto i tempi verificati con i vincoli e rivedo la proposta…';
            });
            return this.get(tripId, id);
          }
          throw error;
        }
        for (const proposal of proposals) {
          try {
            await this.store.write(this.proposalPath(proposal.id), encode(proposal), 'create');
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 412)) throw error;
          }
        }
        await this.budget.finish(id);
        await update((j) => {
          j.proposalIds = proposals.map((p) => p.id);
          j.status = proposals.length ? 'ready' : 'answered';
          j.stage = 'done';
          j.message = job.output!.message;
        });
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fields = new Set([
          'message',
          'clarification',
          'lookups',
          'name',
          'area',
          'options',
          'title',
          'explanation',
          'actions',
          'type',
          'stepId',
          'placeId',
          'minutes',
          'start',
          'durationMinutes',
          'afterId',
          'routes',
          'fromPlaceId',
          'toPlaceId',
          'poiPlaceIds',
          'sourceIds',
        ]);
        console.warn('AI contract rejected', {
          stage: job.stage,
          issues: error.issues.slice(0, 5).map((issue) => ({
            code: issue.code,
            path: issue.path
              .slice(0, 8)
              .map((part) =>
                typeof part === 'number' ? 'item' : fields.has(String(part)) ? part : 'field',
              )
              .join('.'),
          })),
        });
      }
      let uncertain =
        error instanceof AiBudgetError && ['uncertain', 'pricing'].includes(error.code);
      await this.budget.cancel(id).catch(() => {});
      try {
        const run = (await this.budget.read()).ledger.runs.find((run) => run.id === id);
        uncertain ||= run?.status === 'uncertain';
      } catch {
        uncertain = true;
      }
      await update((j) => {
        j.status = uncertain ? 'uncertain' : 'failed';
        j.failure = uncertain
          ? 'usage'
          : error instanceof AiBudgetError
            ? 'budget'
            : error instanceof z.ZodError
              ? 'contract'
              : error instanceof TravelError || (error instanceof ApiError && error.status === 412)
                ? 'conflict'
                : error instanceof AiPlanError
                  ? 'evidence'
                  : 'provider';
        j.message =
          error instanceof AiBudgetError ||
          error instanceof AiPlanError ||
          error instanceof TravelError ||
          error instanceof ApiError
            ? error.message
            : 'Non riesco a preparare una proposta sicura. Il programma resta invariato.';
      });
    }
    return this.get(tripId, id);
  }
  async cancel(tripId: string, id: string) {
    const { job } = await this.readJob(tripId, id);
    if (job.status === 'applied') return this.get(tripId, id);
    if (job.status === 'applying')
      throw new ApiError(
        409,
        'La proposta viene applicata. Aggiorna il programma per verificare il risultato.',
      );
    await this.budget.cancel(id);
    await this.changeJob(tripId, id, (j) => {
      if (j.status !== 'applied') {
        j.status = 'cancelled';
        j.message =
          'Richiesta annullata. Il programma resta invariato. Le chiamate già avviate possono essere addebitate.';
      }
    });
    return this.get(tripId, id);
  }
  async apply(tripId: string, proposalId: string, approvedHash: string, expected?: string) {
    if (!expected) throw new ApiError(428, 'Aggiorna il viaggio prima di applicare la proposta.');
    const item = await this.store.read(this.proposalPath(proposalId));
    if (!item) throw new ApiError(404, 'Proposta non disponibile.');
    const proposal = AiProposalSchema.parse(JSON.parse(new TextDecoder().decode(item.body)));
    if (proposal.tripId !== tripId) throw new ApiError(404, 'Proposta non disponibile.');
    if (approvedHash !== proposal.previewHash)
      throw new ApiError(409, 'Conferma l’anteprima corretta prima di applicarla.');
    const current = await this.trips.read(tripId);
    // The atomic trip marker is authoritative even if the job-status write failed.
    if (current.trip.travel?.appliedIds.includes(proposal.id)) return current;
    const { job } = await this.readJob(tripId, proposal.jobId);
    if (
      !['ready', 'applying'].includes(job.status) ||
      job.supersededBy ||
      !job.proposalIds.includes(proposalId) ||
      Date.parse(proposal.expiresAt) <= this.now()
    )
      throw new ApiError(409, 'Proposta scaduta o annullata. Richiedi una nuova valutazione.');
    if (expected !== current.etag || current.etag !== proposal.baseEtag)
      throw new ApiError(412, 'Il programma condiviso è cambiato. Genera una nuova proposta.');
    const projected = projectAiProposal(current.trip, proposal);
    if (previewHash(projected) !== approvedHash)
      throw new ApiError(409, 'L’anteprima non coincide con la proposta.');
    try {
      await this.changeJob(tripId, job.id, (j) => {
        if (!['ready', 'applying'].includes(j.status) || j.supersededBy)
          throw new ApiError(409, 'La proposta è stata annullata.');
        j.status = 'applying';
        j.message = 'Applico la proposta al programma condiviso…';
      });
    } catch (error) {
      const latest = await this.trips.read(tripId);
      if (latest.trip.travel?.appliedIds.includes(proposal.id)) return latest;
      throw error;
    }
    let saved: Awaited<ReturnType<TripService['read']>>;
    try {
      saved = await this.trips.mutate(
        tripId,
        current.etag,
        (trip) => Object.assign(trip, projected),
        true,
      );
    } catch (error) {
      const latest = await this.trips.read(tripId).catch(() => undefined);
      if (latest?.trip.travel?.appliedIds.includes(proposal.id)) return latest;
      await this.changeJob(tripId, job.id, (j) => {
        if (j.status === 'applying') j.status = 'ready';
      }).catch(() => {});
      throw error;
    }
    await this.changeJob(tripId, job.id, (j) => {
      j.status = 'applied';
      j.message = 'Proposta applicata al programma condiviso.';
    }).catch(() => {});
    return saved;
  }
}

function routeNeedsForCommands(trip: Trip, commands: TravelCommand[]) {
  const needs: ReturnType<typeof routeNeeds> = [];
  for (const command of commands) {
    needs.push(...routeNeeds(trip, command.action));
    trip = applyTravel(trip, command);
  }
  return needs;
}
