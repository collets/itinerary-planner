import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Id, type Trip } from '../domain/schema.js';
import {
  AiRequestSchema,
  AiModelOutputSchema,
  AiRouteSchema,
  AiProposalSchema,
  AiPlanError,
  aiContext,
  intentAction,
  projectAiProposal,
  type AiRequest,
  type AiProposal,
  type AiProposalInput,
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
      'clarification',
      'failed',
      'uncertain',
      'cancelled',
      'applying',
      'applied',
    ]),
    stage: z.enum(['model', 'routes', 'finalize', 'done']),
    message: z.string().max(4000),
    owner: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    output: AiModelOutputSchema.optional(),
    queue: z
      .array(z.object({ fromPlaceId: Id, toPlaceId: Id, poiPlaceIds: z.array(Id).max(3) }).strict())
      .max(6)
      .default([]),
    routeIndex: z.number().int().min(0).max(6).default(0),
    routes: z.array(AiRouteSchema).max(6).default([]),
    proposalIds: z.array(Id).max(2).default([]),
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
};

export const previewHash = (trip: Trip) =>
  hash({ plan: trip.plan, state: trip.state, travel: trip.travel });

export class AiService {
  budget: AiBudgetService;
  constructor(
    private trips: TripService,
    private providers: AiProviders | undefined,
    private now: () => number = Date.now,
    private timeoutMs = 40_000,
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
  async availability() {
    if (!this.providers) return { enabled: false, mode: 'off' as const };
    const budget = await this.budget.status();
    return { enabled: budget.enabled, mode: this.providers.mode };
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
  async get(tripId: string, id: string): Promise<AiJobView> {
    // Trip existence is checked even for cached jobs; deleted trips stay private.
    await this.trips.read(tripId);
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
    return {
      id: job.id,
      tripId,
      dayId: job.request.dayId,
      status: abandoned ? 'uncertain' : job.status,
      message: abandoned
        ? 'Richiesta interrotta. La spesa deve essere verificata; non viene riavviata automaticamente.'
        : job.message,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      mock: this.providers?.mode === 'mock',
      proposals,
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
      return this.get(tripId, request.id);
    }
    const provider = this.provider();
    const { trip, etag } = await this.trips.read(tripId);
    if (etag !== expected)
      throw new ApiError(412, 'Il programma è cambiato. Aggiorna prima di chiedere assistenza.');
    const draft = request.draft ? applyTravel(trip, request.draft) : trip;
    const context = aiContext(draft, request);
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
      stage: 'model',
      message: 'Richiesta pronta. Il programma resta invariato.',
    });
    await this.budget.start({ id: request.id, scope: tripId, requestHash });
    try {
      await this.store.write(this.jobPath(job.id), encode(job), 'create');
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        const { job: concurrent } = await this.readJob(tripId, job.id);
        if (concurrent.requestHash === requestHash) return this.get(tripId, job.id);
      }
      await this.budget.cancel(job.id).catch(() => {});
      throw error;
    }
    return this.get(tripId, job.id);
  }
  private async bounded<T>(fn: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('AI stage deadline'));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private collectRoutes(trip: Trip, job: Job): RouteQuery[] {
    const queue: RouteQuery[] = [];
    const context = aiContext(
      job.request.draft ? applyTravel(trip, job.request.draft) : trip,
      job.request,
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
        const action = intentAction(draft, job.request.dayId, intent);
        const needs = routeNeeds(draft, action);
        needs.forEach((r) =>
          add({ fromPlaceId: r.fromPlaceId, toPlaceId: r.toPlaceId, poiPlaceIds: [] }),
        );
        draft = applyTravel(draft, {
          id: `${job.id.slice(0, 55)}-trial-${index}`,
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
    const option = job.output!.options[index];
    let draft = job.request.draft ? applyTravel(trip, job.request.draft) : trip;
    const commands: TravelCommand[] = job.request.draft ? [job.request.draft] : [];
    for (const [i, intent] of option.actions.entries()) {
      const action = intentAction(draft, job.request.dayId, intent);
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
        id: `${job.id.slice(0, 55)}-option-${index}-${i}`,
        action,
        routes,
        expected: preconditions(draft, action),
        at: job.createdAt,
      };
      draft = applyTravel(draft, command);
      commands.push(command);
    }
    const context = aiContext(trip, job.request);
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
        option.routes.some(
          (q) =>
            q.fromPlaceId === r.fromPlaceId &&
            q.toPlaceId === r.toPlaceId &&
            JSON.stringify(q.poiPlaceIds) === JSON.stringify(r.pois.map((p) => p.placeId)),
        ) ||
        (needed.has(`${r.fromPlaceId}:${r.toPlaceId}`) &&
          !r.pois.length &&
          !option.routes.some(
            (q) => q.fromPlaceId === r.fromPlaceId && q.toPlaceId === r.toPlaceId,
          )),
    );
    const proposal: AiProposalInput = {
      id: `proposal-${job.id.slice(0, 55)}-${index}`,
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
      ],
      commands,
      routes,
      citations: [...citations, ...routes.flatMap((r) => r.citations)].slice(0, 20),
    };
    const projected = projectAiProposal(trip, proposal);
    // Every booked activity is protected, including reservations without a slot.
    for (const reservation of trip.state.reservations.filter((r) => r.status === 'booked')) {
      const before = trip.plan.steps.find((s) => s.id === reservation.stepId)!;
      const after = projected.plan.steps.find((s) => s.id === before.id)!;
      if (
        before.start !== after.start ||
        before.end !== after.end ||
        trip.plan.days.some((d) => d.stepIds.includes(before.id)) !==
          projected.plan.days.some((d) => d.stepIds.includes(before.id))
      )
        throw new AiPlanError(
          'invalid',
          'La proposta cambierebbe una visita prenotata. Mantieni la prenotazione e modifica le tappe attorno.',
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
          j.stage === 'model'
            ? 'Valuto la giornata e gli orari fissi…'
            : j.stage === 'routes'
              ? 'Controllo il percorso e i luoghi lungo la strada…'
              : 'Preparo il confronto con il programma attuale…';
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return this.get(tripId, id);
      throw error;
    }
    const update = async (fn: (value: Job) => void) =>
      this.changeJob(tripId, id, (j) => {
        if (j.owner !== owner || j.status !== 'running') return;
        fn(j);
        delete j.owner;
        delete j.startedAt;
      });
    try {
      if (job.stage === 'model') {
        const context = aiContext(
          job.request.draft ? applyTravel(trip, job.request.draft) : trip,
          job.request,
        );
        const operation = `${id}-model`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash(context),
          maxCost: provider.modelBound(context),
        });
        const raw = await this.budget.dispatch(id, operation, () =>
          this.bounded((signal) => provider.plan(context, signal)),
        );
        const output = AiModelOutputSchema.parse(raw);
        job.output = output;
        const queue = this.collectRoutes(trip, job);
        await update((j) => {
          j.output = output;
          j.queue = queue;
          j.stage =
            output.clarification || !output.options.length
              ? 'done'
              : queue.length
                ? 'routes'
                : 'finalize';
          j.status = j.stage === 'done' ? 'clarification' : queue.length ? 'routing' : 'planning';
          j.message = output.clarification ?? output.message;
        });
        if (output.clarification || !output.options.length) await this.budget.finish(id);
      } else if (job.stage === 'routes') {
        const query = job.queue[job.routeIndex];
        const operation = `${id}-route-${job.routeIndex}`;
        await this.budget.reserve(id, {
          id: operation,
          fingerprint: hash(query),
          maxCost: provider.routeBound(query),
        });
        const route = AiRouteSchema.parse(
          await this.budget.dispatch(id, operation, () =>
            this.bounded((signal) => provider.route(query, trip, signal)),
          ),
        );
        if (
          route.fromPlaceId !== query.fromPlaceId ||
          route.toPlaceId !== query.toPlaceId ||
          route.pois.some((p) => !query.poiPlaceIds.includes(p.placeId))
        )
          throw new AiPlanError(
            'invalid',
            'Il fornitore ha restituito un percorso diverso dalla richiesta.',
          );
        await update((j) => {
          j.routes.push(route);
          j.routeIndex++;
          j.stage = j.routeIndex >= j.queue.length ? 'finalize' : 'routes';
          j.status = 'routing';
        });
      } else if (job.stage === 'finalize') {
        const proposals: AiProposal[] = [];
        for (let i = 0; i < job.output!.options.length; i++) {
          const proposal = this.proposal(trip, job, i);
          try {
            await this.store.write(this.proposalPath(proposal.id), encode(proposal), 'create');
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 412)) throw error;
          }
          proposals.push(proposal);
        }
        await this.budget.finish(id);
        await update((j) => {
          j.proposalIds = proposals.map((p) => p.id);
          j.status = 'ready';
          j.stage = 'done';
          j.message = job.output!.message;
        });
      }
    } catch (error) {
      const uncertain =
        error instanceof AiBudgetError && ['uncertain', 'pricing'].includes(error.code);
      await this.budget.cancel(id).catch(() => {});
      await update((j) => {
        j.status = uncertain ? 'uncertain' : 'failed';
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
        if (!['ready', 'applying'].includes(j.status))
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
