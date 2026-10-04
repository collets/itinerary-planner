import { z } from 'zod';

export const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const SafeUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Only HTTP(S) links are allowed');
const DateOnly = z.iso.date();
const Timestamp = z.iso.datetime({ offset: true });
const Timezone = z.string().refine((v) => {
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
    title: z.string(),
    url: SafeUrl.optional(),
    description: z.string(),
    verifiedOn: DateOnly.optional(),
    status: Evidence,
  })
  .strict();
export const PlaceSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    localName: z.string().optional(),
    address: z.string(),
    description: z.string(),
    details: z.string().default(''),
    trivia: z.string().default(''),
    entrance: z.string().default(''),
    openingHours: z.string().default(''),
    website: SafeUrl.optional(),
    bookingUrl: SafeUrl.optional(),
    phone: z.string().optional(),
    sourceIds: z.array(Id).default([]),
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
  sourceActivityIds: z.array(z.string()).default([]),
  title: z.string().min(1),
  start: Timestamp,
  end: Timestamp,
  timezone: Timezone.optional(),
  summary: z.string(),
  details: z.string().default(''),
  optional: z.boolean().default(false),
  sourceIds: z.array(Id).default([]),
  notes: z.array(z.string()).default([]),
};
export const StopSchema = z
  .object({
    ...StepBase,
    kind: z.literal('stop'),
    placeId: Id,
    category: z.enum(['visit', 'meal', 'logistics', 'free-time']),
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
    streets: z.array(z.string()).default([]),
    pois: z
      .array(
        z
          .object({ placeId: Id, note: z.string(), detourMinutes: z.number().min(0).default(0) })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const StepSchema = z.discriminatedUnion('kind', [StopSchema, LegSchema]);
export const CostSchema = z
  .object({
    id: Id,
    title: z.string(),
    category: z.enum(['admission', 'transport', 'meal', 'extras', 'other']),
    min: z.number().min(0).nullable(),
    max: z.number().min(0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    basis: z.enum(['person', 'group']),
    inclusion: z.enum(['base', 'optional', 'excluded']),
    status: Evidence,
    stepIds: z.array(Id).default([]),
    sourceIds: z.array(Id).default([]),
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
    title: z.string(),
    description: z.string(),
    costDifference: z.string(),
    affectedStepIds: z.array(Id),
    replacementSteps: z.array(StepSchema).default([]),
    costChanges: z
      .array(z.object({ id: Id, inclusion: z.enum(['base', 'optional', 'excluded']) }).strict())
      .default([]),
  })
  .strict();
export const PlanSchema = z
  .object({
    title: z.string().min(1),
    subtitle: z.string().default(''),
    destinations: z.array(z.string()).min(1),
    startDate: DateOnly,
    endDate: DateOnly,
    timezone: Timezone,
    language: z.literal('it-IT').default('it-IT'),
    dateStatus: z.enum(['confirmed', 'provisional']),
    assumptions: z.array(z.string()).default([]),
    travellers: z.array(z.object({ id: Id, name: z.string().min(1) }).strict()).min(1),
    days: z
      .array(
        z
          .object({
            id: Id,
            date: DateOnly,
            title: z.string(),
            summary: z.string(),
            stepIds: z.array(Id),
          })
          .strict(),
      )
      .min(1),
    steps: z.array(StepSchema),
    places: z.array(PlaceSchema),
    sources: z.array(SourceSchema),
    costs: z.array(CostSchema).default([]),
    alternatives: z.array(AlternativeSchema).default([]),
    tasks: z
      .array(
        z
          .object({
            id: Id,
            title: z.string(),
            description: z.string(),
            priority: z.enum(['high', 'medium', 'low']),
            stepId: Id.optional(),
            url: SafeUrl.optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const ReservationSchema = z
  .object({
    id: Id,
    stepId: Id,
    title: z.string(),
    travellerIds: z.array(Id).min(1),
    status: z.enum(['not-booked', 'booked', 'cancelled']),
    reference: z.string().default(''),
    slot: Timestamp.optional(),
    paidAmount: z.number().min(0).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    costId: Id.optional(),
    notes: z.string().default(''),
  })
  .strict();
export const TicketSchema = z
  .object({
    id: Id,
    stepId: Id,
    travellerIds: z.array(Id).min(1),
    reservationId: Id.optional(),
    title: z.string().min(1),
    filename: z.string(),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    size: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
    status: z.enum(['pending', 'ready']),
    pathname: z.string(),
    uploadedAt: Timestamp,
  })
  .strict();
export const ProgressStatus = z.enum(['pending', 'done', 'skipped']);
export const StateSchema = z
  .object({
    progress: z.record(Id, ProgressStatus).default({}),
    taskCompletion: z.record(Id, z.boolean()).default({}),
    reservations: z.array(ReservationSchema).default([]),
    tickets: z.array(TicketSchema).default([]),
    exchangeRates: z
      .array(
        z
          .object({
            currency: z.string().regex(/^[A-Z]{3}$/),
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
export const TripSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: Id,
    revision: z.number().int().min(1),
    updatedAt: Timestamp,
    plan: PlanSchema,
    state: StateSchema,
  })
  .strict()
  .superRefine((trip, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
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
    if (ordered.length !== steps.size || new Set(ordered).size !== ordered.length)
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
