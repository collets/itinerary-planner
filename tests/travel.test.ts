import { describe, expect, it } from 'vitest';
import { exampleTrip } from '../src/domain/fixture';
import {
  applyTravel,
  preconditions,
  upgradeTrip,
  type TravelAction,
  type TravelCommand,
} from '../src/domain/travel';
import type { Trip } from '../src/domain/schema';
function cmd(trip: Trip, action: TravelAction, id = crypto.randomUUID()): TravelCommand {
  return {
    id,
    action,
    routes: [],
    expected: preconditions(trip, action),
    at: '2026-11-12T08:00:00Z',
  };
}
describe('travel adjustments', () => {
  it('delays without changing the authored plan, deduplicates and undoes', () => {
    const initial = exampleTrip(),
      command = cmd(initial, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 30 });
    const result = applyTravel(initial, command);
    expect(Date.parse(result.plan.steps[2].start) - Date.parse(initial.plan.steps[2].start)).toBe(
      30 * 60000,
    );
    expect(result.travel!.originalPlan).toEqual(initial.plan);
    expect(applyTravel(result, command)).toEqual(result);
    const undone = applyTravel(result, cmd(result, { type: 'undo', historyId: command.id }));
    expect(undone.plan).toEqual(initial.plan);
  });
  it('absorbs spare time and refuses to cross a booked slot', () => {
    const trip = exampleTrip();
    trip.plan.steps[2].start = '2026-11-12T11:00:00+01:00';
    trip.plan.steps[2].end = '2026-11-12T12:30:00+01:00';
    trip.state.reservations.push({
      id: 'booking',
      title: 'Museum',
      stepId: 'museum',
      travellerIds: ['traveller-one'],
      status: 'booked',
      slot: trip.plan.steps[2].start,
      reference: '',
      notes: '',
    });
    expect(
      applyTravel(
        trip,
        cmd(trip, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 30 }),
      ).plan.steps[2].start,
    ).toBe(trip.plan.steps[2].start);
    expect(() =>
      applyTravel(
        trip,
        cmd(trip, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 60 }),
      ),
    ).toThrow(/orario fisso/);
  });
  it('archives skipped visits and preserves payments and ticket associations', () => {
    const trip = exampleTrip();
    trip.state.reservations.push({
      id: 'booking',
      title: 'Museum',
      stepId: 'museum',
      travellerIds: ['traveller-one'],
      status: 'booked',
      paidAmount: 30,
      currency: 'EUR',
      reference: '',
      notes: '',
    });
    const result = applyTravel(
      trip,
      cmd(trip, {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'museum',
        included: false,
        acknowledgedBooking: true,
      }),
    );
    expect(result.plan.days[0].stepIds).toEqual(['square']);
    expect(result.plan.steps).toEqual(trip.plan.steps);
    expect(result.state.reservations).toEqual(trip.state.reservations);
    const restored = applyTravel(
      result,
      cmd(result, {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'museum',
        included: true,
        afterId: 'square',
        acknowledgedBooking: true,
      }),
    );
    expect(restored.plan.days[0].stepIds).toEqual(trip.plan.days[0].stepIds);
  });
  it('merges independent notes but pauses concurrent changes to a day or the same note', () => {
    const trip = exampleTrip(),
      delay = cmd(trip, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 15 });
    const withNote = applyTravel(
      trip,
      cmd(trip, { type: 'note', targetId: 'square', text: 'Coffee' }),
    );
    expect(applyTravel(withNote, delay).travel!.notes.square).toBe('Coffee');
    expect(() =>
      applyTravel(
        applyTravel(trip, delay),
        cmd(trip, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 30 }),
      ),
    ).toThrow(/condiviso/);
    expect(() =>
      applyTravel(withNote, cmd(trip, { type: 'note', targetId: 'square', text: 'Lunch' })),
    ).toThrow(/condiviso/);
  });
  it('restores a day while retaining completed visits and notes', () => {
    let trip = upgradeTrip(exampleTrip());
    trip.state.progress.square = 'done';
    trip = applyTravel(
      trip,
      cmd(trip, { type: 'delay', dayId: 'day-one', stepId: 'museum', minutes: 30 }),
    );
    trip = applyTravel(trip, cmd(trip, { type: 'note', targetId: 'museum', text: 'Keep this' }));
    const restored = applyTravel(trip, cmd(trip, { type: 'restore', dayId: 'day-one' }));
    expect(restored.plan).toEqual(restored.travel!.originalPlan);
    expect(restored.state.progress.square).toBe('done');
    expect(restored.travel!.notes.museum).toBe('Keep this');
  });
  it('needs explicit provisional routes after reordering; never copies streets or POIs', () => {
    const trip = exampleTrip(),
      command = cmd(trip, { type: 'move', dayId: 'day-one', stepId: 'museum', toDayId: 'day-one' });
    expect(() => applyTravel(trip, command)).toThrow(/mezzo e minuti/);
    command.routes = [
      { fromPlaceId: 'blue-museum', toPlaceId: 'blue-square', mode: 'taxi', durationMinutes: 10 },
    ];
    const result = applyTravel(trip, command),
      leg = result.plan.steps.find((s) => s.id.startsWith('route-'))!;
    expect(leg.kind === 'leg' && leg.streets).toEqual([]);
    expect(leg.kind === 'leg' && leg.pois).toEqual([]);
    expect(result.plan.days[0].stepIds[0]).toBe('museum');
  });
  it('allows an empty day while keeping archived records', () => {
    let trip = exampleTrip();
    trip = applyTravel(
      trip,
      cmd(trip, {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'museum',
        included: false,
        acknowledgedBooking: false,
      }),
    );
    trip = applyTravel(
      trip,
      cmd(trip, {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'square',
        included: false,
        acknowledgedBooking: false,
      }),
    );
    expect(trip.plan.days[0].stepIds).toEqual([]);
    expect(trip.plan.steps).toHaveLength(3);
  });
});

