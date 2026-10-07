import { z } from 'zod';
import { Id, SafeUrl, PlaceSchema, SourceSchema, TripSchema, type Trip } from './schema.js';
import {
  TravelCommandSchema,
  applyTravel,
  fingerprint,
  preconditions,
  upgradeTrip,
  type TravelAction,
  type TravelCommand,
} from './travel.js';

const timestamp = z.iso.datetime({ offset: true });
export function isAiDraftAllowed(command: TravelCommand, dayId: string) {
  const action = command.action;
  return (
    ['delay', 'timing', 'skip', 'move', 'add'].includes(action.type) &&
    'dayId' in action &&
    action.dayId === dayId &&
    !(action.type === 'move' && action.toDayId !== dayId) &&
    !(action.type === 'timing' && action.leaveAt) &&
    !(action.type === 'skip' && action.acknowledgedBooking)
  );
}
export const AiRequestSchema = z
  .object({
    id: Id,
    dayId: Id,
    stepId: Id.optional(),
    parentJobId: Id.optional(),
    text: z.string().trim().min(1).max(2000),
    preference: z.enum(['fastest', 'scenic']).default('fastest'),
    draft: TravelCommandSchema.optional(),
  })
  .strict()
  .refine((request) => !request.draft || isAiDraftAllowed(request.draft, request.dayId), {
    path: ['draft'],
    message: 'La richiesta AI può includere solo modifiche flessibili nella stessa giornata.',
  });
export type AiRequest = z.infer<typeof AiRequestSchema>;

// Required nullable fields deliberately match the strict Responses JSON format.
// Models express intentions; only the server constructs commands and versions.
export const AiIntentSchema = z
  .object({
    type: z.enum(['delay', 'timing', 'skip', 'move', 'add']),
    stepId: Id.nullable(),
    placeId: Id.nullable(),
    title: z.string().min(1).max(150).nullable(),
    minutes: z.number().int().min(1).max(720).nullable(),
    start: timestamp.nullable(),
    durationMinutes: z.number().int().min(1).max(720).nullable(),
    afterId: Id.nullable(),
  })
  .strict();
