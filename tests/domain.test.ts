import { describe, expect, it } from 'vitest';
import { exampleTrip } from '../src/domain/fixture';
import { TripSchema, SafeUrl } from '../src/domain/schema';
import {
  budget,
  navigationUrl,
  navigationSegments,
  bookingWarnings,
  time,
} from '../src/domain/trip';
import { inputToInstant, zonedInput } from '../src/domain/datetime';
describe('trip integrity', () => {
  it('rejects dangling references and duplicated day membership', () => {
    const trip = exampleTrip();
    trip.plan.steps[0] = {
      ...trip.plan.steps[0],
      kind: 'stop',
      category: 'visit',
      placeId: 'missing',
    };
    expect(TripSchema.safeParse(trip).success).toBe(false);
    const duplicate = exampleTrip();
    duplicate.plan.days[0].stepIds.push('square');
    expect(TripSchema.safeParse(duplicate).success).toBe(false);
  });
  it('rejects overlaps, invalid calendar dates and active-content links', () => {
    const trip = exampleTrip();
    trip.plan.steps[1].start = trip.plan.steps[0].start;
    expect(TripSchema.safeParse(trip).success).toBe(false);
    trip.plan.startDate = '2026-02-30';
    expect(TripSchema.safeParse(trip).success).toBe(false);
    expect(SafeUrl.safeParse('javascript:alert(1)').success).toBe(false);
  });
  it('keeps group payments distinct from per-person estimates', () => {
    const trip = exampleTrip();
    trip.state.reservations.push({
      id: 'booking',
      title: 'Ingresso',
      stepId: 'museum',
      travellerIds: ['traveller-one', 'traveller-two'],
      status: 'booked',
      reference: '',
      notes: '',
      paidAmount: 28.5,
      currency: 'EUR',
      slot: '2026-11-12T12:00:00+01:00',
    });
    expect(budget(trip).EUR).toEqual({ min: 30, max: 30, unknown: 0, paid: 28.5 });
    expect(bookingWarnings(trip)).toHaveLength(1);
    expect(trip.plan.steps[2].start).toContain('10:15');
  });
  it('splits mobile map routes without losing the connecting waypoint', () => {
    const trip = exampleTrip();
    const step = trip.plan.steps[1];
    if (step.kind !== 'leg') throw new Error();
    step.pois = Array.from({ length: 7 }, () => ({
      placeId: 'blue-garden',
      note: '',
      detourMinutes: 0,
    }));
    expect(navigationSegments(step)).toBe(2);
    const first = new URL(navigationUrl(step, trip.plan, 0)),
      next = new URL(navigationUrl(step, trip.plan, 1));
    expect(first.searchParams.get('waypoints')?.split('|')).toHaveLength(3);
    expect(first.searchParams.get('destination')).toBe(next.searchParams.get('origin'));
  });
  it('converts booking form values in the trip timezone, including DST', () => {
    expect(inputToInstant('2026-10-08T09:30', 'Europe/Warsaw')).toBe('2026-10-08T07:30:00.000Z');
    expect(zonedInput('2026-10-08T07:30:00Z', 'Europe/Warsaw')).toBe('2026-10-08T09:30');
    expect(time('2026-10-08T07:30:00Z', 'Europe/Warsaw')).toBe('09:30');
    expect(() => inputToInstant('2026-03-29T02:30', 'Europe/Rome')).toThrow();
  });
});
