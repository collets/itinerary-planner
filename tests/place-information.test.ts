import { describe, expect, it } from 'vitest';
import { information } from './fixtures/place-information';
import {
  PlaceInformationSchema,
  informationFresh,
  visitWindowStatus,
} from '../src/domain/place-information';

describe('Sourced place information', () => {
  it('requires actual field references and official evidence for practical facts', () => {
    const fact = information();
    expect(PlaceInformationSchema.parse(fact)).toEqual(fact);
    fact.openingHours!.sourceIds = ['invented'];
    expect(PlaceInformationSchema.safeParse(fact).success).toBe(false);
    fact.openingHours!.sourceIds = ['official'];
    fact.sources[0].kind = 'secondary';
    expect(PlaceInformationSchema.safeParse(fact).success).toBe(false);
  });
  it('rejects unsafe links, mismatched booking hosts, reversed prices and impossible intervals', () => {
    for (const url of [
      'http://museum.example/',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://private.internal/',
      'https://u:p@museum.example/',
      'https://museum.example/?token=SECRET',
    ]) {
      const fact = information();
      fact.sources[0].url = url;
      expect(PlaceInformationSchema.safeParse(fact).success).toBe(false);
    }
    const wrongHost = information();
    wrongHost.bookingUrl = { url: 'https://checkout.example/', sourceIds: ['official'] };
    expect(PlaceInformationSchema.safeParse(wrongHost).success).toBe(false);
    const price = information();
    price.price!.max = 1;
    expect(PlaceInformationSchema.safeParse(price).success).toBe(false);
    const hours = information();
    hours.openingHours!.windows = [{ opens: '18:00', closes: '09:00' }];
    expect(PlaceInformationSchema.safeParse(hours).success).toBe(false);
  });
  it('uses the visit date and local timezone, never treating missing hours as open', () => {
    const fact = information();
    expect(
      visitWindowStatus(fact, '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z', 'Europe/Warsaw'),
    ).toBe('fits');
    expect(
      visitWindowStatus(fact, '2026-11-12T17:00:00Z', '2026-11-12T18:00:00Z', 'Europe/Warsaw'),
    ).toBe('outside');
    expect(
      visitWindowStatus(fact, '2026-11-13T08:00:00Z', '2026-11-13T09:00:00Z', 'Europe/Warsaw'),
    ).toBe('unknown');
    fact.openingHours!.visitStatus = 'closed';
    fact.openingHours!.windows = [];
    expect(
      visitWindowStatus(fact, '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z', 'Europe/Warsaw'),
    ).toBe('outside');
    fact.openingHours = null;
    expect(
      visitWindowStatus(fact, '2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z', 'Europe/Warsaw'),
    ).toBe('unknown');
  });
  it('bounds date-specific cache freshness', () => {
    const fact = information();
    const now = Date.parse(fact.checkedAt);
    expect(informationFresh(fact, fact.visitDate, now + 3600000)).toBe(true);
    expect(informationFresh(fact, '2026-11-13', now)).toBe(false);
    expect(informationFresh(fact, fact.visitDate, now + 86400000)).toBe(false);
    expect(informationFresh(fact, fact.visitDate, now - 1)).toBe(false);
  });
});