// Only public landmark names and a city/area can cross the research boundary.
// No URLs, search operators, credentials or arbitrary tool parameters.
const publicName = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[\p{L}\p{M}\p{N} ,'’()-]+$/u);
export const AiPlaceLookupSchema = z
  .object({ name: publicName(120), area: publicName(80) })
  .strict();
export const AiPlaceLookupsSchema = z.array(AiPlaceLookupSchema).max(2);
export type AiPlaceLookup = z.infer<typeof AiPlaceLookupSchema>;
export const AiModelOutputSchema = z
  .object({
    message: z.string().max(3000),
    clarification: z.string().max(1000).nullable(),
    // Default preserves proposals/jobs saved before named lookup was introduced.
    lookups: AiPlaceLookupsSchema.default([]),
    options: z
      .array(
        z
          .object({
            title: z.string().min(1).max(120),
            explanation: z.string().min(1).max(2000),
            actions: z.array(AiIntentSchema).max(6),
            routes: z
              .array(
                z
                  .object({
                    fromPlaceId: Id,
                    toPlaceId: Id,
                    poiPlaceIds: z.array(Id).max(3),
                  })
                  .strict(),
              )
              .max(3),
            sourceIds: z.array(Id).max(10),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type AiModelOutput = z.infer<typeof AiModelOutputSchema>;
export type AiIntent = z.infer<typeof AiIntentSchema>;
export const AiDiscoverySchema = z
  .object({
    places: z.array(PlaceSchema).max(6),
    sources: z.array(SourceSchema).max(6),
    notes: z.array(z.string().max(1000)).max(6),
  })
  .strict();
export type AiDiscovery = z.infer<typeof AiDiscoverySchema>;
export function withDiscovery(input: Trip, discovery: AiDiscovery): Trip {
  const trip = structuredClone(input);
  for (const [items, additions] of [
    [trip.plan.places, discovery.places],
    [trip.plan.sources, discovery.sources],
  ] as const) {
    for (const addition of additions) {
      const existing = items.find((item) => item.id === addition.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(addition))
        throw new AiPlanError('conflict', 'Un luogo o una fonte ha un ID già utilizzato.');
      if (!existing) (items as Array<typeof addition>).push(structuredClone(addition));
    }
  }
  return TripSchema.parse(trip);
}

export const AiCitationSchema = z
  .object({
    title: z.string().min(1).max(250),
    url: SafeUrl.optional(),
    description: z.string().max(1000),
    checkedAt: timestamp.optional(),
    estimate: z.boolean(),
  })
  .strict();
export const AiRouteSchema = z
  .object({
    fromPlaceId: Id,
    toPlaceId: Id,
    durationMinutes: z.number().int().min(1).max(720),
    distanceKm: z.number().min(0).max(100).optional(),
    streets: z.array(z.string().max(150)).max(40),
    pois: z
      .array(
        z
          .object({
            placeId: Id,
            note: z.string().max(800),
            detourMinutes: z.number().min(0).max(120),
            visitMinutes: z.number().int().min(0).max(120),
          })
          .strict(),
      )
      .max(3),
    estimate: z.boolean(),
    provider: z.enum(['existing-itinerary', 'openrouteservice', 'mock']),
    checkedAt: timestamp,
    directMinutes: z.number().int().min(1).max(720),
    extraWalkingMinutes: z.number().int().min(0).max(120),
    geometry: z
      .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
      .max(2000),
    citations: z.array(AiCitationSchema).max(8),
  })
  .strict();
export type AiRoute = z.infer<typeof AiRouteSchema>;
export const AiProposalSchema = z
  .object({
    id: Id,
    tripId: Id,
    jobId: Id,
    dayId: Id,
    baseEtag: z.string().min(1).max(256),
    createdAt: timestamp,
    expiresAt: timestamp,
    title: z.string().min(1).max(120),
    explanation: z.string().max(3000),
    warnings: z.array(z.string().max(1000)).max(10),
    commands: z.array(TravelCommandSchema).max(8),
    places: z.array(PlaceSchema).max(6).default([]),
    sources: z.array(SourceSchema).max(6).default([]),
    routes: z.array(AiRouteSchema).max(6),
    citations: z.array(AiCitationSchema).max(20),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AiProposal = z.infer<typeof AiProposalSchema>;
export type AiProposalInput = Omit<AiProposal, 'previewHash'>;

export class AiPlanError extends Error {
  constructor(
    public code: 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'AiPlanError';
  }
}

/** Explicit allowlist: never serialize a Trip or operational state to a model. */
export function aiContext(trip: Trip, request: AiRequest, candidates: string[] = []) {
  const day = trip.plan.days.find((d) => d.id === request.dayId);
  if (!day) throw new AiPlanError('invalid', 'Scegli una giornata del viaggio.');
  const steps = day.stepIds.map((id) => trip.plan.steps.find((s) => s.id === id)!);
  if (steps.length > 60)
    throw new AiPlanError('invalid', 'Questa giornata è troppo grande per l’assistenza AI.');
  if (request.stepId && !day.stepIds.includes(request.stepId))
    throw new AiPlanError('invalid', 'La tappa scelta non appartiene alla giornata.');
  const placeIds = new Set(
    steps.flatMap((s) =>
      s.kind === 'stop'
        ? [s.placeId]
        : [s.fromPlaceId, s.toPlaceId, ...s.pois.map((p) => p.placeId)],
    ),
  );
  candidates.forEach((id) => placeIds.add(id));
  const sources = new Set(steps.flatMap((s) => s.sourceIds));
  const places = trip.plan.places.filter((p) => placeIds.has(p.id)).slice(0, 80);
  places.forEach((p) => p.sourceIds.forEach((id) => sources.add(id)));
  const text = (v: string, max = 500) =>
    [...v]
      .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
      .join('')
      .slice(0, max);
  const publicUrl = (value?: string) => {
    if (!value) return null;
    const url = new URL(value);
    if (url.username || url.password) return null;
    // Authentication/signature parameters are unnecessary for public research.
    url.search = '';
    url.hash = '';
    return url.toString();
  };
  return {
    day: { id: day.id, date: day.date, timezone: trip.plan.timezone },
    researchNotes: [] as string[],
    lookupAvailable: false,
    conversation: [] as Array<{
      request: string;
      response: string;
      options: string[];
      previousPlan: boolean;
    }>,
    request: { text: request.text, preference: request.preference, stepId: request.stepId ?? null },
    steps: steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: text(s.title, 160),
      start: s.start,
      end: s.end,
      summary: text(s.summary),
      optional: s.optional,
      completed: trip.state.progress[s.id] === 'done',
      fixed: !!trip.travel?.locks[s.id] || (s.kind === 'leg' && s.mode === 'flight'),
      booked: trip.state.reservations.some((r) => r.stepId === s.id && r.status === 'booked'),
      bookedStart:
        trip.state.reservations.find((r) => r.stepId === s.id && r.status === 'booked')?.slot ??
        null,
      ...(s.kind === 'stop'
        ? { placeId: s.placeId }
        : {
            fromPlaceId: s.fromPlaceId,
            toPlaceId: s.toPlaceId,
            mode: s.mode,
            durationMinutes: s.durationMinutes,
            estimate: s.estimate,
            streets: s.streets.slice(0, 20).map((v) => text(v, 100)),
            poiPlaceIds: s.pois.map((p) => p.placeId),
          }),
    })),
    places: places.map((p) => ({
      id: p.id,
      name: text(p.name, 160),
      address: text(p.address, 250),
      description: text(p.description),
      openingHours: text(p.openingHours),
      sourceIds: p.sourceIds.slice(0, 10),
    })),
    sources: trip.plan.sources
      .filter((s) => sources.has(s.id) && s.status !== 'user_provided')
      .slice(0, 30)
      .map((s) => ({
        id: s.id,
        title: text(s.title, 160),
        description: text(s.description),
        status: s.status,
        verifiedOn: s.verifiedOn ?? null,
        url: publicUrl(s.url),
      })),
  };
}
export type AiContext = ReturnType<typeof aiContext>;

export function intentAction(
  trip: Trip,
  dayId: string,
  intent: AiIntent,
  commandId = 'ai-new-stop',
): TravelAction {
  const day = trip.plan.days.find((d) => d.id === dayId);
  if (intent.type === 'add') {
    const place = trip.plan.places.find((p) => p.id === intent.placeId);
    const after = trip.plan.steps.find((s) => s.id === intent.afterId);
    if (
      !day ||
      !place ||
      intent.stepId !== null ||
      intent.minutes !== null ||
      !intent.durationMinutes ||
      !intent.title ||
      (intent.afterId && (!after || !day.stepIds.includes(after.id)))
    )
      throw new AiPlanError(
        'invalid',
        'La nuova tappa deve usare un luogo verificato e una posizione valida.',
      );
    const start =
      intent.start ?? after?.end ?? trip.plan.steps.find((s) => s.id === day.stepIds[0])?.start;
    if (!start) throw new AiPlanError('invalid', 'Indica l’orario della nuova tappa.');
    return {
      type: 'add',
      dayId,
      ...(intent.afterId ? { afterId: intent.afterId } : {}),
      stop: {
        id: `stop-${commandId.slice(0, 70)}`,
        kind: 'stop',
        placeId: place.id,
        category: 'free-time',
        title: intent.title,
        start,
        end: new Date(Date.parse(start) + intent.durationMinutes * 60000).toISOString(),
        summary: 'Sosta suggerita: durata indicativa, costo e disponibilità da verificare.',
        details: '',
        sourceIds: place.sourceIds,
        sourceActivityIds: [],
        notes: [],
        optional: true,
      },
    };
  }
  if (intent.placeId !== null || intent.title !== null)
    throw new AiPlanError('invalid', 'La modifica contiene campi non previsti.');
  const step = trip.plan.steps.find((s) => s.id === intent.stepId);
  if (!step || !day?.stepIds.includes(step.id))
    throw new AiPlanError('invalid', 'L’assistente ha indicato una tappa non disponibile.');
  if (
    trip.state.progress[step.id] === 'done' ||
    trip.travel?.locks[step.id] ||
    trip.state.reservations.some((r) => r.stepId === step.id && r.status === 'booked') ||
    (step.kind === 'leg' && step.mode === 'flight')
  )
    throw new AiPlanError(
      'invalid',
      'L’assistente deve conservare le attività completate, prenotate e gli orari fissi.',
    );
  const base = { dayId, stepId: step.id };
  if (
    intent.type === 'delay' &&
    intent.minutes !== null &&
    intent.start === null &&
    intent.durationMinutes === null &&
    intent.afterId === null
  )
    return { type: 'delay', ...base, minutes: intent.minutes };
  if (
    intent.type === 'timing' &&
    intent.minutes === null &&
    intent.afterId === null &&
    (intent.start !== null || intent.durationMinutes !== null)
  )
    return {
      type: 'timing',
      ...base,
      following: true,
      ...(intent.start ? { start: intent.start } : {}),
      ...(intent.durationMinutes ? { durationMinutes: intent.durationMinutes } : {}),
    };
  if (
    intent.type === 'skip' &&
    intent.minutes === null &&
    intent.start === null &&
    intent.durationMinutes === null &&
    intent.afterId === null
  )
    return { type: 'skip', ...base, included: false, acknowledgedBooking: false };
  if (
    intent.type === 'move' &&
    intent.minutes === null &&
    intent.start === null &&
    intent.durationMinutes === null
  )
    return {
      type: 'move',
      ...base,
      toDayId: dayId,
      ...(intent.afterId ? { afterId: intent.afterId } : {}),
    };
  throw new AiPlanError('invalid', 'La modifica proposta non è valida.');
}

/** Project a whole approved batch on a clone; one history item, one later CAS write. */
export function projectAiProposal(input: Trip, proposal: AiProposalInput): Trip {
  let trip = upgradeTrip(input);
  if (trip.travel!.appliedIds.includes(proposal.id)) return trip;
  const before = {
    plan: structuredClone(trip.plan),
    notes: { ...trip.travel!.notes },
    locks: { ...trip.travel!.locks },
    completedAt: { ...trip.travel!.completedAt },
    progress: { ...trip.state.progress },
  };
  const previousHistory = structuredClone(trip.travel!.history);
  const previousIds = [...trip.travel!.appliedIds];
  trip = withDiscovery(trip, { places: proposal.places, sources: proposal.sources, notes: [] });
  const keys = new Set<string>();
  for (const command of proposal.commands) {
    // The manual draft is validated by the existing engine. Model commands have
    // already passed the narrower intent allowlist before being persisted.
    Object.keys(preconditions(trip, command.action)).forEach((k) => keys.add(k));
    trip = applyTravel(trip, command);
  }
  let routeIndex = 0;
  for (const route of proposal.routes) {
    const legs = trip.plan.steps.filter(
      (s) =>
        s.kind === 'leg' &&
        s.mode === 'walk' &&
        s.fromPlaceId === route.fromPlaceId &&
        s.toPlaceId === route.toPlaceId &&
        trip.plan.days.find((d) => d.id === proposal.dayId)?.stepIds.includes(s.id),
    );
    if (!legs.length)
      throw new AiPlanError('invalid', 'Il collegamento suggerito non è presente nel programma.');
    for (const leg of legs) {
      if (leg.kind !== 'leg') continue;
      if (trip.state.progress[leg.id] === 'done' || trip.travel!.locks[leg.id])
        throw new AiPlanError(
          'invalid',
          'Un percorso completato o fisso non può essere modificato.',
        );
      const dayId = trip.plan.days.find((d) => d.stepIds.includes(leg.id))!.id;
      keys.add(`day:${dayId}`);
      if (route.pois.some((p) => !trip.plan.places.some((place) => place.id === p.placeId)))
        throw new AiPlanError(
          'invalid',
          'Un punto di interesse non è presente nel catalogo verificato.',
        );
      const dwell = route.pois.reduce((n, p) => n + p.visitMinutes, 0);
      const action: TravelAction = {
        type: 'timing',
        dayId,
        stepId: leg.id,
        durationMinutes: route.durationMinutes + dwell,
        following: true,
      };
      trip = applyTravel(trip, {
        id: `${proposal.id.slice(0, 55)}-route-${routeIndex++}`,
        action,
        routes: [],
        expected: preconditions(trip, action),
        at: proposal.createdAt,
      });
      const updated = trip.plan.steps.find((s) => s.id === leg.id)!;
      if (updated.kind !== 'leg') continue;
      updated.distanceKm = route.distanceKm;
      updated.estimate = route.estimate;
      updated.streets = route.streets;
      updated.pois = route.pois;
      updated.routeEvidence = {
        provider: route.provider,
        checkedAt: route.checkedAt,
        walkingMinutes: route.durationMinutes,
        visitMinutes: dwell,
        directMinutes: route.directMinutes,
        extraWalkingMinutes: route.extraWalkingMinutes,
        geometry: route.geometry,
        citations: route.citations,
      };
      updated.summary = `${route.durationMinutes} min a piedi${dwell ? ` + ${dwell} min per le soste` : ''}. ${route.estimate ? 'Tempo stimato.' : 'Percorso calcolato.'}`;
      updated.details = [
        `Percorso ${route.provider === 'openrouteservice' ? 'calcolato da OpenRouteService' : 'basato sull’itinerario esistente'} il ${route.checkedAt.slice(0, 10)}.`,
        `Diretto: ${route.directMinutes} min. Passeggiata aggiuntiva: ${route.extraWalkingMinutes} min. Soste: ${dwell} min.`,
        ...route.citations.map((c) => `${c.title}: ${c.description}${c.url ? ` (${c.url})` : ''}`),
      ].join('\n');
    }
  }
  if (
    JSON.stringify(before.plan) === JSON.stringify(trip.plan) &&
    JSON.stringify(before.notes) === JSON.stringify(trip.travel!.notes)
  )
    throw new AiPlanError('invalid', 'Questa proposta non modifica il programma.');
  trip.travel!.history = [
    ...previousHistory,
    {
      id: proposal.id,
      title: `Assistenza: ${proposal.title}`,
      at: proposal.createdAt,
      before,
      after: Object.fromEntries([...keys].map((key) => [key, fingerprint(trip, key)])),
    },
  ].slice(-20);
  trip.travel!.appliedIds = [...previousIds, proposal.id];
  return TripSchema.parse(trip);
}
