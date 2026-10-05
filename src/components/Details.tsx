import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  MapPin,
  ExternalLink,
  Footprints,
  TrainFront,
  Camera,
  Check,
  SkipForward,
  Ticket,
  BookOpen,
  Lightbulb,
  Phone,
} from 'lucide-react';
import { useTrip, ErrorPanel } from '../client/context';
import {
  orderedSteps,
  time,
  dayLabel,
  money,
  navigationUrl,
  navigationSegments,
} from '../domain/trip';
import type { Step } from '../domain/schema';
import { archivedSteps } from '../domain/travel';
import { ViewSwitch } from './Overview';
import { EuroEstimate } from './EuroEstimate';

export function SourceList({ ids }: { ids: string[] }) {
  const { trip } = useTrip();
  const sources = trip.plan.sources.filter((s) => new Set(ids).has(s.id));
  if (!sources.length) return null;
  return (
    <section className="detail-section sources">
      <h2>
        <BookOpen size={19} />
        Fonti e approfondimenti
      </h2>
      <p className="muted small">
        Le informazioni possono cambiare: controlla la fonte prima di prenotare.
      </p>
      {sources.map((s) => (
        <div key={s.id} className="source-item">
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.title}
              <ExternalLink size={13} />
            </a>
          ) : (
            <strong>{s.title}</strong>
          )}
          <p>{s.description}</p>
          <small>
            {s.verifiedOn
              ? `Riferimento del ${new Date(s.verifiedOn + 'T12:00:00Z').toLocaleDateString('it-IT')}`
              : 'Data da verificare'}
            {s.status === 'verified_secondary' ? ' · Fonte editoriale' : ''}
          </small>
        </div>
      ))}
    </section>
  );
}
export function Details() {
  const { trip, changeProgress, notify, edit, editing } = useTrip();
  const { stepId } = useParams();
  const navigate = useNavigate();
  const steps = orderedSteps(trip.plan),
    index = steps.findIndex((s) => s.id === stepId),
    step = trip.plan.steps.find((s) => s.id === stepId);
  const touch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    sessionStorage.setItem(`passo:last-step:${trip.id}`, stepId ?? '');
  }, [stepId, trip.id]);
  if (!step) return <ErrorPanel message="Questa tappa non è più nel programma." />;
  const day =
    trip.plan.days.find((d) => d.stepIds.includes(step.id)) ??
    trip.plan.days.find((d) => archivedSteps(trip, d.id).some((s) => s.id === step.id)) ??
    trip.plan.days[0];
  const archived = index < 0;
  const zone = step.timezone ?? trip.plan.timezone;
  const move = (delta: number) => {
    if (archived) return;
    const next = steps[index + delta];
    if (next) navigate(`/trips/${trip.id}/steps/${next.id}`, { replace: true });
  };
  const place = step.kind === 'stop' ? trip.plan.places.find((p) => p.id === step.placeId)! : null;
  const costs = trip.plan.costs.filter(
    (c) => c.stepIds.includes(step.id) && c.inclusion !== 'excluded',
  );
  const status = trip.state.progress[step.id] ?? 'pending';
  const reservations = trip.state.reservations.filter((r) => r.stepId === step.id);
  const booked = reservations.find((r) => r.status === 'booked');
  const tickets = trip.state.tickets.filter((t) => t.stepId === step.id && t.status === 'ready');
  return (
    <main className="page detail-page">
      <ViewSwitch stepId={step.id} active="detail" />
      <div className="detail-position">
        <span>{dayLabel(day.date)}</span>
        <span>{archived ? 'Fuori programma' : `${index + 1} / ${steps.length}`}</span>
      </div>
      <article
        className="focus-content"
        onTouchStart={(e) => {
          if (!(e.target as HTMLElement).closest('[data-no-swipe]'))
            touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchEnd={(e) => {
          if (!touch.current) return;
          const dx = e.changedTouches[0].clientX - touch.current.x,
            dy = e.changedTouches[0].clientY - touch.current.y;
          touch.current = null;
          if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.8) move(dx < 0 ? 1 : -1);
        }}
      >
        <header className={`focus-card ${step.kind === 'leg' ? 'route-focus' : ''}`}>
          <div className="focus-top">
            <span className="time-pill">
              <Clock size={15} />
              {time(booked?.slot ?? step.start, zone)} – {time(step.end, zone)}
            </span>
            {step.optional && <span className="optional-label">Facoltativa</span>}
          </div>
          <div className="focus-symbol">
            {step.kind === 'leg' ? (
              step.mode === 'walk' ? (
                <Footprints size={31} />
              ) : (
                <TrainFront size={31} />
              )
            ) : step.category === 'meal' ? (
              '☕'
            ) : (
              <MapPin size={31} />
            )}
          </div>
          <h1>{step.title}</h1>
          <p className="focus-summary">{step.summary}</p>
          <div className="focus-facts">
            <span>
              <Clock size={15} />
              {step.kind === 'leg'
                ? `Circa ${step.durationMinutes} min`
                : `${Math.round((Date.parse(step.end) - Date.parse(step.start)) / 60000)} min`}
            </span>
            {costs.map((c) => (
              <span className="price-fact" key={c.id}>
                <span>
                  {c.min === null || c.max === null
                    ? 'Costo da verificare'
                    : `${money(c.min, c.currency)}${c.max !== c.min ? ' – ' + money(c.max, c.currency) : ''}`}
                  {c.basis === 'person' ? ' / persona' : ''}
                </span>
                <EuroEstimate min={c.min} max={c.max} currency={c.currency} />
              </span>
            ))}
          </div>
        </header>
        <div className="detail-action-row">
          {Array.from({ length: navigationSegments(step) }, (_, i) => (
            <a
              className="button"
              key={i}
              href={navigationUrl(step, trip.plan, i)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MapPin size={17} />
              {navigationSegments(step) > 1 ? `Percorso ${i + 1}` : 'Apri Maps'}
              <ExternalLink size={14} />
            </a>
          ))}
          {place?.bookingUrl && (
            <a
              className="button subtle"
              href={place.bookingUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Ticket size={17} />
              {booked ? 'Sito prenotazione' : 'Prenota'}
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        {editing && (
          <button
            className="button subtle full adapt-button"
            onClick={() =>
              edit({
                dayId: day.id,
                stepId: step.id,
                mode: archived && step.kind === 'stop' ? 'skip' : undefined,
              })
            }
          >
            {archived ? 'Reinserisci o annota' : 'Adatta questa tappa'}
          </button>
        )}
        {trip.travel?.notes[step.id] && <p className="travel-note">{trip.travel.notes[step.id]}</p>}
        {!costs.length &&
          trip.travel &&
          !trip.travel.originalPlan.steps.some((s) => s.id === step.id) &&
          step.kind === 'stop' && (
            <p className="small muted">Costo da verificare · non incluso nella stima originale.</p>
          )}
        {!archived && (
          <div className="progress-controls" aria-label="Stato della tappa">
            <button
              className={status === 'done' ? 'active' : ''}
              onClick={() => {
                void changeProgress(step.id, status === 'done' ? 'pending' : 'done').catch((e) =>
                  notify(e.message),
                );
              }}
            >
              <Check size={16} />
              {step.kind === 'leg' ? 'Percorso completato' : 'Visitata'}
            </button>
            {step.kind === 'stop' && editing && status !== 'done' && (
              <button onClick={() => edit({ dayId: day.id, stepId: step.id, mode: 'skip' })}>
                <SkipForward size={16} />
                Salta tappa
              </button>
            )}
          </div>
        )}
        {place ? (
          <>
            <section className="detail-section">
              <h2>Da sapere</h2>
              <div className="prose">
                <Markdown>{place.details}</Markdown>
                <Markdown>{step.details}</Markdown>
              </div>
            </section>
            {place.trivia && (
              <section className="trivia-box">
                <Lightbulb size={22} />
                <div>
                  <h2>Uno sguardo in più</h2>
                  <div className="prose">
                    <Markdown>{place.trivia}</Markdown>
                  </div>
                </div>
              </section>
            )}
            <section className="detail-section practical">
              <h2>Informazioni pratiche</h2>
              <dl>
                <div>
                  <dt>Indirizzo</dt>
                  <dd>{place.address}</dd>
                </div>
                {place.localName && (
                  <div>
                    <dt>Nome locale</dt>
                    <dd>{place.localName}</dd>
                  </div>
                )}
                {place.openingHours && (
                  <div>
                    <dt>Orari indicati</dt>
                    <dd>
                      {place.openingHours === 'unknown' ? 'Da confermare' : place.openingHours}
                    </dd>
                  </div>
                )}
                {place.entrance && (
                  <div>
                    <dt>Ingresso e vincoli</dt>
                    <dd>{place.entrance}</dd>
                  </div>
                )}
              </dl>
              {place.phone && (
                <a className="text-link" href={`tel:${place.phone.replace(/[^+\d]/g, '')}`}>
                  <Phone size={15} />
                  {place.phone}
                </a>
              )}
              {place.website && (
                <a
                  className="text-link"
                  href={place.website}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Sito ufficiale
                  <ExternalLink size={14} />
                </a>
              )}
            </section>
          </>
        ) : step.kind === 'leg' ? (
          <LegDetails step={step} />
        ) : null}
        {(tickets.length > 0 || reservations.length > 0) && (
          <section className="detail-section">
            <h2>
              <Ticket size={20} />
              Prenotazioni e biglietti
            </h2>
            {reservations.map((r) => (
              <div className="reservation-mini" key={r.id}>
                <strong>{r.title}</strong>
                <span>
                  {r.status === 'booked'
                    ? 'Prenotato'
                    : r.status === 'cancelled'
                      ? 'Annullato'
                      : 'Da prenotare'}
                  {r.slot ? ` · ${time(r.slot, zone)}` : ''}
                </span>
                {r.reference && <small>Riferimento: {r.reference}</small>}
                {r.slot && +new Date(r.slot) !== +new Date(step.start) && (
                  <p className="warning-note">
                    Lo slot è diverso dal programma. Chiedi all’agente di aggiornare l’itinerario.
                  </p>
                )}
              </div>
            ))}
            {tickets.map((t) => (
              <Link className="ticket-link" key={t.id} to={`/trips/${trip.id}/tickets/${t.id}`}>
                <Ticket size={19} />
                <span>
                  {t.title}
                  <small>
                    {t.travellerIds
                      .map((id) => trip.plan.travellers.find((p) => p.id === id)?.name)
                      .join(' · ')}
                  </small>
                </span>
                <ArrowRight size={18} />
              </Link>
            ))}
          </section>
        )}
        <Link className="text-link add-ticket-link" to={`/trips/${trip.id}/tickets?add=${step.id}`}>
          Aggiungi una prenotazione o un biglietto <ArrowRight size={15} />
        </Link>
        {step.notes.length > 0 && (
          <aside className="warning-note">
            {step.notes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </aside>
        )}
        <SourceList
          ids={[
            ...step.sourceIds,
            ...(place?.sourceIds ?? []),
            ...(step.kind === 'leg'
              ? step.pois.flatMap(
                  (poi) => trip.plan.places.find((p) => p.id === poi.placeId)?.sourceIds ?? [],
                )
              : []),
          ]}
        />
      </article>
      {!archived && (
        <nav className="step-navigation" aria-label="Scorri le tappe">
          <button onClick={() => move(-1)} disabled={index === 0} aria-label="Tappa precedente">
            <ArrowLeft size={18} />
            <span>Precedente</span>
          </button>
          <span className="step-counter">
            {archived ? 'Fuori programma' : `${index + 1} / ${steps.length}`}
          </span>
          <button
            onClick={() => move(1)}
            disabled={index === steps.length - 1}
            aria-label="Tappa successiva"
          >
            <span>Successiva</span>
            <ArrowRight size={18} />
          </button>
        </nav>
      )}
    </main>
  );
}
function LegDetails({ step }: { step: Extract<Step, { kind: 'leg' }> }) {
  const { trip } = useTrip();
  return (
    <>
      <section className="detail-section">
        <h2>La strada da seguire</h2>
        <div className="prose">
          <Markdown>{step.details}</Markdown>
        </div>
        <ol className="street-list">
          {step.streets.map((street, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              {street}
            </li>
          ))}
        </ol>
        <p className="muted small">
          Tempi indicativi. Il percorso suggerito può differire dal più rapido proposto da Maps.
        </p>
      </section>
      {step.pois.length > 0 && (
        <section className="detail-section">
          <h2>
            <Camera size={20} />
            Lungo la strada
          </h2>
          <p className="muted">Piccole soste che fanno parte del viaggio.</p>
          {step.pois.map((poi) => {
            const place = trip.plan.places.find((p) => p.id === poi.placeId)!;
            return (
              <details className="poi-card" key={poi.placeId}>
                <summary>
                  <div>
                    <span className="category-label">
                      {poi.detourMinutes
                        ? `Deviazione · +${poi.detourMinutes} min`
                        : 'Sul percorso'}
                    </span>
                    <h3>{place.name}</h3>
                    <p>{poi.note}</p>
                  </div>
                  <ArrowRight size={17} />
                </summary>
                <div className="poi-body prose">
                  <Markdown>{place.details}</Markdown>
                  {place.trivia && <Markdown>{place.trivia}</Markdown>}
                  <a
                    href={`https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: `${place.localName ?? place.name}, ${place.address}` })}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Vedi su Maps <ExternalLink size={14} />
                  </a>
                </div>
              </details>
            );
          })}
        </section>
      )}
    </>
  );
}
