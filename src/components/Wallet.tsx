import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Ticket as TicketIcon,
  Plus,
  ArrowRight,
  Trash2,
  Pencil,
  Upload,
  CalendarCheck,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import { useTrip, SectionHeading } from '../client/context';
import { request, uploadTicket, fetchTrip, type TripResult } from '../client/api';
import { db } from '../client/db';
import { time, dayLabel, money } from '../domain/trip';
import { inputToInstant, zonedInput } from '../domain/datetime';
import type { Ticket, Reservation } from '../domain/schema';
import { EuroEstimate } from './EuroEstimate';
import { Modal } from './Modal';

export function Wallet() {
  const { trip, online, refresh, notify } = useTrip();
  const [params, setParams] = useSearchParams();
  const [traveller, setTraveller] = useState('all'),
    [form, setForm] = useState<'ticket' | 'booking' | null>(params.has('add') ? 'ticket' : null),
    [editing, setEditing] = useState<Ticket | undefined>(),
    [savedIds, setSavedIds] = useState<string[]>([]);
  useEffect(() => {
    void db.files
      .where('tripId')
      .equals(trip.id)
      .toArray()
      .then((files) => setSavedIds(files.map((f) => f.id)));
  }, [trip.id, trip.revision]);
  const filtered = trip.state.tickets.filter(
    (t) => traveller === 'all' || t.travellerIds.includes(traveller),
  );
  const remove = async (ticket: Ticket) => {
    if (!confirm(`Eliminare “${ticket.title}”? Il file sarà rimosso anche dal viaggio condiviso.`))
      return;
    try {
      const latest = await fetchTrip(trip.id);
      await request(`/trips/${trip.id}/tickets/${ticket.id}`, 'DELETE', undefined, latest.etag);
      await db.files.delete(ticket.id);
      await refresh();
      notify('Biglietto rimosso.');
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <main className="page wallet-page">
      <SectionHeading eyebrow="TUTTO A PORTATA DI MANO" title="I vostri biglietti.">
        <p>Una visita, due persone. Ogni documento al posto giusto.</p>
      </SectionHeading>
      <div className="button-row">
        <button
          className="button"
          disabled={!online}
          onClick={() => {
            setEditing(undefined);
            setForm('ticket');
          }}
        >
          <Plus size={18} />
          Aggiungi biglietto
        </button>
        <button className="button subtle" disabled={!online} onClick={() => setForm('booking')}>
          <CalendarCheck size={18} />
          Prenotazione
        </button>
      </div>
      <div className="traveller-tabs" aria-label="Filtra per viaggiatore">
        <button
          className={traveller === 'all' ? 'selected' : ''}
          onClick={() => setTraveller('all')}
        >
          Tutti
        </button>
        {trip.plan.travellers.map((p) => (
          <button
            key={p.id}
            className={traveller === p.id ? 'selected' : ''}
            onClick={() => setTraveller(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="empty-wallet">
          <div className="wallet-illustration">
            <TicketIcon size={50} strokeWidth={1.2} />
            <span />
          </div>
          <h2>Il viaggio prende forma.</h2>
          <p>
            Quando prenotate, aggiungete qui i PDF o le immagini dei biglietti. Li ritroverete anche
            nella loro tappa.
          </p>
        </div>
      ) : (
        <div className="ticket-list">
          {filtered.map((ticket) => {
            const step = trip.plan.steps.find((s) => s.id === ticket.stepId)!;
            return (
              <article className="wallet-ticket" key={ticket.id}>
                <div className="ticket-decoration" />
                <div className="wallet-ticket-header">
                  <TicketIcon size={22} />
                  <span>
                    {ticket.travellerIds
                      .map((id) => trip.plan.travellers.find((p) => p.id === id)?.name)
                      .join(' · ')}
                  </span>
                  {savedIds.includes(ticket.id) && (
                    <span className="saved-chip">
                      <CheckCircle2 size={13} />
                      Offline
                    </span>
                  )}
                </div>
                <h2>{ticket.title}</h2>
                <p>{step.title}</p>
                <small>
                  {dayLabel(step.start.slice(0, 10))} ·{' '}
                  {time(step.start, step.timezone ?? trip.plan.timezone)}
                </small>
                <div className="wallet-ticket-footer">
                  {ticket.status === 'ready' ? (
                    <Link className="text-link" to={`/trips/${trip.id}/tickets/${ticket.id}`}>
                      Apri biglietto
                      <ArrowRight size={16} />
                    </Link>
                  ) : (
                    <button
                      className="text-link"
                      disabled={!online}
                      onClick={() => {
                        void request(`/trips/${trip.id}/tickets/${ticket.id}/finalize`, 'POST', {})
                          .then(refresh)
                          .catch((e) => notify(e.message));
                      }}
                    >
                      Upload incompleto · Verifica
                      <RefreshCw size={14} />
                    </button>
                  )}
                  <div>
                    <button
                      className="icon-button"
                      disabled={!online}
                      aria-label={`Modifica ${ticket.title}`}
                      onClick={() => {
                        setEditing(ticket);
                        setForm('ticket');
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      disabled={!online}
                      aria-label={`Elimina ${ticket.title}`}
                      onClick={() => {
                        void remove(ticket);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {trip.state.reservations.length > 0 && (
        <section className="detail-section">
          <h2>Prenotazioni</h2>
          {trip.state.reservations.map((r) => (
            <ReservationCard key={r.id} reservation={r} />
          ))}
        </section>
      )}
      {form && (
        <TicketForm
          mode={form}
          editing={editing}
          initialStep={params.get('add') ?? undefined}
          onClose={() => {
            setForm(null);
            setEditing(undefined);
            setParams({}, { replace: true });
          }}
        />
      )}
    </main>
  );
}
function ReservationCard({ reservation: r }: { reservation: Reservation }) {
  const { trip, refresh, notify, online } = useTrip();
  const [editing, setEditing] = useState(false);
  return (
    <div className="reservation-card">
      <div>
        <strong>{r.title}</strong>
        <span>
          {r.status === 'booked'
            ? 'Prenotato'
            : r.status === 'cancelled'
              ? 'Annullato'
              : 'Da prenotare'}
          {r.slot ? ` · ${time(r.slot, trip.plan.timezone)}` : ''}
        </span>
        {r.reference && <small>Riferimento: {r.reference}</small>}
        {r.paidAmount !== undefined && r.currency && (
          <small>
            Pagato: {money(r.paidAmount, r.currency)} per il gruppo
            <EuroEstimate min={r.paidAmount} currency={r.currency} />
          </small>
        )}
        {r.notes && <p>{r.notes}</p>}
      </div>
      <div className="reservation-actions">
        <button
          className="icon-button"
          disabled={!online}
          aria-label={`Modifica prenotazione ${r.title}`}
          onClick={() => setEditing(true)}
        >
          <Pencil size={16} />
        </button>
        <button
          className="icon-button danger"
          disabled={!online}
          aria-label={`Elimina prenotazione ${r.title}`}
          onClick={() => {
            if (
              !confirm(
                'Eliminare questa prenotazione? Prima riassegna o rimuovi eventuali biglietti collegati.',
              )
            )
              return;
            void fetchTrip(trip.id)
              .then((value) =>
                request(`/trips/${trip.id}/reservations/${r.id}`, 'DELETE', undefined, value.etag),
              )
              .then(refresh)
              .catch((e) => notify(e.message));
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {editing && <TicketForm mode="booking" reservation={r} onClose={() => setEditing(false)} />}
    </div>
  );
}
function TicketForm({
  mode,
  editing,
  initialStep,
  reservation,
  onClose,
}: {
  mode: 'ticket' | 'booking';
  editing?: Ticket;
  reservation?: Reservation;
  initialStep?: string;
  onClose: () => void;
}) {
  const { trip, refresh, notify } = useTrip();
  const [title, setTitle] = useState(editing?.title ?? reservation?.title ?? ''),
    [stepId, setStep] = useState(
      editing?.stepId ?? reservation?.stepId ?? initialStep ?? trip.plan.steps[0].id,
    ),
    [travellers, setTravellers] = useState(
      editing?.travellerIds ?? reservation?.travellerIds ?? trip.plan.travellers.map((p) => p.id),
    );
  const [file, setFile] = useState<File | null>(null),
    [reference, setReference] = useState(reservation?.reference ?? ''),
    [slot, setSlot] = useState(
      reservation?.slot ? zonedInput(reservation.slot, trip.plan.timezone) : '',
    ),
    [amount, setAmount] = useState(reservation?.paidAmount?.toString() ?? ''),
    [currency, setCurrency] = useState(
      reservation?.currency ?? trip.plan.costs[0]?.currency ?? 'EUR',
    ),
    [notes, setNotes] = useState(reservation?.notes ?? ''),
    [status, setStatus] = useState<Reservation['status']>(reservation?.status ?? 'booked'),
    [reservationId, setReservationId] = useState(editing?.reservationId ?? '');
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!travellers.length) {
      setError('Seleziona almeno un viaggiatore.');
      return;
    }
    if (
      editing &&
      file &&
      !confirm('Sostituire il file? Il vecchio biglietto sarà rimosso dopo il nuovo upload.')
    )
      return;
    setBusy(true);
    setError('');
    try {
      let latest: TripResult = await fetchTrip(trip.id);
      if (mode === 'booking') {
        const selected = trip.plan.steps.find((s) => s.id === stepId)!;
        const data = {
          id: reservation?.id ?? `reservation-${crypto.randomUUID()}`,
          stepId,
          title: title || selected.title,
          travellerIds: travellers,
          status,
          reference,
          ...(slot
            ? { slot: inputToInstant(slot, selected.timezone ?? trip.plan.timezone) }
            : reservation
              ? { slot: null }
              : {}),
          ...(amount !== ''
            ? { paidAmount: Number(amount), currency }
            : reservation
              ? { paidAmount: null, currency: null }
              : {}),
          notes,
        };
        await request(
          `/trips/${trip.id}/reservations${reservation ? '/' + reservation.id : ''}`,
          reservation ? 'PATCH' : 'POST',
          reservation
            ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'id'))
            : data,
          latest.etag,
        );
      } else {
        const data = {
          title: title || file?.name || 'Biglietto',
          stepId,
          travellerIds: travellers,
          ...(reservationId ? { reservationId } : editing && !file ? { reservationId: null } : {}),
        };
        if (editing && !file)
          await request(`/trips/${trip.id}/tickets/${editing.id}`, 'PATCH', data, latest.etag);
        else {
          if (!file) throw new Error('Scegli il file del biglietto.');
          latest = await uploadTicket(
            latest.trip,
            latest.etag,
            file,
            { ...data, reservationId: reservationId || undefined },
            setProgress,
          );
          if (editing) {
            await request(
              `/trips/${trip.id}/tickets/${editing.id}`,
              'DELETE',
              undefined,
              latest.etag,
            );
            await db.files.delete(editing.id);
          }
        }
      }
      await refresh();
      notify(
        mode === 'booking'
          ? 'Prenotazione salvata.'
          : 'Biglietto salvato. Aggiorna la copia offline per portarlo con te.',
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        mode === 'booking'
          ? reservation
            ? 'Modifica prenotazione'
            : 'Nuova prenotazione'
          : editing
            ? 'Modifica biglietto'
            : 'Un biglietto in più'
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="entry-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label>
          Titolo
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              mode === 'booking' ? 'Es. Ingresso al museo' : 'Es. Biglietti per il Wawel'
            }
            maxLength={200}
          />
        </label>
        <label>
          Tappa
          <select
            value={stepId}
            onChange={(e) => {
              setStep(e.target.value);
              setReservationId('');
            }}
          >
            {trip.plan.days.map((day) => (
              <optgroup key={day.id} label={dayLabel(day.date)}>
                {day.stepIds.map((id) => {
                  const step = trip.plan.steps.find((s) => s.id === id)!;
                  return (
                    <option key={id} value={id}>
                      {time(step.start, trip.plan.timezone)} · {step.title}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Per chi?</legend>
          <div className="traveller-checkboxes">
            {trip.plan.travellers.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={travellers.includes(p.id)}
                  onChange={(e) =>
                    setTravellers(
                      e.target.checked
                        ? [...travellers, p.id]
                        : travellers.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
        {mode === 'ticket' ? (
          <>
            <label className="file-picker">
              <Upload size={23} />
              <span>
                {file?.name ??
                  (editing ? 'Sostituisci il file (facoltativo)' : 'Scegli un PDF o un’immagine')}
              </span>
              <small>PDF, JPG o PNG · massimo 10 MB</small>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                required={!editing}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {trip.state.reservations.some((r) => r.stepId === stepId) && (
              <label>
                Prenotazione collegata
                <select value={reservationId} onChange={(e) => setReservationId(e.target.value)}>
                  <option value="">Nessuna</option>
                  {trip.state.reservations
                    .filter((r) => r.stepId === stepId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </>
        ) : (
          <>
            <label>
              Stato
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Reservation['status'])}
              >
                <option value="booked">Prenotato</option>
                <option value="not-booked">Da prenotare</option>
                <option value="cancelled">Annullato</option>
              </select>
            </label>
            <label>
              Riferimento prenotazione
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
            <label>
              Data e ora effettive <small>Ora locale del viaggio</small>
              <input type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)} />
            </label>
            <div className="form-columns">
              <label>
                Totale pagato per il gruppo
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label>
                Valuta
                <input
                  value={currency}
                  maxLength={3}
                  pattern="[A-Z]{3}"
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </label>
            </div>
            <label>
              Note
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </label>
          </>
        )}
        {busy && mode === 'ticket' && <progress max={100} value={progress} />}
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
        <button className="button full" disabled={busy} type="submit">
          {busy ? 'Salvataggio…' : 'Salva'}
        </button>
      </form>
    </Modal>
  );
}
