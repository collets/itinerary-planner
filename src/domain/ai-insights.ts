import { visitWindowStatus } from './place-information.js';
import type { Trip } from './schema.js';
import { archivedSteps, fingerprint } from './travel.js';

/** Calculated locally; never disclose identities, ticket data or booking references. */
export function dayInsights(trip: Trip, dayId: string, now: number) {
  const day = trip.plan.days.find((d) => d.id === dayId)!;
  const steps = day.stepIds.map((id) => trip.plan.steps.find((s) => s.id === id)!);
  const active = new Set(day.stepIds);
  const paidSteps = new Set([...day.stepIds, ...archivedSteps(trip, dayId).map((s) => s.id)]);
  const zone = trip.plan.timezone;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
  const sameDate = today === day.date;
  const remaining = steps.filter(
    (s) =>
      trip.state.progress[s.id] !== 'done' &&
      trip.state.progress[s.id] !== 'skipped' &&
      (!sameDate || Date.parse(s.end) > now),
  );
  const gaps = steps.slice(1).flatMap((s, i) => {
    const minutes = Math.floor((Date.parse(s.start) - Date.parse(steps[i].end)) / 60000);
    return minutes > 0 ? [{ afterStepId: steps[i].id, beforeStepId: s.id, minutes }] : [];
  });
  const issues: Array<{
    stepId: string;
    kind: 'opening' | 'booking' | 'route' | 'past';
    message: string;
  }> = [];
  for (const s of steps) {
    if (s.kind === 'stop') {
      const info = trip.plan.places.find((p) => p.id === s.placeId)?.information;
      if (info && visitWindowStatus(info, s.start, s.end, s.timezone ?? zone) === 'outside')
        issues.push({
          stepId: s.id,
          kind: 'opening',
          message: 'La visita è fuori dalle aperture indicate; verifica data e ultimo ingresso.',
        });
    } else if (s.mode === 'walk' && !s.routeEvidence)
      issues.push({
        stepId: s.id,
        kind: 'route',
        message: 'Collegamento senza percorso verificato; durata indicativa.',
      });
    if (
      trip.state.reservations.some(
        (r) =>
          r.stepId === s.id &&
          r.status === 'booked' &&
          r.slot &&
          Date.parse(r.slot) !== Date.parse(s.start),
      )
    )
      issues.push({
        stepId: s.id,
        kind: 'booking',
        message: 'Orario del programma diverso dalla prenotazione.',
      });
    if (
      sameDate &&
      Date.parse(s.end) <= now &&
      !['done', 'skipped'].includes(trip.state.progress[s.id] ?? 'pending')
    )
      issues.push({
        stepId: s.id,
        kind: 'past',
        message: 'Orario passato, completamento non registrato.',
      });
  }
  const costs: Record<
    string,
    {
      min: number;
      max: number;
      unknown: number;
      paid: number;
      euro: { min: number; max: number; asOf: string } | null;
    }
  > = {};
  for (const c of trip.plan.costs.filter(
    (c) => c.inclusion === 'base' && c.stepIds.some((id) => active.has(id)),
  )) {
    const row = (costs[c.currency] ??= { min: 0, max: 0, unknown: 0, paid: 0, euro: null });
    const count = c.basis === 'person' ? trip.plan.travellers.length : 1;
    if (c.min === null || c.max === null) row.unknown++;
    else {
      row.min += c.min * count;
      row.max += c.max * count;
    }
  }
  for (const r of trip.state.reservations.filter(
    (r) =>
      paidSteps.has(r.stepId) && r.status === 'booked' && r.paidAmount !== undefined && r.currency,
  )) {
    const row = (costs[r.currency!] ??= { min: 0, max: 0, unknown: 0, paid: 0, euro: null });
    row.paid += r.paidAmount!;
  }
  for (const [currency, row] of Object.entries(costs)) {
    const fx = trip.state.exchangeRates.find((r) => r.currency === currency);
    if (currency === 'EUR') row.euro = { min: row.min, max: row.max, asOf: day.date };
    else if (fx)
      row.euro = {
        min: Math.round(row.min * fx.euroPerUnit * 100) / 100,
        max: Math.round(row.max * fx.euroPerUnit * 100) / 100,
        asOf: fx.asOf,
      };
  }
  return {
    calculatedAt: new Date(now).toISOString(),
    date: day.date,
    timezone: zone,
    currentStepId: sameDate
      ? (steps.find((s) => Date.parse(s.start) <= now && Date.parse(s.end) > now)?.id ?? null)
      : null,
    remainingStepIds: remaining.map((s) => s.id),
    walkingMinutes: steps.reduce(
      (sum, s) => sum + (s.kind === 'leg' && s.mode === 'walk' ? s.durationMinutes : 0),
      0,
    ),
    remainingMinutes: remaining.reduce(
      (sum, s) =>
        sum +
        Math.max(
          0,
          (Date.parse(s.end) -
            Math.max(Date.parse(s.start), sameDate ? now : Date.parse(s.start))) /
            60000,
        ),
      0,
    ),
    gaps,
    costs,
    issues,
    costNote:
      'Stime base delle tappe attive per tutti i viaggiatori; costi opzionali e senza tappa esclusi. Pagamenti separati, anche per tappe archiviate. Prezzi ricercati non sommati automaticamente alle stime.',
  };
}
export function undoChoices(trip: Trip, dayId: string) {
  const placeIds = new Set(
    trip.plan.days
      .find((d) => d.id === dayId)!
      .stepIds.flatMap((id) => {
        const s = trip.plan.steps.find((s) => s.id === id)!;
        return s.kind === 'stop' ? [s.placeId] : [];
      }),
  );
  return (trip.travel?.history ?? [])
    .filter((h) => {
      const keys = Object.keys(h.after);
      return (
        keys.length > 0 &&
        keys.every(
          (k) =>
            k === `day:${dayId}` ||
            (k.startsWith('information:') && placeIds.has(k.slice(12))) ||
            (k.startsWith('location:') && placeIds.has(k.slice(9))),
        )
      );
    })
    .slice(-10)
    .map((h) => {
      const available = Object.entries(h.after).every(
        ([key, value]) => fingerprint(trip, key) === value,
      );
      const beforeDay = h.before.plan.days.find((d) => d.id === dayId)!;
      const currentDay = trip.plan.days.find((d) => d.id === dayId)!;
      const changed = available
        ? [...new Set([...beforeDay.stepIds, ...currentDay.stepIds])]
            .filter((id) => {
              const old = h.before.plan.steps.find((s) => s.id === id),
                current = trip.plan.steps.find((s) => s.id === id);
              return (
                beforeDay.stepIds.includes(id) !== currentDay.stepIds.includes(id) ||
                old?.start !== current?.start ||
                old?.end !== current?.end
              );
            })
            .slice(0, 6)
            .map((id) => ({
              id,
              title: (
                trip.plan.steps.find((s) => s.id === id)?.title ??
                h.before.plan.steps.find((s) => s.id === id)?.title ??
                ''
              ).slice(0, 160),
            }))
        : [];
      return {
        id: h.id,
        title: h.title.slice(0, 160),
        at: h.at,
        available,
        affectedSteps: changed,
      };
    });
}
