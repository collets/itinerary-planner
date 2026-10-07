import type { PlaceInformation } from '../../src/domain/place-information';
/** Entirely synthetic evidence; never sent to a live provider. */
export function information(
  visitDate = '2026-11-12',
  checkedAt = '2026-10-05T12:00:00.000Z',
): PlaceInformation {
  const sourceIds = ['official'];
  return {
    checkedAt,
    visitDate,
    description: { text: 'Descrizione sintetica del museo.', sourceIds },
    details: null,
    trivia: { text: 'Una curiosità basata sulla fonte sintetica.', sourceIds },
    entrance: null,
    openingHours: {
      text: 'Apertura indicata dalle 09:00 alle 18:00.',
      visitStatus: 'open',
      windows: [{ opens: '09:00', closes: '18:00' }],
      sourceIds,
    },
    price: {
      label: 'Ingresso adulti alla mostra sintetica',
      min: 20,
      max: 25,
      currency: 'EUR',
      basis: 'person',
      sourceIds,
    },
    website: { url: 'https://museum.example/', sourceIds },
    bookingUrl: null,
    sources: [
      {
        id: 'official',
        title: 'Museo sintetico: visite',
        url: 'https://museum.example/',
        kind: 'official',
      },
    ],
    warnings: ['Gli orari possono variare.'],
  };
}
