import { applyTravel, preconditions, type TravelCommand } from '../domain/travel';
import { upload, uploadPresigned } from '@vercel/blob/client';
import { TripSchema, type Trip, type Ticket } from '../domain/schema';
import { db, clearPrivateData, overlay, journal, type Pending } from './db';

export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type TripResult = { trip: Trip; etag: string; offline?: boolean };
export type TripSummary = {
  id: string;
  title: string;
  subtitle: string;
  destinations: string[];
  startDate: string;
  endDate: string;
  travellers: number;
};
export async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  etag?: string,
): Promise<T> {
  const response = await fetch('/api/v2' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(etag ? { 'X-Trip-Version': etag } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/session') {
      await clearPrivateData();
      window.dispatchEvent(new Event('passo:logged-out'));
    }
    const localized: Record<number, string> = {
      400: 'Controlla i dati o il file e riprova.',
      403: 'Operazione non consentita. Per modificare il programma usa l’agente.',
      404: 'Questo elemento non è più disponibile.',
      409: 'Il dato è cambiato su un altro dispositivo. Aggiorna e riprova.',
      412: 'Il viaggio è stato aggiornato. Ricarica e riprova.',
      413: 'Il file è troppo grande.',
      422: 'Controlla i dati inseriti e i collegamenti alla tappa.',
      426: 'Aggiorna l’app per usare il programma adattato.',
      428: 'Aggiorna il viaggio prima di salvare.',
      429: 'Troppe richieste. Attendi un minuto e riprova.',
    };
    throw new RequestError(
      response.status,
      (path.includes('/travel/') || path.includes('/ai/')
        ? data.error
        : localized[response.status]) ??
        data.error ??
        'Impossibile completare la richiesta',
    );
  }
  return response.json();
}
export async function fetchTrip(id: string): Promise<TripResult> {
  const result = await request<TripResult>(`/trips/${id}`);
  result.trip = TripSchema.parse(result.trip);
  const previous = await db.trips.get(id);
  await db.trips.put({
    id,
    trip: result.trip,
    etag: result.etag,
    savedAt: Date.now(),
    downloaded: previous?.downloaded ?? false,
    ticketIds: previous?.ticketIds ?? [],
  });
  // Deleted/replaced tickets must not survive in the offline wallet.
  const readyIds = new Set(
    result.trip.state.tickets.filter((t) => t.status === 'ready').map((t) => t.id),
  );
  for (const file of await db.files.where('tripId').equals(id).toArray())
    if (!readyIds.has(file.id)) await db.files.delete(file.id);
  return { ...result, trip: await overlay(result.trip) };
}
export async function loadTrip(id: string): Promise<TripResult> {
  try {
    return await fetchTrip(id);
  } catch (error) {
    if (error instanceof RequestError && [401, 403, 404].includes(error.status)) throw error;
    const saved = await db.trips.get(id);
    if (!saved || (!saved.downloaded && !(await journal(id)).length)) throw error;
    return { trip: await overlay(saved.trip), etag: saved.etag, offline: true };
  }
}
export async function loadTrips(): Promise<TripSummary[]> {
  try {
    return await request<TripSummary[]>('/trips');
  } catch (error) {
    if (error instanceof RequestError && [401, 403].includes(error.status)) throw error;
    const localIds = new Set((await journal()).map((e) => e.value.tripId));
    return (await db.trips.filter((t) => t.downloaded || localIds.has(t.id)).toArray()).map(
      ({ id, trip }) => ({
        id,
        title: trip.plan.title,
        subtitle: trip.plan.subtitle,
        destinations: trip.plan.destinations,
        startDate: trip.plan.startDate,
        endDate: trip.plan.endDate,
        travellers: trip.plan.travellers.length,
      }),
    );
  }
}
export async function queueChange(item: Omit<Pending, 'id' | 'conflict'>) {
  if (item.value === item.expected) return;
  await db.pending.put({
    ...item,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    conflict: false,
  });
}
export async function queueTravel(trip: Trip, command: TravelCommand) {
  const preview = applyTravel(trip, command);
  await db.travelCommands.put({
    id: command.id,
    tripId: trip.id,
    command,
    preview,
    createdAt: Date.now(),
    conflict: false,
  });
  return preview;
}
let syncing: Promise<void> | undefined;
export function syncPending(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const blocked = new Set<string>();
    for (const entry of await journal()) {
      const item = entry.value;
      if (blocked.has(item.tripId)) continue;
      if (item.conflict) {
        blocked.add(item.tripId);
        continue;
      }
      try {
        let result = await request<TripResult>(`/trips/${item.tripId}`);
        if (entry.type === 'travel') {
          const local = entry.value;
          if (!result.trip.travel?.appliedIds.includes(local.id)) {
            applyTravel(result.trip, local.command);
            result = await request<TripResult>(
              `/trips/${item.tripId}/travel/apply`,
              'POST',
              local.command,
              result.etag,
            );
          }
          await db.transaction('rw', db.trips, db.travelCommands, async () => {
            const cache = await db.trips.get(item.tripId);
            if (cache)
              await db.trips.put({
                ...cache,
                trip: result.trip,
                etag: result.etag,
                savedAt: Date.now(),
              });
            await db.travelCommands.delete(item.id);
          });
        } else {
          const state = entry.value;
          const exists =
            state.kind === 'progress'
              ? result.trip.plan.steps.some((s) => s.id === state.itemId)
              : result.trip.plan.tasks.some((t) => t.id === state.itemId);
          const actual =
            state.kind === 'progress'
              ? (result.trip.state.progress[state.itemId] ?? 'pending')
              : (result.trip.state.taskCompletion[state.itemId] ?? false);
          if (!exists || (actual !== state.expected && actual !== state.value))
            throw new RequestError(409, 'Il dato è cambiato su un altro dispositivo.');
          if (actual !== state.value)
            result = await request<TripResult>(
              `/trips/${state.tripId}/${state.kind === 'progress' ? 'progress' : 'tasks'}/${state.itemId}`,
              'PATCH',
              state.kind === 'progress'
                ? {
                    status: state.value,
                    expected: actual,
                    at: new Date(state.createdAt ?? Date.now()).toISOString(),
                  }
                : { done: state.value, expected: actual },
              result.etag,
            );
          await db.transaction('rw', db.trips, db.pending, async () => {
            const cache = await db.trips.get(item.tripId);
            if (cache)
              await db.trips.put({
                ...cache,
                trip: result.trip,
                etag: result.etag,
                savedAt: Date.now(),
              });
            await db.pending.delete(item.id);
          });
        }
      } catch (error) {
        if (error instanceof RequestError && error.status === 412) {
          blocked.add(item.tripId);
          continue;
        }
        if (
          (error instanceof Error && error.name === 'TravelError') ||
          (error instanceof RequestError && [404, 409, 422, 403, 426].includes(error.status))
        ) {
          if (entry.type === 'travel')
            await db.travelCommands.update(item.id, {
              conflict: true,
              error: error instanceof Error ? error.message : 'Rivedi la modifica.',
            });
          else await db.pending.update(item.id, { conflict: true });
          blocked.add(item.tripId);
          continue;
        }
        break;
      }
    }
    window.dispatchEvent(new Event('passo:synced'));
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}
export async function discardTravel(id: string) {
  const item = await db.travelCommands.get(id);
  if (!item) return;
  // Later commands depend on the local result. Preserve them for explicit review.
  await db.travelCommands.delete(id);
  for (const next of await journal(item.tripId)) {
    if ((next.value.createdAt ?? 0) < item.createdAt) continue;
    if (next.type === 'travel')
      await db.travelCommands.update(next.value.id, {
        conflict: true,
        error: 'Una modifica precedente è stata scartata. Rivedi questa anteprima.',
      });
    else await db.pending.update(next.value.id, { conflict: true });
  }
  window.dispatchEvent(new Event('passo:synced'));
}
export async function reviseTravel(id: string, shared: Trip) {
  const item = await db.travelCommands.get(id);
  if (!item) return;
  const command = { ...item.command, expected: preconditions(shared, item.command.action) };
  const preview = applyTravel(shared, command);
  await db.travelCommands.update(id, { command, preview, conflict: false, error: undefined });
  await syncPending();
}
export async function resolvePending(id: string, keepLocal: boolean) {
  const item = await db.pending.get(id);
  if (!item) return;
  if (!keepLocal) await db.pending.delete(id);
  else {
    const result = await request<TripResult>(`/trips/${item.tripId}`);
    const exists =
      item.kind === 'progress'
        ? result.trip.plan.steps.some((s) => s.id === item.itemId)
        : result.trip.plan.tasks.some((t) => t.id === item.itemId);
    if (!exists) throw new Error('La tappa è stata rimossa: scegli l’aggiornamento condiviso.');
    const expected =
      item.kind === 'progress'
        ? (result.trip.state.progress[item.itemId] ?? 'pending')
        : (result.trip.state.taskCompletion[item.itemId] ?? false);
    await db.pending.update(id, { expected, conflict: false });
  }
  await syncPending();
}
export async function ticketFile(tripId: string, ticket: Ticket): Promise<Blob> {
  try {
    const response = await fetch(`/api/v1/trips/${tripId}/tickets/${ticket.id}/file`, {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new RequestError(response.status, 'Biglietto non disponibile');
    return await response.blob();
  } catch (error) {
    if (error instanceof RequestError && [401, 403, 404].includes(error.status)) throw error;
    const saved = await db.files.get(ticket.id);
    if (!saved) throw new Error('Questo biglietto non è salvato offline.');
    return saved.file instanceof Blob
      ? saved.file
      : new Blob([saved.file], { type: saved.contentType ?? ticket.contentType });
  }
}
export async function saveOffline(
  id: string,
  ticketIds: string[],
  progress: (done: number, total: number) => void,
) {
  const result = await fetchTrip(id);
  const cached = await db.trips.get(id);
  if (!cached) throw new Error('Viaggio non disponibile');
  await db.trips.update(id, { downloaded: false });
  let done = 0;
  progress(done, ticketIds.length + 1);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // Confirm the complete application cache before promising an offline download.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error('L’app non è ancora pronta offline. Attendi la connessione e riprova.'),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  await navigator.storage?.persist?.();
  for (const ticketId of ticketIds) {
    const ticket = result.trip.state.tickets.find((t) => t.id === ticketId && t.status === 'ready');
    if (!ticket) throw new Error('Un biglietto non è pronto.');
    const response = await fetch(`/api/v1/trips/${id}/tickets/${ticketId}/file`);
    if (!response.ok) throw new Error('Download del biglietto non riuscito.');
    const file = await response.blob();
    if (file.size !== ticket.size) throw new Error('Download incompleto. Riprova.');
    await db.files.put({
      id: ticketId,
      tripId: id,
      file: await file.arrayBuffer(),
      contentType: ticket.contentType,
      filename: ticket.filename,
    });
    progress(++done, ticketIds.length + 1);
  }
  for (const file of await db.files.where('tripId').equals(id).toArray())
    if (!ticketIds.includes(file.id)) await db.files.delete(file.id);
  await db.trips.update(id, { downloaded: true, savedAt: Date.now(), ticketIds });
  progress(++done, ticketIds.length + 1);
}
async function withUploadDeadline(transfer: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The SDK retries network errors with backoff, including CSP failures. Bound
    // the UI wait as well as aborting the transfer, even during a retry delay.
    await Promise.race([
      transfer(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              'Caricamento interrotto dopo 3 minuti. Controlla la connessione e riprova. Se il file risulta incompleto, usa Verifica prima di caricarlo di nuovo.',
            ),
          );
          controller.abort();
        }, 180000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadTicket(
  trip: Trip,
  etag: string,
  file: File,
  data: { title: string; stepId: string; travellerIds: string[]; reservationId?: string },
  progress: (value: number) => void,
) {
  if (
    !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type) ||
    file.size > 10 * 1024 * 1024 ||
    file.size < 1
  )
    throw new Error('Scegli un PDF, JPG o PNG fino a 10 MB.');
  const created = await request<TripResult>(
    `/trips/${trip.id}/tickets`,
    'POST',
    { ...data, filename: file.name, contentType: file.type, size: file.size },
    etag,
  );
  const ticket = created.trip.state.tickets.at(-1)!;
  const config = await request<{ storage: string; presignedUploads?: boolean }>('/config');
  progress(10);
  await withUploadDeadline(async (signal) => {
    if (config.storage === 'blob') {
      await (config.presignedUploads ? uploadPresigned : upload)(ticket.pathname, file, {
        access: 'private',
        contentType: file.type,
        handleUploadUrl: '/api/v1/uploads/blob',
        clientPayload: JSON.stringify({ tripId: trip.id, ticketId: ticket.id }),
        abortSignal: signal,
        onUploadProgress: (e) => {
          if (!signal.aborted) progress(e.percentage);
        },
      });
    } else {
      const response = await fetch(`/api/v1/trips/${trip.id}/tickets/${ticket.id}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
        signal,
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error ?? 'Upload non riuscito');
      }
    }
  });
  if (config.storage === 'blob')
    await request(`/trips/${trip.id}/tickets/${ticket.id}/finalize`, 'POST', {});
  progress(100);
  return fetchTrip(trip.id);
}