describe('travel serialization and days', () => {
  it('keeps queue preconditions stable across schema parsing and server JSON round trips', async () => {
    const { TripSchema } = await import('../src/domain/schema');
    const trip = exampleTrip(),
      move = cmd(trip, { type: 'move', dayId: 'day-one', stepId: 'museum', toDayId: 'day-one' });
    move.routes = [
      { fromPlaceId: 'blue-museum', toPlaceId: 'blue-square', mode: 'taxi', durationMinutes: 10 },
    ];
    const local = applyTravel(trip, move),
      next = cmd(local, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 15 });
    const stored = TripSchema.parse(JSON.parse(JSON.stringify(local)));
    expect(() => applyTravel(stored, next)).not.toThrow();
  });
  it('moves between days and rejects moving completed or fixed visits', async () => {
    const { TripSchema } = await import('../src/domain/schema');
    const trip = exampleTrip();
    trip.plan.endDate = '2026-11-13';
    trip.plan.days.push({
      id: 'day-two',
      date: '2026-11-13',
      title: 'Second day',
      summary: '',
      stepIds: ['coffee'],
    });
    const museum = trip.plan.steps[2];
    if (museum.kind !== 'stop') throw new Error();
    trip.plan.steps.push({
      ...museum,
      id: 'coffee',
      start: '2026-11-13T09:00:00+01:00',
      end: '2026-11-13T10:00:00+01:00',
    });
    const valid = TripSchema.parse(trip),
      move = cmd(valid, {
        type: 'move',
        dayId: 'day-one',
        stepId: 'square',
        toDayId: 'day-two',
        afterId: 'coffee',
      });
    move.routes = [
      { fromPlaceId: 'blue-museum', toPlaceId: 'blue-square', mode: 'walk', durationMinutes: 15 },
    ];
    const result = applyTravel(valid, move);
    expect(result.plan.days[0].stepIds).toEqual(['museum']);
    expect(result.plan.days[1].stepIds).toHaveLength(3);
    expect(result.plan.steps.find((s) => s.id === 'square')!.start).toContain('2026-11-13');
    const completed = structuredClone(valid);
    completed.state.progress.square = 'done';
    expect(() => applyTravel(completed, cmd(completed, move.action))).toThrow(/completate/);
    const fixed = applyTravel(
      valid,
      cmd(valid, { type: 'lock', dayId: 'day-one', stepId: 'square', fixed: true }),
    );
    expect(() => applyTravel(fixed, cmd(fixed, move.action))).toThrow(/orario fisso/);
  });
  it('records actual departure and protects it while allowing independent notes', () => {
    const trip = exampleTrip(),
      now = '2026-11-12T09:05:00Z';
    const result = applyTravel(
      trip,
      cmd(trip, {
        type: 'timing',
        dayId: 'day-one',
        stepId: 'square',
        following: true,
        leaveAt: now,
      }),
    );
    expect(result.state.progress.square).toBe('done');
    expect(result.travel!.completedAt.square).toBe(now);
    expect(result.plan.steps[0].end).toBe(now);
    expect(() =>
      applyTravel(
        result,
        cmd(result, { type: 'delay', dayId: 'day-one', stepId: 'square', minutes: 15 }),
      ),
    ).toThrow(/completate/);
    expect(
      applyTravel(result, cmd(result, { type: 'note', targetId: 'square', text: 'Arrived' }))
        .travel!.notes.square,
    ).toBe('Arrived');
  });
});

