import { z } from 'zod';
import { PlaceInformationSchema } from './place-information.js';

export const Id = z
  .string()
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const SafeUrl = z
  .string()
  .max(2048)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Only HTTP(S) links are allowed');
const DateOnly = z.iso.date();
const Timestamp = z.iso.datetime({ offset: true });
const Timezone = z
  .string()
  .max(100)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone');
const Evidence = z.enum([
  'verified_official',
  'verified_secondary',
  'estimate',
  'unknown',
  'user_provided',
]);
export const SourceSchema = z
  .object({
    id: Id,
    title: z.string().max(20000),
    url: SafeUrl.optional(),
    description: z.string().max(20000),
    verifiedOn: DateOnly.optional(),
    status: Evidence,
  })
  .strict();
export const PlaceSchema = z
  .object({
    id: Id,
    name: z.string().max(20000).min(1),
    localName: z.string().max(20000).optional(),
    address: z.string().max(20000),
    description: z.string().max(20000),
    details: z.string().max(20000).default(''),
    trivia: z.string().max(20000).default(''),
    entrance: z.string().max(20000).default(''),
    openingHours: z.string().max(20000).default(''),
    information: PlaceInformationSchema.optional(),
    website: SafeUrl.optional(),
    bookingUrl: SafeUrl.optional(),
    phone: z.string().max(20000).optional(),
    sourceIds: z.array(Id).max(2000).default([]),
    coordinates: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        verifiedOn: DateOnly,
      })
      .optional(),
  })
  .strict();
const StepBase = {
  id: Id,
  sourceActivityIds: z.array(z.string().max(20000)).max(2000).default([]),
  title: z.string().max(20000).min(1),
  start: Timestamp,
  end: Timestamp,
  timezone: Timezone.optional(),
  summary: z.string().max(20000),
  details: z.string().max(20000).default(''),
  optional: z.boolean().default(false),
  sourceIds: z.array(Id).max(2000).default([]),
  notes: z.array(z.string().max(20000)).max(2000).default([]),
};
export const StopSchema = z
  .object({
    ...StepBase,
    kind: z.literal('stop'),
    placeId: Id,
    category: z.enum(['visit', 'meal', 'logistics', 'free-time']),
  })
  .strict();
