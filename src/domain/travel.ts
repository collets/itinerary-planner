import { z } from 'zod';
import {
  Id,
  StopSchema,
  PlaceSchema,
  TripSchema,
  type Trip,
  type Plan,
  type Step,
} from './schema.js';
import { inputToInstant, zonedInput } from './datetime.js';

const routeSchema = z
  .object({
    fromPlaceId: Id,
    toPlaceId: Id,
    mode: z.enum(['walk', 'transit', 'taxi', 'train']),
    durationMinutes: z.number().int().min(1).max(1440),
  })
  .strict();
const day = { dayId: Id };
const step = { ...day, stepId: Id };
export const TravelActionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('delay'), ...step, minutes: z.number().int().min(1).max(1440) })
    .strict(),
  z
    .object({
      type: z.literal('timing'),
      ...step,
      start: z.iso.datetime({ offset: true }).optional(),
      durationMinutes: z.number().int().min(1).max(1440).optional(),
      following: z.boolean(),
      leaveAt: z.iso.datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skip'),
      ...step,
      included: z.boolean(),
      afterId: Id.optional(),
      acknowledgedBooking: z.boolean().default(false),
    })
    .strict(),
  z.object({ type: z.literal('move'), ...step, toDayId: Id, afterId: Id.optional() }).strict(),
  z
    .object({
      type: z.literal('add'),
      ...day,
      stop: StopSchema,
      place: PlaceSchema.optional(),
      afterId: Id.optional(),
    })
    .strict(),
  z.object({ type: z.literal('note'), targetId: Id, text: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('lock'), ...step, fixed: z.boolean() }).strict(),
  z.object({ type: z.literal('restore'), ...day }).strict(),
  z.object({ type: z.literal('undo'), historyId: Id }).strict(),
]);
export const TravelCommandSchema = z
  .object({
    id: Id,
    action: TravelActionSchema,
    routes: z.array(routeSchema).max(100).default([]),
    expected: z.record(z.string(), z.string()),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type TravelAction = z.infer<typeof TravelActionSchema>;
export type TravelCommand = z.infer<typeof TravelCommandSchema>;
export type RouteInput = z.infer<typeof routeSchema>;
export class TravelError extends Error {
  constructor(
    public code: 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TravelError';
  }
}
export function upgradeTrip(trip: Trip): Trip {
  const draft = structuredClone(trip);
  draft.schemaVersion = '2';
  draft.travel ??= {
    originalPlan: structuredClone(trip.plan),
    notes: {},
    locks: {},
    completedAt: {},
    appliedIds: [],
    history: [],
  };
  return draft;
}
export function activeIds(trip: Trip): Set<string> {
  return new Set(trip.plan.days.flatMap((d) => d.stepIds));
}
export function archivedSteps(trip: Trip, dayId: string): Step[] {
  const ids = activeIds(trip);
  const original = trip.travel?.originalPlan.days.find((d) => d.id === dayId)?.stepIds ?? [];
  const date = trip.plan.days.find((d) => d.id === dayId)?.date;
  return trip.plan.steps.filter(
    (s) =>
      !ids.has(s.id) &&
      (original.includes(s.id) ||
        (!trip.travel?.originalPlan.steps.some((o) => o.id === s.id) &&
          zonedInput(s.start, s.timezone ?? trip.plan.timezone).slice(0, 10) === date)),
  );
}
export function fixedStart(trip: Trip, s: Step): string | undefined {
  const booked = trip.state.reservations.filter(
    (r) => r.stepId === s.id && r.status === 'booked' && r.slot,
  );
  if (new Set(booked.map((r) => r.slot)).size > 1)
    throw new TravelError(
      'invalid',
      `${s.title}: gli orari prenotati sono diversi. Correggi le prenotazioni.`,
    );
  return (
    booked[0]?.slot ??
    (s.kind === 'leg' && s.mode === 'flight' ? s.start : trip.travel?.locks[s.id])
  );
}
function getDay(trip: Trip, id: string) {
  const d = trip.plan.days.find((d) => d.id === id);
  if (!d) throw new TravelError('conflict', 'La giornata non esiste più. Rivedi la modifica.');
  return d;
}
function getStep(trip: Trip, id: string) {
  const s = trip.plan.steps.find((s) => s.id === id);
  if (!s) throw new TravelError('conflict', 'La tappa non esiste più. Rivedi la modifica.');
  return s;
}
function requireEditable(trip: Trip, id: string) {
  if (trip.state.progress[id] === 'done')
    throw new TravelError(
      'invalid',
      'Le attività completate restano nel diario. Scegli una tappa da fare.',
    );
}
function scopeKeys(trip: Trip, action: TravelAction): string[] {
  if (action.type === 'note') return [`note:${action.targetId}`];
  if (action.type === 'undo') {
    const history = trip.travel?.history.find((h) => h.id === action.historyId);
    if (!history) throw new TravelError('conflict', 'Questa modifica non è più nella cronologia.');
    return Object.keys(history.after);
  }
  if (action.type === 'restore') return trip.plan.days.map((d) => `day:${d.id}`);
  return [...new Set([action.dayId, ...(action.type === 'move' ? [action.toDayId] : [])])].map(
    (id) => `day:${id}`,
  );
}
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value));
}
export function fingerprint(trip: Trip, key: string): string {
  if (key.startsWith('location:')) {
    const place = trip.plan.places.find((p) => p.id === key.slice(9));
    if (!place) throw new TravelError('conflict', 'Il luogo non è più disponibile.');
    return canonical({ coordinates: place.coordinates ?? null, sourceIds: place.sourceIds });
  }
  if (key.startsWith('information:')) {
    const place = trip.plan.places.find((p) => p.id === key.slice(12));
    if (!place) throw new TravelError('conflict', 'Il luogo non è più disponibile.');
    return canonical(place.information ?? null);
  }
  if (key.startsWith('note:')) {
    const id = key.slice(5);
    if (!trip.plan.days.some((d) => d.id === id) && !trip.plan.steps.some((s) => s.id === id))
      throw new TravelError('conflict', 'La nota non ha più una tappa o giornata.');
    return canonical(trip.travel?.notes[id] ?? '');
  }
  const d = getDay(trip, key.slice(4));
  const catalog = [...d.stepIds, ...archivedSteps(trip, d.id).map((s) => s.id)];
  return canonical({
    day: d,
    steps: catalog.map((id) => getStep(trip, id)),
    progress: catalog.map((id) => [id, trip.state.progress[id] ?? 'pending']),
    locks: catalog.map((id) => [id, trip.travel?.locks[id] ?? null]),
    bookings: trip.state.reservations
      .filter((r) => catalog.includes(r.stepId) && r.status === 'booked')
      .map((r) => [r.id, r.stepId, r.slot ?? null]),
    baseline: trip.travel?.originalPlan.days.find((v) => v.id === d.id) ?? d,
  });
}
export function preconditions(trip: Trip, action: TravelAction): Record<string, string> {
  return Object.fromEntries(scopeKeys(trip, action).map((key) => [key, fingerprint(trip, key)]));
}
export function commandTitle(action: TravelAction): string {
  return {
    delay: 'Ritardo',
    timing: 'Orari aggiornati',
    skip: action.type === 'skip' && action.included ? 'Tappa reinserita' : 'Tappa saltata',
    move: 'Tappa spostata',
    add: 'Nuova tappa',
    note: 'Nota di viaggio',
    lock: 'Orario fisso',
    restore: 'Programma originale',
    undo: 'Modifica annullata',
  }[action.type];
}
function sameDate(value: number, trip: Trip, s: Step, date: string) {
  return (
    zonedInput(new Date(value).toISOString(), s.timezone ?? trip.plan.timezone).slice(0, 10) ===
    date
  );
}
function shiftStep(s: Step, start: number) {
  const duration = Date.parse(s.end) - Date.parse(s.start);
  s.start = new Date(start).toISOString();
  s.end = new Date(start + duration).toISOString();
}
function reschedule(trip: Trip, dayId: string, old: Plan, from = 0, explicit?: number) {
  const d = getDay(trip, dayId);
  let cursor = from > 0 ? Date.parse(getStep(trip, d.stepIds[from - 1]).end) : 0;
  for (let i = from; i < d.stepIds.length; i++) {
    const s = getStep(trip, d.stepIds[i]);
    const previous = old.steps.find((o) => o.id === s.id);
    const fixed = fixedStart(trip, s);
    const done = trip.state.progress[s.id] === 'done';
    const preferred =
      i === from && explicit !== undefined ? explicit : Date.parse(previous?.start ?? s.start);
    let start = Math.max(cursor, preferred);
    if (fixed || done) {
      start = Date.parse(fixed ?? s.start);
      if (cursor > start || (i === from && explicit !== undefined && explicit !== start))
        throw new TravelError(
          'invalid',
          `${s.title}: il programma non entra prima dell’orario fisso. Accorcia, salta o sposta una tappa.`,
        );
    }
    if (Date.parse(s.start) !== start) shiftStep(s, start);
    if (!sameDate(start, trip, s, d.date))
      throw new TravelError(
        'invalid',
        `${s.title}: la modifica passa a un altro giorno. Usa “Sposta in un altro giorno”.`,
      );
    cursor = Date.parse(s.end);
  }
}
function connection(
  trip: Trip,
  before: Plan,
  dayId: string,
  from: Extract<Step, { kind: 'stop' }>,
  to: Extract<Step, { kind: 'stop' }>,
): string[] | undefined {
  const current = getDay(trip, dayId),
    active = activeIds(trip);
  const eligible = (id: string) => {
    const s = trip.plan.steps.find((s) => s.id === id);
    return (
      s?.kind === 'leg' &&
      (current.stepIds.includes(id) || !active.has(id)) &&
      sameDate(Date.parse(s.start), trip, s, current.date)
    );
  };
  for (const plan of [before, trip.travel?.originalPlan].filter((v): v is Plan => !!v)) {
    const ids = plan.days.find((d) => d.id === dayId)?.stepIds ?? [],
      a = ids.indexOf(from.id),
      b = ids.indexOf(to.id);
    if (a < 0 || b <= a) continue;
    const legs = ids.slice(a + 1, b).map((id) => trip.plan.steps.find((s) => s.id === id));
    if (!legs.length) continue;
    let endpoint = from.placeId;
    if (
      legs.every((s) => {
        if (!s || s.kind !== 'leg' || !eligible(s.id) || s.fromPlaceId !== endpoint) return false;
        endpoint = s.toPlaceId;
        return true;
      }) &&
      endpoint === to.placeId
    )
      return legs.map((s) => s!.id);
  }
  const direct = trip.plan.steps.find(
    (s) =>
      s.kind === 'leg' &&
      s.fromPlaceId === from.placeId &&
      s.toPlaceId === to.placeId &&
      eligible(s.id) &&
      trip.state.progress[s.id] !== 'done',
  );
  return direct ? [direct.id] : undefined;
}
function repairRoutes(
  trip: Trip,
  dayId: string,
  inputs: RouteInput[],
  commandId: string,
  before: Plan,
) {
  const d = getDay(trip, dayId);
  const old = d.stepIds.map((id) => getStep(trip, id));
  const stops = old.filter((s) => s.kind === 'stop');
  if (!stops.length) {
    // Standalone transport/logistics days remain editable without fabricating endpoints.
    d.stepIds = old
      .filter(
        (s) =>
          s.kind === 'leg' &&
          (s.mode === 'flight' || fixedStart(trip, s) || trip.state.progress[s.id] === 'done'),
      )
      .map((s) => s.id);
    return;
  }
  const result: string[] = [];
  for (let i = 0; i < stops.length; i++) {
    const to = stops[i];
    if (i) {
      const from = stops[i - 1];
      const existing = connection(trip, before, dayId, from, to);
      if (existing) result.push(...existing);
      else if (from.placeId !== to.placeId) {
        const input = inputs.find(
          (r) => r.fromPlaceId === from.placeId && r.toPlaceId === to.placeId,
        );
        if (!input)
          throw new TravelError(
            'invalid',
            `Indica mezzo e minuti per ${from.title} → ${to.title}.`,
          );
        const suffix = [...dayId]
          .reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0)
          .toString(36);
        const id = `route-${commandId.slice(0, 55)}-${suffix}-${i}`;
        if (trip.plan.steps.some((s) => s.id === id))
          throw new TravelError('invalid', 'ID del percorso già in uso.');
        const leg: Step = {
          id,
          kind: 'leg',
          title: `${from.title} → ${to.title}`,
          fromPlaceId: from.placeId,
          toPlaceId: to.placeId,
          mode: input.mode,
          durationMinutes: input.durationMinutes,
          estimate: true,
          streets: [],
          pois: [],
          start: from.end,
          end: new Date(Date.parse(from.end) + input.durationMinutes * 60000).toISOString(),
          summary: 'Percorso adattato: tempo provvisorio da confermare.',
          details:
            'Apri le indicazioni sulla mappa. Le istruzioni del percorso precedente non si applicano a questo collegamento.',
          optional: false,
          sourceIds: [],
          sourceActivityIds: [],
          notes: [],
        };
        trip.plan.steps.push(leg);
        result.push(id);
      }
    }
    result.push(to.id);
  }
  // Preserve valid leading/trailing transfers, especially fixed flights.
  const firstIndex = old.findIndex((s) => s.id === stops[0].id);
  const lastIndex = old.findIndex((s) => s.id === stops.at(-1)!.id);
  const originalStops = before.days
    .find((v) => v.id === dayId)!
    .stepIds.map((id) => before.steps.find((s) => s.id === id)!)
    .filter((s) => s.kind === 'stop');
  const leading = old
    .slice(0, firstIndex)
    .filter(
      (s) =>
        s.kind === 'leg' &&
        s.toPlaceId === stops[0].placeId &&
        originalStops[0]?.id === stops[0].id,
    );
  const trailing = old
    .slice(lastIndex + 1)
    .filter(
      (s) =>
        s.kind === 'leg' &&
        s.fromPlaceId === stops.at(-1)!.placeId &&
        originalStops.at(-1)?.id === stops.at(-1)!.id,
    );
  d.stepIds = [...leading.map((s) => s.id), ...result, ...trailing.map((s) => s.id)];
  for (const completed of old.filter(
    (s) => s.kind === 'leg' && trip.state.progress[s.id] === 'done' && !d.stepIds.includes(s.id),
  )) {
    const next = d.stepIds.findIndex(
      (id) => Date.parse(getStep(trip, id).start) >= Date.parse(completed.end),
    );
    d.stepIds.splice(next < 0 ? d.stepIds.length : next, 0, completed.id);
  }
  if (old.some((s) => s.kind === 'leg' && fixedStart(trip, s) && !d.stepIds.includes(s.id)))
    throw new TravelError(
      'invalid',
      'Questa modifica toglierebbe un trasferimento fisso. Modifica le tappe attorno al trasferimento.',
    );
}
function insert(ids: string[], id: string, afterId?: string) {
  const index = afterId ? ids.indexOf(afterId) : -1;
  if (afterId && index < 0)
    throw new TravelError('conflict', 'La posizione scelta non esiste più.');
  ids.splice(index + 1, 0, id);
}
function restoreSnapshot(
  trip: Trip,
  before: NonNullable<Trip['travel']>['history'][number]['before'],
  keys: string[],
) {
  for (const key of keys) {
    if (key.startsWith('location:')) {
      const place = trip.plan.places.find((p) => p.id === key.slice(9));
      const saved = before.plan.places.find((p) => p.id === place?.id);
      if (!place || !saved) throw new TravelError('conflict', 'Il luogo non è più disponibile.');
      if (saved.coordinates) place.coordinates = structuredClone(saved.coordinates);
      else delete place.coordinates;
      place.sourceIds = [...saved.sourceIds];
      continue;
    }
    if (key.startsWith('information:')) {
      const place = trip.plan.places.find((p) => p.id === key.slice(12));
      if (!place) throw new TravelError('conflict', 'Il luogo non è più disponibile.');
      const saved = before.plan.places.find((p) => p.id === place.id)?.information;
      if (saved) place.information = structuredClone(saved);
      else delete place.information;
      continue;
    }
    if (key.startsWith('note:')) {
      const id = key.slice(5);
      if (before.notes[id]) trip.travel!.notes[id] = before.notes[id];
      else delete trip.travel!.notes[id];
      continue;
    }
    const id = key.slice(4),
      current = getDay(trip, id),
      saved = before.plan.days.find((d) => d.id === id)!;
    const ids = new Set([
      ...current.stepIds,
      ...saved.stepIds,
      ...archivedSteps(trip, id).map((s) => s.id),
    ]);
    current.stepIds = [...saved.stepIds];
    for (const sid of ids) {
      const s = before.plan.steps.find((s) => s.id === sid);
      if (s) {
        const index = trip.plan.steps.findIndex((v) => v.id === sid);
        if (index < 0)
          throw new TravelError('conflict', 'Una tappa della cronologia è stata rimossa.');
        trip.plan.steps[index] = structuredClone(s);
      }
      if (before.locks[sid]) trip.travel!.locks[sid] = before.locks[sid];
      else delete trip.travel!.locks[sid];
      if (trip.state.progress[sid] !== 'done') {
        if (before.progress[sid]) trip.state.progress[sid] = before.progress[sid];
        else delete trip.state.progress[sid];
      }
    }
  }
}
export function applyTravel(input: Trip, raw: TravelCommand): Trip {
  const command = TravelCommandSchema.parse(raw),
    trip = upgradeTrip(input),
    travel = trip.travel!;
  if (travel.appliedIds.includes(command.id)) return trip;
  const required = preconditions(trip, command.action);
  if (
    JSON.stringify(Object.keys(command.expected).sort()) !==
      JSON.stringify(Object.keys(required).sort()) ||
    Object.entries(required).some(([key, value]) => command.expected[key] !== value)
  )
    throw new TravelError(
      'conflict',
      'Il programma condiviso è cambiato. Confronta le versioni prima di sincronizzare.',
    );
  const before = {
    plan: structuredClone(trip.plan),
    notes: { ...travel.notes },
    locks: { ...travel.locks },
    completedAt: { ...travel.completedAt },
    progress: { ...trip.state.progress },
  };
  const action = command.action;
  if (action.type === 'note') travel.notes[action.targetId] = action.text;
  else if (action.type === 'undo') {
    const h = travel.history.find((h) => h.id === action.historyId)!;
    if (Object.entries(h.after).some(([key, value]) => fingerprint(trip, key) !== value))
      throw new TravelError(
        'conflict',
        'Le tappe sono cambiate dopo questa modifica. Rivedi il programma prima di annullare.',
      );
    restoreSnapshot(trip, h.before, Object.keys(h.after));
  } else if (action.type === 'restore') {
    const original = travel.originalPlan;
    const target = getDay(trip, action.dayId);
    const originalIds = original.days.find((d) => d.id === target.id)!.stepIds;
    const restoredIds = originalIds.filter(
      (id) => trip.state.progress[id] !== 'done' || target.stepIds.includes(id),
    );
    const completedExtras = target.stepIds.filter(
      (id) => !originalIds.includes(id) && trip.state.progress[id] === 'done',
    );
    for (const d of trip.plan.days) {
      d.stepIds = d.stepIds.filter(
        (id) => !originalIds.includes(id) || trip.state.progress[id] === 'done',
      );
      if (d.id === target.id)
        d.stepIds = [...restoredIds, ...completedExtras].sort((a, b) => {
          const sa =
            trip.state.progress[a] === 'done'
              ? getStep(trip, a)
              : original.steps.find((s) => s.id === a)!;
          const sb =
            trip.state.progress[b] === 'done'
              ? getStep(trip, b)
              : original.steps.find((s) => s.id === b)!;
          return Date.parse(sa.start) - Date.parse(sb.start);
        });
    }
    for (const s of original.steps.filter((s) => originalIds.includes(s.id))) {
      if (trip.state.progress[s.id] === 'done') continue;
      const booked = fixedStart(trip, getStep(trip, s.id));
      if (booked && Date.parse(booked) !== Date.parse(s.start))
        throw new TravelError(
          'invalid',
          `${s.title}: l’orario originale non coincide con la prenotazione.`,
        );
      trip.plan.steps[trip.plan.steps.findIndex((v) => v.id === s.id)] = structuredClone(s);
      delete travel.locks[s.id];
      if (trip.state.progress[s.id] === 'skipped') delete trip.state.progress[s.id];
    }
    reschedule(trip, target.id, trip.plan);
    for (const d of trip.plan.days) {
      if (
        d.id !== target.id &&
        before.plan.days.find((b) => b.id === d.id)!.stepIds.some((id) => originalIds.includes(id))
      ) {
        repairRoutes(trip, d.id, command.routes, command.id, before.plan);
        reschedule(trip, d.id, before.plan);
      }
    }
  } else {
    const d = getDay(trip, action.dayId);
    if (action.type === 'add') {
      if (trip.plan.steps.some((s) => s.id === action.stop.id))
        throw new TravelError('invalid', 'La nuova tappa ha un ID già utilizzato.');
      if (action.place) {
        if (trip.plan.places.some((p) => p.id === action.place!.id))
          throw new TravelError('invalid', 'Il luogo ha un ID già utilizzato.');
        trip.plan.places.push(action.place);
      }
      trip.plan.steps.push(action.stop);
      insert(d.stepIds, action.stop.id, action.afterId);
      repairRoutes(trip, d.id, command.routes, command.id, before.plan);
      reschedule(trip, d.id, before.plan);
    } else {
      const s = getStep(trip, action.stepId);
      requireEditable(trip, s.id);
      if (action.type === 'lock') {
        if (!d.stepIds.includes(s.id))
          throw new TravelError('conflict', 'La tappa non è attiva in questa giornata.');
        const booked = trip.state.reservations.some(
          (r) => r.stepId === s.id && r.status === 'booked' && r.slot,
        );
        if (booked || (s.kind === 'leg' && s.mode === 'flight'))
          throw new TravelError('invalid', 'L’orario è fissato dal viaggio o dalla prenotazione.');
        if (action.fixed) travel.locks[s.id] = s.start;
        else delete travel.locks[s.id];
      } else if (action.type === 'skip') {
        if (s.kind !== 'stop')
          throw new TravelError(
            'invalid',
            'Salta una tappa: il collegamento viene adattato insieme.',
          );
        if (
          trip.state.reservations.some((r) => r.stepId === s.id && r.status === 'booked') &&
          !action.acknowledgedBooking
        )
          throw new TravelError(
            'invalid',
            'Saltare non cancella la prenotazione. Conferma di averlo letto.',
          );
        if (action.included) {
          if (activeIds(trip).has(s.id))
            throw new TravelError('invalid', 'Questa tappa è già attiva.');
          insert(d.stepIds, s.id, action.afterId);
          delete trip.state.progress[s.id];
        } else {
          if (!d.stepIds.includes(s.id))
            throw new TravelError('conflict', 'La tappa non è più in questa giornata.');
          d.stepIds = d.stepIds.filter((id) => id !== s.id);
          trip.state.progress[s.id] = 'skipped';
        }
        repairRoutes(trip, d.id, command.routes, command.id, before.plan);
        reschedule(trip, d.id, before.plan);
      } else if (action.type === 'move') {
        if (s.kind !== 'stop' || !d.stepIds.includes(s.id))
          throw new TravelError('invalid', 'Scegli una tappa attiva da spostare.');
        if (fixedStart(trip, s))
          throw new TravelError('invalid', 'Questa tappa ha un orario fisso.');
        const target = getDay(trip, action.toDayId);
        if (action.afterId === s.id)
          throw new TravelError('invalid', 'Scegli una posizione diversa.');
        d.stepIds = d.stepIds.filter((id) => id !== s.id);
        insert(target.stepIds, s.id, action.afterId);
        if (d.id !== target.id) {
          const local = zonedInput(s.start, s.timezone ?? trip.plan.timezone);
          shiftStep(
            s,
            Date.parse(
              inputToInstant(`${target.date}T${local.slice(11)}`, s.timezone ?? trip.plan.timezone),
            ),
          );
        }
        const preferred = structuredClone(before.plan);
        preferred.steps = preferred.steps.map((v) => (v.id === s.id ? structuredClone(s) : v));
        for (const id of new Set([d.id, target.id])) {
          repairRoutes(trip, id, command.routes, command.id, before.plan);
          reschedule(trip, id, preferred);
        }
      } else {
        const index = d.stepIds.indexOf(s.id);
        if (index < 0) throw new TravelError('conflict', 'La tappa non è più in questa giornata.');
        const anchor = fixedStart(trip, s);
        if (
          anchor &&
          (action.type === 'delay' ||
            (s.kind === 'leg' && s.mode === 'flight') ||
            (action.type === 'timing' &&
              action.start &&
              Date.parse(action.start) !== Date.parse(anchor)))
        )
          throw new TravelError('invalid', 'Questa attività ha un orario fisso.');
        if (action.type === 'delay')
          reschedule(trip, d.id, before.plan, index, Date.parse(s.start) + action.minutes * 60000);
        else {
          if (action.leaveAt) {
            const end = Date.parse(action.leaveAt);
            if (end <= Date.parse(s.start))
              throw new TravelError('invalid', 'La partenza deve seguire l’inizio dell’attività.');
            s.end = action.leaveAt;
            if (s.kind === 'leg')
              s.durationMinutes = Math.round((end - Date.parse(s.start)) / 60000);
            trip.state.progress[s.id] = 'done';
            travel.completedAt[s.id] = action.leaveAt;
            if (index + 1 < d.stepIds.length) reschedule(trip, d.id, before.plan, index + 1, end);
          } else {
            const duration =
              action.durationMinutes ?? (Date.parse(s.end) - Date.parse(s.start)) / 60000;
            const start = Date.parse(action.start ?? s.start);
            if (Date.parse(s.start) !== start) s.start = new Date(start).toISOString();
            s.end = new Date(start + duration * 60000).toISOString();
            if (s.kind === 'leg') {
              if (s.durationMinutes !== duration && s.routeEvidence) {
                delete s.routeEvidence;
                s.estimate = true;
                s.summary = `Durata adattata: ${duration} min. Stima da verificare.`;
              }
              s.durationMinutes = duration;
            }
            if (action.following) reschedule(trip, d.id, before.plan, index, start);
          }
        }
      }
    }
  }
  // No schedule action may alter an already completed activity or a live fixed slot.
  for (const previous of input.plan.steps) {
    const current = trip.plan.steps.find((s) => s.id === previous.id)!;
    if (
      input.state.progress[previous.id] === 'done' &&
      (current.start !== previous.start ||
        current.end !== previous.end ||
        activeIds(input).has(previous.id) !== activeIds(trip).has(previous.id))
    )
      throw new TravelError('invalid', 'Le attività completate restano nel diario.');
    if (
      action.type !== 'note' &&
      action.type !== 'lock' &&
      activeIds(trip).has(previous.id) &&
      (current.start !== previous.start || current.end !== previous.end)
    ) {
      const fixed = fixedStart(input, previous);
      if (fixed && Date.parse(current.start) !== Date.parse(fixed))
        throw new TravelError('invalid', `${previous.title}: conserva l’orario fisso.`);
    }
  }
  const valid = TripSchema.safeParse(trip);
  if (!valid.success)
    throw new TravelError(
      'invalid',
      'Il programma contiene orari sovrapposti, un giorno non valido o un collegamento incompleto. Rivedi l’anteprima.',
    );
  travel.appliedIds.push(command.id);
  travel.history.push({
    id: command.id,
    title: commandTitle(action),
    at: command.at,
    before,
    after: Object.fromEntries(Object.keys(required).map((key) => [key, fingerprint(trip, key)])),
  });
  travel.history = travel.history.slice(-20);
  return trip;
}