it('retains authored transport chains when an unrelated stop is skipped', async () => {
  const { TripSchema } = await import('../src/domain/schema');
  const trip = exampleTrip(),
    leg = trip.plan.steps[1];
  if (leg.kind !== 'leg') throw new Error();
  leg.toPlaceId = 'blue-garden';
  leg.end = '2026-11-12T10:05:00+01:00';
  leg.durationMinutes = 5;
  trip.plan.steps.push({
    ...leg,
    id: 'walk-two',
    fromPlaceId: 'blue-garden',
    toPlaceId: 'blue-museum',
    start: leg.end,
    end: '2026-11-12T10:15:00+01:00',
    durationMinutes: 10,
  });
  const stop = trip.plan.steps[2];
  if (stop.kind !== 'stop') throw new Error();
  trip.plan.steps.push({
    ...stop,
    id: 'coffee',
    placeId: 'blue-museum',
    start: stop.end,
    end: '2026-11-12T12:00:00+01:00',
  });
  trip.plan.days[0].stepIds = ['square', 'walk', 'walk-two', 'museum', 'coffee'];
  const valid = TripSchema.parse(trip),
    result = applyTravel(
      valid,
      cmd(valid, {
        type: 'skip',
        dayId: 'day-one',
        stepId: 'coffee',
        included: false,
        acknowledgedBooking: false,
      }),
    );
  expect(result.plan.days[0].stepIds).toEqual(['square', 'walk', 'walk-two', 'museum']);
});

it('allows an explicit shorter booked visit while preserving its fixed start', () => {
  const trip = exampleTrip();
  trip.state.reservations.push({
    id: 'booking',
    title: 'Museum',
    stepId: 'museum',
    travellerIds: ['traveller-one'],
    status: 'booked',
    slot: trip.plan.steps[2].start,
    reference: '',
    notes: '',
  });
  const result = applyTravel(
    trip,
    cmd(trip, {
      type: 'timing',
      dayId: 'day-one',
      stepId: 'museum',
      durationMinutes: 30,
      following: true,
    }),
  );
  expect(result.plan.steps[2].start).toBe(trip.plan.steps[2].start);
  expect(Date.parse(result.plan.steps[2].end) - Date.parse(result.plan.steps[2].start)).toBe(
    30 * 60000,
  );
});
