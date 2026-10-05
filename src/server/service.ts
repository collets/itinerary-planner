import { randomUUID } from 'node:crypto';
import { TripSchema, emptyState, type Trip, type Plan } from '../domain/schema.js';
import { ApiError, type Storage } from './storage.js';
import { applyTravel, fixedStart, TravelError, type TravelCommand } from '../domain/travel.js';

export class TripService {
  constructor(public store: Storage) {}
  private path(id: string) {
    return `trips/${id}/current.json`;
  }
  async read(id: string) {
    const item = await this.store.read(this.path(id));
    if (!item) throw new ApiError(404, 'Trip not found');
    return {
      trip: TripSchema.parse(JSON.parse(new TextDecoder().decode(item.body))),
      etag: item.etag,
    };
  }
  async list() {
    const paths = (await this.store.list('trips/')).filter((p) => p.endsWith('/current.json'));
    return Promise.all(
      paths.map(async (p) => {
        const { trip } = await this.read(p.split('/')[1]);
        return {
          id: trip.id,
          title: trip.plan.title,
          subtitle: trip.plan.subtitle,
          destinations: trip.plan.destinations,
          startDate: trip.plan.startDate,
          endDate: trip.plan.endDate,
          travellers: trip.plan.travellers.length,
        };
      }),
    );
  }
  async create(id: string, plan: Plan) {
    const trip = TripSchema.parse({
      schemaVersion: '1',
      id,
      revision: 1,
      updatedAt: new Date().toISOString(),
      plan,
      state: emptyState(),
    });
    const etag = await this.store.write(this.path(id), this.encode(trip), 'create');
    return { trip, etag };
  }
  private encode(trip: Trip) {
    return new TextEncoder().encode(JSON.stringify(trip));
  }
  async mutate(
    id: string,
    expected: string | undefined,
    change: (trip: Trip) => void,
    snapshot = false,
  ) {
    if (!expected) throw new ApiError(428, 'X-Trip-Version is required');
    const { trip, etag } = await this.read(id);
    if (expected !== etag)
      throw new ApiError(412, 'The document changed. Pull again before editing.');
    const before = structuredClone(trip);
    change(trip);
    if (before.travel) {
      if (JSON.stringify(before.travel.originalPlan) !== JSON.stringify(trip.travel?.originalPlan))
        throw new ApiError(409, 'The original plan is immutable after travel editing begins');
      for (const previous of before.plan.steps) {
        const next = trip.plan.steps.find((s) => s.id === previous.id);
        if (!next)
          throw new ApiError(
            409,
            'Keep archived steps; remove them from the active sequence instead',
          );
        if (
          before.state.progress[previous.id] === 'done' &&
          (next.start !== previous.start || next.end !== previous.end)
        )
          throw new ApiError(409, 'Completed activity times are protected');
        const fixed = next.start !== previous.start ? fixedStart(before, previous) : undefined;
        if (fixed && next.start !== previous.start && Date.parse(next.start) !== Date.parse(fixed))
          throw new ApiError(409, 'Booked and fixed times are protected');
      }
    }
    trip.revision++;
    trip.updatedAt = new Date().toISOString();
    // Deleting an unattached step/task clears its obsolete progress; attachments are validated.
    for (const key of Object.keys(trip.state.progress))
      if (!trip.plan.steps.some((s) => s.id === key)) delete trip.state.progress[key];
    for (const key of Object.keys(trip.state.taskCompletion))
      if (!trip.plan.tasks.some((t) => t.id === key)) delete trip.state.taskCompletion[key];
    const valid = TripSchema.parse(trip);
    if (snapshot) {
      try {
        await this.store.write(
          `history/${id}/${String(before.revision).padStart(10, '0')}.json`,
          this.encode(before),
          'create',
        );
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 412)) throw e;
      }
    }
    const nextEtag = await this.store.write(this.path(id), this.encode(valid), etag);
    if (snapshot) {
      const history = await this.store.list(`history/${id}/`);
      await Promise.all(
        history.slice(0, Math.max(0, history.length - 20)).map((path) => this.store.remove(path)),
      );
    }
    return { trip: valid, etag: nextEtag };
  }
  async travel(id: string, command: TravelCommand, expected?: string, preview = false) {
    const current = await this.read(id);
    if (current.trip.travel?.appliedIds.includes(command.id)) return current;
    if (!preview && !expected) throw new ApiError(428, 'X-Trip-Version is required');
    if (!preview && current.etag !== expected) throw new ApiError(412, 'The document changed');
    let draft: Trip;
    try {
      draft = applyTravel(current.trip, command);
    } catch (error) {
      if (error instanceof TravelError)
        throw new ApiError(error.code === 'conflict' ? 409 : 422, error.message);
      throw error;
    }
    if (preview) return { trip: draft, etag: current.etag };
    return this.mutate(id, current.etag, (value) => Object.assign(value, draft), true);
  }
  async delete(id: string, expected: string | undefined) {
    if (!expected) throw new ApiError(428, 'X-Trip-Version is required');
    const { trip, etag } = await this.read(id);
    if (etag !== expected) throw new ApiError(412, 'The document changed');
    // Remove the document first, so no new uploads can be authorized.
    await this.store.remove(this.path(id), expected);
    await Promise.all(
      [
        ...trip.state.tickets.map((t) => t.pathname),
        ...(await this.store.list(`history/${id}/`)),
      ].map((p) => this.store.remove(p)),
    );
  }
  async finalize(id: string, ticketId: string) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { trip, etag } = await this.read(id);
      const t = trip.state.tickets.find((t) => t.id === ticketId);
      if (!t) throw new ApiError(404, 'Ticket not found');
      if (t.status === 'ready') return { trip, etag };
      const file = await this.store.read(t.pathname);
      if (!file || file.body.byteLength !== t.size)
        throw new ApiError(400, 'File missing or size mismatch');
      const bytes = file.body;
      const correct =
        t.contentType === 'application/pdf'
          ? new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-'
          : t.contentType === 'image/png'
            ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!correct) {
        await this.store.remove(t.pathname);
        throw new ApiError(400, 'File contents do not match the selected type');
      }
      try {
        return await this.mutate(id, etag, (draft) => {
          draft.state.tickets.find((t) => t.id === ticketId)!.status = 'ready';
        });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 412) || attempt === 3) throw e;
      }
    }
    throw new ApiError(409, 'Upload finalization conflict');
  }
  newId(prefix: string) {
    return `${prefix}-${randomUUID()}`;
  }
}
