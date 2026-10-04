import Dexie, { type EntityTable } from 'dexie';
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
};
export const db = new Dexie('passo-private-data') as Dexie & {
  trips: EntityTable<CachedTrip, 'id'>;
  files: EntityTable<CachedFile, 'id'>;
  pending: EntityTable<Pending, 'id'>;
  meta: EntityTable<{ id: string; value: unknown }, 'id'>;
};
db.version(1).stores({ trips: '&id', files: '&id, tripId', pending: '&id, tripId', meta: '&id' });
export async function forgetTrip(id: string) {
  await db.transaction('rw', db.trips, db.files, db.pending, async () => {
    await db.trips.delete(id);
    await db.files.where('tripId').equals(id).delete();
    await db.pending.where('tripId').equals(id).delete();
  });
}
export async function clearPrivateData() {
  await db.transaction('rw', db.trips, db.files, db.pending, db.meta, async () => {
    await db.trips.clear();
    await db.files.clear();
    await db.pending.clear();
    await db.meta.clear();
  });
}
export async function overlay(trip: Trip): Promise<Trip> {
  const draft = structuredClone(trip);
  for (const item of await db.pending.where('tripId').equals(trip.id).toArray()) {
    if (item.kind === 'progress' && draft.plan.steps.some((s) => s.id === item.itemId))
      draft.state.progress[item.itemId] = item.value as Progress;
    if (item.kind === 'task' && draft.plan.tasks.some((t) => t.id === item.itemId))
      draft.state.taskCompletion[item.itemId] = item.value as boolean;
  }
  return draft;
}
