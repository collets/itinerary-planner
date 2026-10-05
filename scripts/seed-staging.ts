import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { BlobStorage, ApiError } from '../src/server/storage.js';
import { TripService } from '../src/server/service.js';
import { Id, PlanSchema } from '../src/domain/schema.js';
import { exampleTrip } from '../src/domain/fixture.js';

// A temporary encrypted preview variable carries private seed data; none enters Git or dist.
// OIDC supplies credentials during Vercel builds. Never seed the production store.
if (process.env.APP_ENVIRONMENT === 'staging' && process.env.STAGING_SEED) {
  if (
    !process.env.STAGING_SEED_STORE_ID ||
    process.env.BLOB_STORE_ID?.replace(/^store_/, '') !==
      process.env.STAGING_SEED_STORE_ID.replace(/^store_/, '')
  )
    throw new Error('Staging seed requires the explicitly selected isolated Blob store.');
  const input = JSON.parse(gunzipSync(Buffer.from(process.env.STAGING_SEED, 'base64')).toString());
  const personal = { id: Id.parse(input.id), plan: PlanSchema.parse(input.plan) };
  const demo = exampleTrip();
  demo.id = 'staging-editing-demo';
  demo.plan.title = 'Laboratorio di viaggio';
  demo.plan.subtitle = 'Solo esempi: prenotazione e biglietti dimostrativi';
  demo.plan.endDate = '2026-11-13';
  demo.plan.days.push({
    id: 'day-two',
    date: '2026-11-13',
    title: 'Una giornata flessibile',
    summary: 'Prova a spostare qui una visita.',
    stepIds: ['coffee'],
  });
  demo.plan.steps.push({
    ...demo.plan.steps[0],
    id: 'coffee',
    title: 'Pausa caffè',
    start: '2026-11-13T09:00:00+01:00',
    end: '2026-11-13T09:30:00+01:00',
  });
  const service = new TripService(new BlobStorage());
  for (const trip of [personal, demo]) {
    try {
      await service.read(trip.id);
      console.log(`Staging seed: kept existing ${trip.id}`);
      continue;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    let value = await service.create(trip.id, trip.plan);
    if (trip.id === demo.id) {
      value = await service.mutate(trip.id, value.etag, (draft) => {
        draft.state.reservations.push({
          id: 'sample-booking',
          title: 'ESEMPIO · Museo prenotato',
          stepId: 'museum',
          travellerIds: ['traveller-one', 'traveller-two'],
          status: 'booked',
          slot: demo.plan.steps.find((s) => s.id === 'museum')!.start,
          reference: 'SOLO-TEST',
          notes: 'Prenotazione dimostrativa, nessun ingresso reale.',
          paidAmount: 30,
          currency: 'EUR',
        });
      });
      const bytes = new Uint8Array(await readFile('public/icon-192.png'));
      for (const traveller of ['traveller-one', 'traveller-two']) {
        const id = service.newId('ticket'),
          pathname = `tickets/${trip.id}/${id}/sample-ticket.png`;
        value = await service.mutate(trip.id, value.etag, (draft) =>
          draft.state.tickets.push({
            id,
            pathname,
            title: `ESEMPIO · Biglietto ${traveller === 'traveller-one' ? 'Io' : 'Compagno'}`,
            stepId: 'museum',
            travellerIds: [traveller],
            filename: 'sample-ticket.png',
            size: bytes.length,
            contentType: 'image/png',
            status: 'pending',
            uploadedAt: new Date().toISOString(),
            reservationId: 'sample-booking',
          }),
        );
        await service.store.write(pathname, bytes, 'create', 'image/png');
        value = await service.finalize(trip.id, id);
      }
    }
    console.log(`Staging seed: created ${trip.id}`);
  }
}
