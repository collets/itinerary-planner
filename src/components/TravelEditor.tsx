import { useMemo, useState } from 'react';
import { useTrip } from '../client/context';
import type { Trip } from '../domain/schema';
import {
  applyTravel,
  fixedStart,
  preconditions,
  routeNeeds,
  type TravelAction,
  type TravelCommand,
  type RouteInput,
} from '../domain/travel';
import { inputToInstant, zonedInput } from '../domain/datetime';
import { time } from '../domain/trip';
import { Modal } from './Modal';

export type EditTarget = {
  dayId: string;
  stepId?: string;
  mode?: string;
  command?: TravelCommand;
  shared?: Trip;
};
export function SchedulePreview({ before, after }: { before: Trip; after: Trip }) {
  return (
    <div className="schedule-preview">
      <h3>Anteprima del programma</h3>
      {after.plan.days
        .filter(
          (d) =>
            JSON.stringify(d.stepIds) !==
              JSON.stringify(before.plan.days.find((v) => v.id === d.id)?.stepIds) ||
            d.stepIds.some((id) => {
              const a = after.plan.steps.find((s) => s.id === id)!,
                b = before.plan.steps.find((s) => s.id === id);
              return a.start !== b?.start || a.end !== b?.end;
            }),
        )
        .map((d) => (
          <section key={d.id}>
            <strong>{d.title}</strong>
            <ol>
              {d.stepIds.map((id) => {
                const a = after.plan.steps.find((s) => s.id === id)!,
                  b = before.plan.steps.find((s) => s.id === id),
                  zone = a.timezone ?? after.plan.timezone;
                return (
                  <li key={id}>
                    <span>
                      {b && b.start !== a.start ? <del>{time(b.start, zone)} </del> : null}
                      <b>
                        {time(a.start, zone)}–{time(a.end, zone)}
                      </b>
                    </span>
                    <span>
                      {a.title}
                      {a.kind === 'leg' && a.estimate ? ' · provvisorio' : ''}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      <p className="small muted">
        Prenotazioni, pagamenti e biglietti restano associati alle tappe.
      </p>
    </div>
  );
}
export function TravelEditor({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const { trip: live, saveTravel, notify } = useTrip(),
    trip = target.shared ?? live;
  const initial = target.command?.action,
    step = trip.plan.steps.find((s) => s.id === target.stepId),
    day = trip.plan.days.find((d) => d.id === target.dayId) ?? trip.plan.days[0];
  let anchor: string | undefined;
  try {
    if (step) anchor = fixedStart(trip, step);
  } catch {
    anchor = step?.start;
  }
  const editable = step && trip.state.progress[step.id] !== 'done' && day.stepIds.includes(step.id);
  const defaultMode = !step
    ? 'add'
    : !editable
      ? 'note'
      : step.kind === 'leg' && step.mode === 'flight'
        ? 'note'
        : anchor
          ? 'timing'
          : 'delay';
  const [mode, setMode] = useState(
    target.mode ??
      (initial?.type === 'timing' && initial.leaveAt
        ? 'leave'
        : initial?.type === 'undo'
          ? 'history'
          : initial?.type) ??
      defaultMode,
  );
  const [id] = useState(target.command?.id ?? crypto.randomUUID());
  const [newId] = useState(`stop-${crypto.randomUUID()}`),
    [placeId] = useState(`place-${crypto.randomUUID()}`);
  const [minutes, setMinutes] = useState(initial?.type === 'delay' ? initial.minutes : 15);
  const [start, setStart] = useState(
    zonedInput(
      initial?.type === 'timing' && initial.start
        ? initial.start
        : initial?.type === 'add'
          ? initial.stop.start
          : (anchor ?? step?.start ?? inputToInstant(`${day.date}T09:00`, trip.plan.timezone)),
      step?.timezone ?? trip.plan.timezone,
    ),
  );
  const [duration, setDuration] = useState(
    initial?.type === 'timing' && initial.durationMinutes
      ? initial.durationMinutes
      : initial?.type === 'add'
        ? Math.round((Date.parse(initial.stop.end) - Date.parse(initial.stop.start)) / 60000)
        : step
          ? Math.round((Date.parse(step.end) - Date.parse(step.start)) / 60000)
          : 30,
  );
  const [following, setFollowing] = useState(initial?.type === 'timing' ? initial.following : true);
  const [toDay, setToDay] = useState(initial?.type === 'move' ? initial.toDayId : day.id);
  const [afterId, setAfterId] = useState(
    initial && 'afterId' in initial
      ? (initial.afterId ?? '')
      : ((step && day.stepIds.includes(step.id) ? step.id : day.stepIds.at(-1)) ?? ''),
  );
  const [title, setTitle] = useState(initial?.type === 'add' ? initial.stop.title : ''),
    [address, setAddress] = useState(initial?.type === 'add' ? (initial.place?.address ?? '') : '');
  const [text, setText] = useState(
    initial?.type === 'note' ? initial.text : (trip.travel?.notes[step?.id ?? day.id] ?? ''),
  );
  const [acknowledged, setAcknowledged] = useState(false),
    [confirmedRoutes, setConfirmedRoutes] = useState<Record<string, RouteInput>>({});
  const [preview, setPreview] = useState<{ command: TravelCommand; trip: Trip } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const active = step && trip.plan.days.some((d) => d.stepIds.includes(step.id));
  const done = step && trip.state.progress[step.id] === 'done';
  let fixed: string | undefined;
  try {
    if (step) fixed = fixedStart(trip, step);
  } catch {
    fixed = step?.start;
  }
  const action = useMemo<TravelAction | null>(() => {
    try {
      const common = { dayId: day.id, stepId: step?.id ?? '' };
      if (mode === 'note') return { type: 'note', targetId: step?.id ?? day.id, text };
      if (mode === 'restore') return { type: 'restore', dayId: day.id };
      if (mode === 'delay') return { type: 'delay', ...common, minutes };
      if (mode === 'timing')
        return {
          type: 'timing',
          ...common,
          start: inputToInstant(start, step?.timezone ?? trip.plan.timezone),
          durationMinutes: duration,
          following,
        };
      if (mode === 'leave')
        return {
          type: 'timing',
          ...common,
          leaveAt:
            initial?.type === 'timing' && initial.leaveAt
              ? initial.leaveAt
              : new Date().toISOString(),
          following: true,
        };
      if (mode === 'skip')
        return {
          type: 'skip',
          ...common,
          included: !active,
          afterId: !active && afterId ? afterId : undefined,
          acknowledgedBooking: acknowledged,
        };
      if (mode === 'lock') return { type: 'lock', ...common, fixed: !trip.travel?.locks[step!.id] };
      if (mode === 'move')
        return {
          type: 'move',
          ...common,
          toDayId: toDay,
          afterId: afterId && afterId !== step?.id ? afterId : undefined,
        };
      if (mode === 'add') {
        if (!title.trim() || !address.trim()) return null;
        const instant = inputToInstant(start, trip.plan.timezone);
        return {
          type: 'add',
          dayId: day.id,
          afterId: afterId || undefined,
          place: {
            id: placeId,
            name: title.trim(),
            address: address.trim(),
            description: 'Luogo aggiunto durante il viaggio.',
            details: '',
            trivia: '',
            entrance: '',
            openingHours: 'unknown',
            sourceIds: [],
          },
          stop: {
            id: newId,
            kind: 'stop',
            title: title.trim(),
            category: 'free-time',
            placeId,
            start: instant,
            end: new Date(Date.parse(instant) + duration * 60000).toISOString(),
            summary: 'Una tappa aggiunta durante il viaggio.',
            details: '',
            optional: true,
            sourceIds: [],
            sourceActivityIds: [],
            notes: [],
          },
        };
      }
      return null;
    } catch {
      return null;
    }
  }, [
    mode,
    day.id,
    step,
    trip,
    minutes,
    start,
    duration,
    following,
    active,
    afterId,
    acknowledged,
    toDay,
    title,
    address,
    placeId,
    newId,
    text,
    initial,
  ]);
  const needs = useMemo(() => (action ? routeNeeds(trip, action) : []), [trip, action]);
  const reset = () => {
    setPreview(null);
    setError('');
  };
  const build = (selected: TravelAction) => {
    const routes = needs
      .map((r) => confirmedRoutes[`${r.fromPlaceId}:${r.toPlaceId}`])
      .filter(Boolean);
    if (routes.length !== needs.length)
      throw new Error('Conferma mezzo e minuti per ogni nuovo collegamento.');
    if (selected.type === 'timing' && selected.leaveAt && !target.command)
      selected = { ...selected, leaveAt: new Date().toISOString() };
    const command: TravelCommand = {
      id,
      action: selected,
      routes,
      expected: preconditions(trip, selected),
      at: new Date().toISOString(),
    };
    setPreview({ command, trip: applyTravel(trip, command) });
    setError('');
  };
  const previewAction = () => {
    try {
      if (!action) throw new Error('Completa i campi della modifica.');
      build(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Controlla la modifica.');
      setPreview(null);
    }
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await saveTravel(preview.command, trip, Boolean(target.command));
      onClose();
      notify('Modifica salvata.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Salvataggio non riuscito.');
    } finally {
      setBusy(false);
    }
  };
  const options = step
    ? [
        ...(!done && active && !fixed
          ? [
              ['delay', 'Siamo in ritardo'],
              ['timing', 'Orario e durata'],
              ['leave', 'Partiamo adesso'],
            ]
          : []),
        ...(!done && active && fixed && !(step.kind === 'leg' && step.mode === 'flight')
          ? [
              ['timing', 'Durata della visita'],
              ['leave', 'Partiamo adesso'],
            ]
          : []),
        ...(!done && step.kind === 'stop'
          ? [
              ['skip', active ? 'Salta questa tappa' : 'Reinserisci la tappa'],
              ...(active && !fixed ? [['move', 'Cambia ordine o giorno']] : []),
            ]
          : []),
        ...(!done &&
        active &&
        !trip.state.reservations.some(
          (r) => r.stepId === step.id && r.status === 'booked' && r.slot,
        ) &&
        !(step.kind === 'leg' && step.mode === 'flight')
          ? [['lock', trip.travel?.locks[step.id] ? 'Rendi flessibile' : 'Fissa questo orario']]
          : []),
        ['note', 'Nota condivisa'],
        ['original', 'Programma originale'],
        ['history', 'Cronologia'],
      ]
    : [
        ['add', 'Aggiungi una tappa'],
        ['note', 'Nota della giornata'],
        ['restore', 'Ripristina la giornata'],
        ['original', 'Programma originale'],
        ['history', 'Cronologia'],
      ];
  return (
    <Modal title={step ? `Adatta · ${step.title}` : `Adatta · ${day.title}`} onClose={onClose}>
      <div className="travel-editor">
        <label>
          Cosa vuoi cambiare?
          <select
            aria-label="Tipo di modifica"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              reset();
            }}
          >
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {fixed && (
          <p className="warning-note">
            Orario fisso: {time(fixed, step?.timezone ?? trip.plan.timezone)}. Le altre tappe devono
            rispettarlo.
          </p>
        )}
        {mode === 'delay' && (
          <>
            <div className="editor-shortcuts">
              {[15, 30, 60].map((n) => (
                <button
                  key={n}
                  className={minutes === n ? 'button' : 'button subtle'}
                  onClick={() => {
                    setMinutes(n);
                    reset();
                  }}
                >
                  +{n} min
                </button>
              ))}
            </div>
            <label>
              Ritardo in minuti
              <input
                type="number"
                min="1"
                max="1440"
                value={minutes}
                onChange={(e) => {
                  setMinutes(Number(e.target.value));
                  reset();
                }}
              />
            </label>
          </>
        )}
        {(mode === 'timing' || mode === 'add') && (
          <>
            <label>
              Inizio (ora del viaggio)
              <input
                type="datetime-local"
                disabled={mode === 'timing' && Boolean(fixed)}
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  reset();
                }}
              />
            </label>
            <label>
              Durata in minuti
              <input
                type="number"
                min="1"
                max="1440"
                value={duration}
                onChange={(e) => {
                  setDuration(Number(e.target.value));
                  reset();
                }}
              />
            </label>
            {mode === 'timing' && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={following}
                  onChange={(e) => {
                    setFollowing(e.target.checked);
                    reset();
                  }}
                />
                Adatta anche le attività successive
              </label>
            )}
          </>
        )}
        {mode === 'leave' && (
          <p>
            Chiudi questa attività all’ora attuale e adatta il seguito. Le tappe con orario fisso
            restano protette.
          </p>
        )}
        {mode === 'note' && (
          <label>
            Nota condivisa
            <textarea
              maxLength={4000}
              value={text}
              rows={5}
              onChange={(e) => {
                setText(e.target.value);
                reset();
              }}
            />
          </label>
        )}
        {mode === 'add' && (
          <>
            <label>
              Nome della tappa
              <input
                maxLength={150}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  reset();
                }}
              />
            </label>
            <label>
              Indirizzo e città
              <input
                maxLength={300}
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  reset();
                }}
              />
            </label>
            <p className="small muted">
              Costo da verificare. Questa tappa non cambia la stima originale.
            </p>
          </>
        )}
        {mode === 'move' && toDay === day.id && step && (
          <div className="editor-shortcuts">
            {[-1, 1].map((delta) => {
              const stops = day.stepIds
                  .map((id) => trip.plan.steps.find((s) => s.id === id)!)
                  .filter((s) => s.kind === 'stop'),
                index = stops.findIndex((s) => s.id === step.id),
                next = index + delta;
              return (
                <button
                  key={delta}
                  className="button subtle"
                  disabled={next < 0 || next >= stops.length}
                  onClick={() => {
                    const ordered = stops.filter((s) => s.id !== step.id);
                    setAfterId(next > 0 ? ordered[next - 1].id : '');
                    reset();
                  }}
                >
                  {delta < 0 ? 'Sposta prima' : 'Sposta dopo'}
                </button>
              );
            })}
          </div>
        )}
        {mode === 'move' && (
          <label>
            Giornata
            <select
              value={toDay}
              onChange={(e) => {
                setToDay(e.target.value);
                setAfterId('');
                reset();
              }}
            >
              {trip.plan.days.map((d) => (
                <option value={d.id} key={d.id}>
                  {d.date} · {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {(mode === 'move' || mode === 'add' || (mode === 'skip' && !active)) && (
          <label>
            Posizione
            <select
              aria-label="Posizione della tappa"
              value={afterId === step?.id && mode !== 'add' ? '' : afterId}
              onChange={(e) => {
                setAfterId(e.target.value);
                reset();
              }}
            >
              <option value="">All’inizio della giornata</option>
              {trip.plan.days
                .find((d) => d.id === (mode === 'move' ? toDay : day.id))!
                .stepIds.map((id) => trip.plan.steps.find((s) => s.id === id)!)
                .filter((s) => s.kind === 'stop' && (s.id !== step?.id || mode === 'add'))
                .map((s) => (
                  <option value={s.id} key={s.id}>
                    Dopo {s.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {mode === 'skip' && (
          <>
            <p>
              La tappa resta nel diario, con i suoi biglietti. Saltare una visita non cancella
              prenotazioni e non implica un rimborso.
            </p>
            {trip.state.reservations.some(
              (r) => r.stepId === step?.id && r.status === 'booked',
            ) && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => {
                    setAcknowledged(e.target.checked);
                    reset();
                  }}
                />
                Ho verificato la prenotazione e so che resta attiva.
              </label>
            )}
          </>
        )}
        {mode === 'restore' && (
          <p>
            Ripristina le attività originali ancora da fare. Visite completate, note, pagamenti,
            prenotazioni e biglietti vengono conservati. Gli orari fissi possono richiedere altri
            aggiustamenti.
          </p>
        )}
        {needs.map((route) => {
          const key = `${route.fromPlaceId}:${route.toPlaceId}`,
            value = confirmedRoutes[key] ?? route;
          return (
            <fieldset className="route-estimate" key={key}>
              <legend>
                {(action?.type === 'add' && action.place?.id === route.fromPlaceId
                  ? action.place.name
                  : trip.plan.places.find((p) => p.id === route.fromPlaceId)?.name) ??
                  route.fromPlaceId}{' '}
                →{' '}
                {(action?.type === 'add' && action.place?.id === route.toPlaceId
                  ? action.place.name
                  : trip.plan.places.find((p) => p.id === route.toPlaceId)?.name) ??
                  route.toPlaceId}
              </legend>
              <p className="small">
                Nuovo collegamento: scegli una stima provvisoria. Nessuna strada o punto di
                interesse viene inventato.
              </p>
              <label>
                Mezzo
                <select
                  value={value.mode}
                  onChange={(e) => {
                    setConfirmedRoutes({
                      ...confirmedRoutes,
                      [key]: { ...value, mode: e.target.value as RouteInput['mode'] },
                    });
                    reset();
                  }}
                >
                  {[
                    ['walk', 'A piedi'],
                    ['transit', 'Mezzi pubblici'],
                    ['taxi', 'Taxi'],
                    ['train', 'Treno'],
                  ].map(([id, label]) => (
                    <option value={id} key={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Minuti indicativi
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={value.durationMinutes}
                  onChange={(e) => {
                    setConfirmedRoutes({
                      ...confirmedRoutes,
                      [key]: { ...value, durationMinutes: Number(e.target.value) },
                    });
                    reset();
                  }}
                />
              </label>
              <button
                className="button subtle"
                onClick={() => {
                  setConfirmedRoutes({ ...confirmedRoutes, [key]: value });
                  reset();
                }}
              >
                {confirmedRoutes[key] ? 'Stima confermata' : 'Conferma questa stima'}
              </button>
            </fieldset>
          );
        })}
        {mode === 'original' && (
          <>
            {(trip.travel?.originalPlan ?? trip.plan).days.map((d) => (
              <section key={d.id}>
                <h3>
                  {d.date} · {d.title}
                </h3>
                <ol className="original-list">
                  {d.stepIds.map((id) => {
                    const s = (trip.travel?.originalPlan ?? trip.plan).steps.find(
                      (s) => s.id === id,
                    )!;
                    return (
                      <li key={id}>
                        {time(s.start, s.timezone ?? trip.plan.timezone)} · {s.title}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </>
        )}
        {mode === 'history' && (
          <>
            <p>
              Ultime 20 modifiche. Puoi annullare una modifica quando le attività coinvolte non sono
              cambiate nel frattempo.
            </p>
            {[...(trip.travel?.history ?? [])].reverse().map((h) => (
              <div className="history-row" key={h.id}>
                <span>
                  {h.title}
                  <small>{new Date(h.at).toLocaleString('it-IT')}</small>
                </span>
                <button
                  className="button subtle"
                  onClick={() => {
                    try {
                      build({ type: 'undo', historyId: h.id });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Modifica non annullabile.');
                    }
                  }}
                >
                  Anteprima annullamento
                </button>
              </div>
            ))}
          </>
        )}
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <>
            <SchedulePreview before={trip} after={preview.trip} />
            {preview.command.action.type === 'note' && (
              <p className="travel-note">
                {preview.command.action.text || 'La nota verrà rimossa.'}
              </p>
            )}
            <button className="button full" disabled={busy} onClick={() => void save()}>
              {busy ? 'Salvataggio…' : 'Conferma modifica'}
            </button>
          </>
        )}
        {!['original', 'history'].includes(mode) && (
          <button className="button subtle full" onClick={previewAction}>
            Mostra anteprima
          </button>
        )}
      </div>
    </Modal>
  );
}
