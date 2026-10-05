import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { useTrip } from '../client/context';
import { journal, type PendingTravel } from '../client/db';
import { discardTravel, request, resolvePending, type TripResult } from '../client/api';
import { applyTravel, preconditions } from '../domain/travel';
import type { Trip } from '../domain/schema';
import { Modal } from './Modal';
import { SchedulePreview } from './TravelEditor';
import { time } from '../domain/trip';
export function TravelSync() {
  const { trip, online, notify, edit, refresh } = useTrip();
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof journal>>>([]),
    [review, setReview] = useState<PendingTravel | null>(null),
    [shared, setShared] = useState<Trip | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const sub = liveQuery(() => journal(trip.id)).subscribe(setEntries);
    return () => sub.unsubscribe();
  }, [trip.id]);
  const load = async (item: PendingTravel) => {
    setReview(item);
    setShared(null);
    setError('');
    try {
      const result = await request<TripResult>(`/trips/${trip.id}`);
      setShared(result.trip);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Collegati per confrontare le versioni.');
    }
  };
  const conflict = entries.find((e) => e.value.conflict);
  if (!entries.length) return null;
  let preview: Trip | null = null,
    previewError = '';
  if (shared && review)
    try {
      preview = applyTravel(shared, {
        ...review.command,
        expected: preconditions(shared, review.command.action),
      });
    } catch (e) {
      previewError = e instanceof Error ? e.message : 'Rivedi la modifica.';
    }
  return (
    <aside className={`sync-panel ${conflict ? 'needs-review' : ''}`} aria-live="polite">
      <div>
        <strong>
          {conflict
            ? 'Modifiche da rivedere'
            : `${entries.length} ${entries.length === 1 ? 'modifica da sincronizzare' : 'modifiche da sincronizzare'}`}
        </strong>
        <p>
          {conflict
            ? 'La sincronizzazione del viaggio è in pausa. Le modifiche di questo telefono sono conservate.'
            : online
              ? 'Le modifiche sono salvate su questo telefono.'
              : 'Salvate su questo telefono. Verranno condivise quando torna la connessione.'}
        </p>
      </div>
      {conflict &&
        (conflict.type === 'travel' ? (
          <button className="button subtle" onClick={() => void load(conflict.value)}>
            Confronta le versioni
          </button>
        ) : (
          <div className="editor-shortcuts">
            <button
              className="button subtle"
              onClick={() =>
                void resolvePending(conflict.value.id, false)
                  .then(refresh)
                  .catch((e) => notify(e.message))
              }
            >
              Usa dato condiviso
            </button>
            <button
              className="button subtle"
              disabled={!online}
              onClick={() =>
                void resolvePending(conflict.value.id, true)
                  .then(refresh)
                  .catch((e) => notify(e.message))
              }
            >
              Conferma dato locale
            </button>
          </div>
        ))}
      {review && (
        <Modal title="Rivedi la modifica" onClose={() => setReview(null)}>
          <p>{review.error}</p>
          <h3>Su questo telefono</h3>
          <p>
            {review.command.action.type === 'note'
              ? review.command.action.text
              : 'Il programma locale include questa modifica e quelle successive.'}
          </p>
          {review.command.action.type !== 'note' &&
            review.preview.plan.days.map((d) => (
              <details key={d.id}>
                <summary>{d.title}</summary>
                <ol className="original-list">
                  {d.stepIds.map((id) => {
                    const s = review.preview.plan.steps.find((s) => s.id === id)!;
                    return (
                      <li key={id}>
                        {time(s.start, s.timezone ?? trip.plan.timezone)} · {s.title}
                      </li>
                    );
                  })}
                </ol>
              </details>
            ))}
          <h3>Programma condiviso</h3>
          {shared ? (
            review.command.action.type === 'note' ? (
              <p className="travel-note">
                {shared.travel?.notes[review.command.action.targetId] || 'Nessuna nota'}
              </p>
            ) : (
              shared.plan.days.map((d) => (
                <details key={d.id} open>
                  <summary>{d.title}</summary>
                  <ol className="original-list">
                    {d.stepIds.map((id) => {
                      const s = shared.plan.steps.find((s) => s.id === id)!;
                      return (
                        <li key={id}>
                          {time(s.start, s.timezone ?? shared.plan.timezone)} · {s.title}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              ))
            )
          ) : (
            <p>Collegati per leggere il programma condiviso.</p>
          )}
          {preview && shared && <SchedulePreview before={shared} after={preview} />}
          {(error || previewError) && (
            <p className="error-note" role="alert">
              {error || previewError}
            </p>
          )}
          <div className="editor-shortcuts">
            <button
              className="button subtle"
              onClick={() =>
                void discardTravel(review.id)
                  .then(() => {
                    setReview(null);
                    return refresh();
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Scarta questa modifica
            </button>
            <button
              className="button"
              disabled={!shared}
              onClick={() => {
                if (!shared) return;
                const a = review.command.action;
                const dayId =
                  'dayId' in a
                    ? a.dayId
                    : (shared.plan.days.find(
                        (d) =>
                          a.type === 'note' &&
                          (d.id === a.targetId || d.stepIds.includes(a.targetId)),
                      )?.id ?? shared.plan.days[0].id);
                setReview(null);
                edit({
                  dayId,
                  stepId:
                    'stepId' in a
                      ? a.stepId
                      : a.type === 'note' && shared.plan.steps.some((s) => s.id === a.targetId)
                        ? a.targetId
                        : undefined,
                  command: review.command,
                  shared,
                });
              }}
            >
              Rivedi e conferma
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
