import type { Plan, Step, Trip } from './schema';

export function orderedSteps(plan: Plan): Step[] {
  return plan.days
    .flatMap((d) => d.stepIds.map((id) => plan.steps.find((s) => s.id === id)!))
    .filter(Boolean);
}
export function time(value: string, zone: string) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
export function dayLabel(value: string) {
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(value + 'T12:00:00Z'));
}
export function money(value: number, currency: string) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}
export function currentStep(trip: Trip, now = new Date()): Step | undefined {
  const steps = orderedSteps(trip.plan);
  return (
    steps.find((s) => Date.parse(s.start) <= +now && Date.parse(s.end) > +now) ??
    steps.find((s) => Date.parse(s.start) > +now && trip.state.progress[s.id] !== 'skipped') ??
    steps.at(-1)
  );
}
export function navigationUrl(step: Step, plan: Plan, segment = 0): string {
  const query = (id: string) => {
    const p = plan.places.find((v) => v.id === id)!;
    return p.coordinates
      ? `${p.coordinates.lat},${p.coordinates.lng}`
      : `${p.localName ?? p.name}, ${p.address}`;
  };
  if (step.kind === 'stop')
    return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: query(step.placeId) })}`;
  const ids = [
    step.fromPlaceId,
    ...step.pois.filter((v) => !v.detourMinutes).map((v) => v.placeId),
    step.toPlaceId,
  ];
  const chunks = ids.slice(segment * 4, segment * 4 + 5);
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', origin: query(chunks[0]), destination: query(chunks.at(-1)!), travelmode: step.mode === 'walk' ? 'walking' : step.mode === 'taxi' ? 'driving' : 'transit', ...(chunks.length > 2 ? { waypoints: chunks.slice(1, -1).map(query).join('|') } : {}) })}`;
}
export function navigationSegments(step: Step): number {
  return step.kind === 'stop'
    ? 1
    : Math.max(1, Math.ceil((1 + step.pois.filter((v) => !v.detourMinutes).length) / 4));
}
export function budget(trip: Trip) {
  const sums: Record<string, { min: number; max: number; unknown: number; paid: number }> = {};
  for (const c of trip.plan.costs.filter((c) => c.inclusion === 'base')) {
    const row = (sums[c.currency] ??= { min: 0, max: 0, unknown: 0, paid: 0 });
    const count = c.basis === 'person' ? trip.plan.travellers.length : 1;
    if (c.min === null || c.max === null) row.unknown++;
    else {
      row.min += c.min * count;
      row.max += c.max * count;
    }
  }
  // Paid amounts are group totals and tracked separately from the estimate.
  for (const r of trip.state.reservations.filter(
    (r) => r.status === 'booked' && r.paidAmount !== undefined && r.currency,
  )) {
    const row = (sums[r.currency!] ??= { min: 0, max: 0, unknown: 0, paid: 0 });
    row.paid += r.paidAmount!;
  }
  return sums;
}
export function bookingWarnings(trip: Trip): string[] {
  return trip.state.reservations
    .filter((r) => r.status === 'booked' && r.slot)
    .flatMap((r) => {
      const s = trip.plan.steps.find((s) => s.id === r.stepId);
      return s && +new Date(s.start) !== +new Date(r.slot!)
        ? [`${r.title}: l'orario prenotato è diverso dal programma. Aggiorna l'itinerario.`]
        : [];
    });
}