export const RouteEvidenceSchema = z
  .object({
    provider: z.enum(['existing-itinerary', 'openrouteservice', 'mock']),
    checkedAt: Timestamp,
    walkingMinutes: z.number().int().min(1).max(720),
    visitMinutes: z.number().int().min(0).max(360),
    directMinutes: z.number().int().min(1).max(720),
    extraWalkingMinutes: z.number().int().min(0).max(120),
    geometry: z
      .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
      .max(2000),
    citations: z
      .array(
        z
          .object({
            title: z.string().min(1).max(250),
            url: SafeUrl.optional(),
            description: z.string().max(1000),
            checkedAt: Timestamp.optional(),
            estimate: z.boolean(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export const LegSchema = z
  .object({
    ...StepBase,
    kind: z.literal('leg'),
    fromPlaceId: Id,
    toPlaceId: Id,
    mode: z.enum(['walk', 'train', 'transit', 'taxi', 'flight']),
    durationMinutes: z.number().int().min(0),
    distanceKm: z.number().min(0).optional(),
    estimate: z.boolean().default(true),
    routeEvidence: RouteEvidenceSchema.optional(),
    streets: z.array(z.string().max(20000)).max(2000).default([]),
    pois: z
      .array(
        z
          .object({
            placeId: Id,
            note: z.string().max(20000),
            detourMinutes: z.number().min(0).default(0),
            visitMinutes: z.number().int().min(0).max(120).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const StepSchema = z.discriminatedUnion('kind', [StopSchema, LegSchema]);
export const CostSchema = z
  .object({
    id: Id,
    title: z.string().max(20000),
    category: z.enum(['admission', 'transport', 'meal', 'extras', 'other']),
    min: z.number().min(0).nullable(),
    max: z.number().min(0).nullable(),
    currency: z
      .string()
      .max(20000)
      .regex(/^[A-Z]{3}$/),
    basis: z.enum(['person', 'group']),
    inclusion: z.enum(['base', 'optional', 'excluded']),
    status: Evidence,
    stepIds: z.array(Id).max(2000).default([]),
    sourceIds: z.array(Id).max(2000).default([]),
  })
  .strict()
  .refine(
    (v) =>
      (v.min === null && v.max === null) || (v.min !== null && v.max !== null && v.max >= v.min),
    'Use an ordered range or null/null',
  );
const AlternativeSchema = z
  .object({
    id: Id,
    title: z.string().max(20000),
    description: z.string().max(20000),
    costDifference: z.string().max(20000),
    affectedStepIds: z.array(Id).max(2000),
    replacementSteps: z.array(StepSchema).max(2000).default([]),
    costChanges: z
      .array(z.object({ id: Id, inclusion: z.enum(['base', 'optional', 'excluded']) }).strict())
      .default([]),
  })
  .strict();
export const PlanSchema = z
  .object({
    title: z.string().max(20000).min(1),
    subtitle: z.string().max(20000).default(''),
    destinations: z.array(z.string().max(20000)).max(2000).min(1),
    startDate: DateOnly,
    endDate: DateOnly,
    timezone: Timezone,
    language: z.literal('it-IT').default('it-IT'),
    dateStatus: z.enum(['confirmed', 'provisional']),
    assumptions: z.array(z.string().max(20000)).max(2000).default([]),
    travellers: z
      .array(z.object({ id: Id, name: z.string().max(20000).min(1) }).strict())
      .min(1)
      .max(50),
    days: z
      .array(
        z
          .object({
            id: Id,
            date: DateOnly,
            title: z.string().max(20000),
            summary: z.string().max(20000),
            stepIds: z.array(Id).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(366),
    steps: z.array(StepSchema).max(2000).min(1),
    places: z.array(PlaceSchema).max(2000),
    sources: z.array(SourceSchema).max(1000),
    costs: z.array(CostSchema).max(2000).default([]),
    alternatives: z.array(AlternativeSchema).max(100).default([]),
    tasks: z
      .array(
        z
          .object({
            id: Id,
            title: z.string().max(20000),
            description: z.string().max(20000),
            priority: z.enum(['high', 'medium', 'low']),
            stepId: Id.optional(),
            url: SafeUrl.optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export const ReservationSchema = z
  .object({
    id: Id,
    stepId: Id,
    title: z.string().max(20000),
    travellerIds: z.array(Id).max(2000).min(1),
    status: z.enum(['not-booked', 'booked', 'cancelled']),
    reference: z.string().max(20000).default(''),
    slot: Timestamp.optional(),
    paidAmount: z.number().min(0).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    costId: Id.optional(),
    notes: z.string().max(20000).default(''),
  })
  .strict();
export const TicketSchema = z
  .object({
    id: Id,
    stepId: Id,
    travellerIds: z.array(Id).max(2000).min(1),
    reservationId: Id.optional(),
    title: z.string().max(20000).min(1),
    filename: z.string().max(20000),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    size: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    status: z.enum(['pending', 'ready']),
    pathname: z.string().max(20000),
    uploadedAt: Timestamp,
  })
  .strict();
export const ProgressStatus = z.enum(['pending', 'done', 'skipped']);
export const StateSchema = z
  .object({
    progress: z.record(Id, ProgressStatus).default({}),
    taskCompletion: z.record(Id, z.boolean()).default({}),
    reservations: z.array(ReservationSchema).max(500).default([]),
    tickets: z.array(TicketSchema).max(200).default([]),
    exchangeRates: z
      .array(
        z
          .object({
            currency: z
              .string()
              .max(20000)
              .regex(/^[A-Z]{3}$/),
            euroPerUnit: z.number().positive().finite(),
            asOf: DateOnly,
            fetchedAt: Timestamp,
            source: SafeUrl,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
const TravelSnapshotSchema = z
  .object({
    plan: PlanSchema,
    notes: z.record(Id, z.string().max(20000)),
    locks: z.record(Id, Timestamp),
    completedAt: z.record(Id, Timestamp),
    progress: z.record(Id, ProgressStatus),
  })
  .strict();
export const TravelSchema = z
  .object({
    originalPlan: PlanSchema,
    notes: z.record(Id, z.string().max(20000)).default({}),
    locks: z.record(Id, Timestamp).default({}),
    completedAt: z.record(Id, Timestamp).default({}),
    appliedIds: z.array(Id).max(2000).default([]),
    history: z
      .array(
        z
          .object({
            id: Id,
            title: z.string().max(20000),
            at: Timestamp,
            before: TravelSnapshotSchema,
            after: z.record(z.string().max(20000), z.string().max(20000)),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const TripSchema = z
  .object({
    schemaVersion: z.enum(['1', '2']),
    id: Id,
    revision: z.number().int().min(1),
    updatedAt: Timestamp,
    plan: PlanSchema,
    state: StateSchema,
    travel: TravelSchema.optional(),
  })
  .strict()
  .superRefine((trip, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((trip.schemaVersion === '2') !== !!trip.travel)
      issue('Travel state requires schema version 2');
    const p = trip.plan;
    for (const [name, items] of Object.entries({
      travellers: p.travellers,
      days: p.days,
      steps: p.steps,
      places: p.places,
      sources: p.sources,
      costs: p.costs,
      tasks: p.tasks,
      alternatives: p.alternatives,
      reservations: trip.state.reservations,
      tickets: trip.state.tickets,
    })) {
      const ids = items.map((v) => v.id);
      if (new Set(ids).size !== ids.length) issue(`Duplicate ${name} ID`);
    }
    if (trip.travel) {
      const baseline = TripSchema.safeParse({
        schemaVersion: '1',
        id: trip.id,
        revision: 1,
        updatedAt: trip.updatedAt,
        plan: trip.travel.originalPlan,
        state: emptyState(),
      });
      if (!baseline.success) issue('Invalid original plan');
      const stepIds = new Set(p.steps.map((s) => s.id)),
        dayIds = new Set(p.days.map((d) => d.id));
      for (const key of [
        ...Object.keys(trip.travel.locks),
        ...Object.keys(trip.travel.completedAt),
      ])
        if (!stepIds.has(key)) issue('Unknown travel step');
      for (const key of Object.keys(trip.travel.notes))
        if (!stepIds.has(key) && !dayIds.has(key)) issue('Unknown travel note target');
      for (const s of trip.travel.originalPlan.steps)
        if (!stepIds.has(s.id)) issue('Original steps must remain in the catalog');
      for (const d of trip.travel.originalPlan.days)
        if (!dayIds.has(d.id)) issue('Original days must remain available');
      if (new Set(trip.travel.appliedIds).size !== trip.travel.appliedIds.length)
        issue('Duplicate applied command ID');
    }
    const places = new Set(p.places.map((v) => v.id));
    const steps = new Set(p.steps.map((v) => v.id));
    const travellers = new Set(p.travellers.map((v) => v.id));
    const sources = new Set(p.sources.map((v) => v.id));
    const tasks = new Set(p.tasks.map((v) => v.id));
    const costs = new Set(p.costs.map((v) => v.id));
    const check = (ids: string[], set: Set<string>, label: string) =>
      ids.forEach((id) => {
        if (!set.has(id)) issue(`Unknown ${label}: ${id}`);
      });
    if (p.startDate > p.endDate) issue('Trip starts after its end');
    const ordered = p.days.flatMap((d) => d.stepIds);
    if (
      (trip.schemaVersion === '1' && ordered.length !== steps.size) ||
      new Set(ordered).size !== ordered.length
    )
      issue('Every step must appear exactly once in the days');
    let lastDate = '';
    for (const d of p.days) {
      if (d.date < p.startDate || d.date > p.endDate || d.date <= lastDate)
        issue(`Invalid day date/order: ${d.id}`);
      lastDate = d.date;
      check(d.stepIds, steps, 'step');
      let previousEnd = 0;
      for (const id of d.stepIds) {
        const step = p.steps.find((s) => s.id === id);
        if (!step) continue;
        const start = Date.parse(step.start),
          end = Date.parse(step.end);
        if (start < previousEnd || end <= start) issue(`Invalid or overlapping schedule: ${id}`);
        if (
          new Intl.DateTimeFormat('en-CA', {
            timeZone: step.timezone ?? p.timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(start) !== d.date
        )
          issue(`Step not on its day: ${id}`);
        previousEnd = end;
      }
    }
    for (const s of p.steps) {
      check(
        s.kind === 'stop'
          ? [s.placeId]
          : [s.fromPlaceId, s.toPlaceId, ...s.pois.map((poi) => poi.placeId)],
        places,
        'place',
      );
      check(s.sourceIds, sources, 'source');
    }
    p.places.forEach((v) => check(v.sourceIds, sources, 'source'));
    p.costs.forEach((v) => {
      check(v.stepIds, steps, 'cost step');
      check(v.sourceIds, sources, 'source');
    });
    p.tasks.forEach((v) => {
      if (v.stepId) check([v.stepId], steps, 'task step');
    });
    p.alternatives.forEach((a) => {
      check(a.affectedStepIds, steps, 'alternative step');
      a.costChanges.forEach((c) => check([c.id], costs, 'cost'));
      a.replacementSteps.forEach((s) => {
        check(
          s.kind === 'stop'
            ? [s.placeId]
            : [s.fromPlaceId, s.toPlaceId, ...s.pois.map((poi) => poi.placeId)],
          places,
          'alternative place',
        );
        check(s.sourceIds, sources, 'source');
      });
    });
    check(Object.keys(trip.state.progress), steps, 'progress step');
    check(Object.keys(trip.state.taskCompletion), tasks, 'task');
    for (const r of trip.state.reservations) {
      check([r.stepId], steps, 'reservation step');
      check(r.travellerIds, travellers, 'traveller');
      if (r.costId) check([r.costId], costs, 'cost');
    }
    for (const t of trip.state.tickets) {
      check([t.stepId], steps, 'ticket step');
      check(t.travellerIds, travellers, 'traveller');
      if (!t.pathname.startsWith(`tickets/${trip.id}/${t.id}/`) || t.pathname.includes('..'))
        issue('Invalid ticket storage path');
      if (t.reservationId) {
        const r = trip.state.reservations.find((v) => v.id === t.reservationId);
        if (!r || r.stepId !== t.stepId) issue(`Invalid ticket reservation: ${t.id}`);
      }
    }
  });
export type Trip = z.infer<typeof TripSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type Reservation = z.infer<typeof ReservationSchema>;
export type Progress = z.infer<typeof ProgressStatus>;
export const emptyState = (): Trip['state'] => ({
  progress: {},
  taskCompletion: {},
  reservations: [],
  tickets: [],
  exchangeRates: [],
});