/** Connections that need a manual estimate, using the same command projection as validation. */
export function routeNeeds(trip: Trip, action: TravelAction): RouteInput[] {
  if (!['move', 'add', 'skip', 'restore'].includes(action.type)) return [];
  const places = [
    ...trip.plan.places,
    ...(action.type === 'add' && action.place ? [action.place] : []),
  ];
  const routes = places.flatMap((a) =>
    places
      .filter((b) => b.id !== a.id)
      .map((b) => ({
        fromPlaceId: a.id,
        toPlaceId: b.id,
        mode: 'walk' as const,
        durationMinutes: 1,
      })),
  );
  try {
    const result = applyTravel(trip, {
      id: 'route-preview',
      action,
      routes,
      expected: preconditions(trip, action),
      at: new Date().toISOString(),
    });
    return result.plan.steps
      .filter((s) => s.id.startsWith('route-route-preview-'))
      .flatMap((s) =>
        s.kind === 'leg'
          ? [
              {
                fromPlaceId: s.fromPlaceId,
                toPlaceId: s.toPlaceId,
                mode: 'walk' as const,
                durationMinutes: 15,
              },
            ]
          : [],
      );
  } catch {
    // Find structural connections even if the trial schedule cannot fit a fixed slot.
    try {
      const draft = structuredClone(trip),
        a = action;
      if (a.type === 'add') {
        draft.plan.steps.push(a.stop);
        insert(getDay(draft, a.dayId).stepIds, a.stop.id, a.afterId);
      }
      if (a.type === 'move') {
        const d = getDay(draft, a.dayId);
        d.stepIds = d.stepIds.filter((id) => id !== a.stepId);
        insert(getDay(draft, a.toDayId).stepIds, a.stepId, a.afterId);
      }
      if (a.type === 'skip') {
        const d = getDay(draft, a.dayId);
        if (a.included) insert(d.stepIds, a.stepId, a.afterId);
        else d.stepIds = d.stepIds.filter((id) => id !== a.stepId);
      }
      const needs: RouteInput[] = [];
      for (const d of draft.plan.days) {
        const stops = d.stepIds.map((id) => getStep(draft, id)).filter((s) => s.kind === 'stop');
        for (let i = 1; i < stops.length; i++) {
          const from = stops[i - 1].placeId,
            to = stops[i].placeId;
          if (from !== to && !connection(draft, trip.plan, d.id, stops[i - 1], stops[i]))
            needs.push({ fromPlaceId: from, toPlaceId: to, mode: 'walk', durationMinutes: 15 });
        }
      }
      return needs;
    } catch {
      return [];
    }
  }
}
