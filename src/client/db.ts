import Dexie, { type EntityTable } from 'dexie';
import { applyTravel, type TravelCommand } from '../domain/travel';
import type { Trip, Progress } from '../domain/schema';

export type CachedTrip = {
  id: string;
  trip: Trip;
  etag: string;
  downloaded: boolean;
  savedAt: number;
  ticketIds: string[];
};
export type CachedFile = {
  id: string;
  tripId: string;
  file: Blob | ArrayBuffer;
  filename: string;
  contentType?: string;
};
export type Pending = {
  id: string;
  tripId: string;
  itemId: string;
  kind: 'progress' | 'task';
  value: Progress | boolean;
  expected: Progress | boolean;
  conflict: boolean;
  createdAt?: number;
};
export type PendingTravel = {
  id: string;
  tripId: string;
  command: TravelCommand;
  preview: Trip;
  createdAt: number;
  conflict: boolean;
  error?: string;
};
export const db = new Dexie('passo-private-data') as Dexie & {
  trips: EntityTable<CachedTrip, 'id'>;
  files: EntityTable<CachedFile, 'id'>;
  pending: EntityTable<Pending, 'id'>;
  travelCommands: EntityTable<PendingTravel, 'id'>;
  meta: EntityTable<{ id: string; value: unknown }, 'id'>;
};
db.version(1).stores({ trips: '&id', files: '&id, tripId', pending: '&id, tripId', meta: '&id' });
db.version(2).stores({
  trips: '&id',
  files: '&id, tripId',
  pending: '&id, tripId',
  travelCommands: '&id, tripId',
  meta: '&id',
});
export async function forgetTrip(id: string) {
  await db.transaction(
    'rw',
    db.trips,
    db.files,
    db.pending,
    db.travelCommands,
    db.meta,
    async () => {
      const pending =
        (await db.pending.where('tripId').equals(id).count()) +
        (await db.travelCommands.where('tripId').equals(id).count());
      if (pending) await db.trips.update(id, { downloaded: false, ticketIds: [] });
      else await db.trips.delete(id);
      await db.files.where('tripId').equals(id).delete();
      await db.meta.where('id').startsWith(`ai:${id}:`).delete();
    },
  );
}
export async function clearPrivateData() {
  await db.transaction(
    'rw',
    db.trips,
    db.files,
    db.pending,
    db.travelCommands,
    db.meta,
    async () => {
      await db.trips.clear();
      await db.files.clear();
      await db.pending.clear();
      await db.travelCommands.clear();
      await db.meta.clear();
    },
  );
}
/** Bounded advice cache; a late response after logout cannot recreate private data. */
export async function saveAiAdvice<T extends { savedAt: number }>(id: string, value: T) {
  await db.transaction('rw', db.meta, async () => {
    if (!(await db.meta.get('session'))) return;
    await db.meta.put({ id, value });
    const advice = await db.meta.where('id').startsWith('ai:').toArray();
    advice.sort(
      (a, b) => (a.value as { savedAt: number }).savedAt - (b.value as { savedAt: number }).savedAt,
    );
    await db.meta.bulkDelete(
      advice.slice(0, Math.max(0, advice.length - 10)).map((item) => item.id),
    );
  });
}
export async function journal(tripId?: string) {
  const pending = tripId
    ? await db.pending.where('tripId').equals(tripId).toArray()
    : await db.pending.toArray();
  const travel = tripId
    ? await db.travelCommands.where('tripId').equals(tripId).toArray()
    : await db.travelCommands.toArray();
  return [
    ...pending.map((value) => ({ type: 'state' as const, value })),
    ...travel.map((value) => ({ type: 'travel' as const, value })),
  ].sort((a, b) => (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0));
}
export async function overlay(trip: Trip): Promise<Trip> {
  let draft = structuredClone(trip);
  for (const entry of await journal(trip.id)) {
    if (entry.type === 'travel') {
      const local = entry.value;
      if (draft.travel?.appliedIds.includes(local.id)) continue;
      try {
        draft = applyTravel(draft, local.command);
      } catch {
        draft = structuredClone(local.preview);
      }
    } else {
      const state = entry.value;
      if (state.kind === 'progress' && draft.plan.steps.some((s) => s.id === state.itemId))
        draft.state.progress[state.itemId] = state.value as Progress;
      if (state.kind === 'progress' && draft.travel) {
        if (state.value === 'done')
          draft.travel.completedAt[state.itemId] = new Date(
            state.createdAt ?? Date.now(),
          ).toISOString();
        else delete draft.travel.completedAt[state.itemId];
      }
      if (state.kind === 'task' && draft.plan.tasks.some((t) => t.id === state.itemId))
        draft.state.taskCompletion[state.itemId] = state.value as boolean;
    }
  }
  return draft;
}
