import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  ArrowRight,
  Footprints,
  TrainFront,
  Camera,
  Check,
  Ticket,
  Compass,
  Layers,
  CalendarDays,
  Users,
  ChevronRight,
} from 'lucide-react';
import { useTrip } from '../client/context';
import { archivedSteps, activeIds, fixedStart } from '../domain/travel';
import { currentStep, dayLabel, time } from '../domain/trip';
import type { Step } from '../domain/schema';

export function ViewSwitch({ stepId, active }: { stepId?: string; active: 'overview' | 'detail' }) {
  const { trip } = useTrip();
  const base = `/trips/${trip.id}`;
  return (
    <div className="view-switch" aria-label="Vista itinerario">
      <Link className={active === 'overview' ? 'selected' : ''} to={base}>
        <Layers size={15} />
        Vista completa
      </Link>
      {stepId && (
        <Link className={active === 'detail' ? 'selected' : ''} to={`${base}/steps/${stepId}`}>
          <Compass size={15} />
          Una tappa
        </Link>
      )}
    </div>
  );
}
export function Overview() {
  const { trip, edit, editing } = useTrip();
  const navigate = useNavigate();
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const [activeDay, setActiveDay] = useState(trip.plan.days[0].id);
  const current = currentStep(trip);
  const scrollKey = `passo:overview:${trip.id}`;
  useEffect(() => {
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) requestAnimationFrame(() => window.scrollTo(0, Number(saved)));
    else {
      const now = new Date();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: trip.plan.timezone }).format(now);
      const day = trip.plan.days.find((d) => d.date === today);
      if (day) requestAnimationFrame(() => sections.current[day.id]?.scrollIntoView());
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActiveDay(visible[0].target.id);
      },
      { rootMargin: '-160px 0px -50% 0px' },
    );
    Object.values(sections.current).forEach((e) => {
      if (e) observer.observe(e);
    });
    const save = () => sessionStorage.setItem(scrollKey, String(window.scrollY));
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', save);
    };
  }, [scrollKey, trip.id, trip.plan.timezone, trip.plan.days]);
  return (
    <main className="page overview">
      <header className="trip-hero">
        <p className="eyebrow">
          <span className="tiny-dot" /> IL VOSTRO PROSSIMO CAPITOLO
        </p>
        <h1>
          {trip.plan.title}
          <span className="hero-dot">.</span>
        </h1>
        <p className="hero-subtitle">{trip.plan.subtitle}</p>
        <div className="trip-meta">
          <span>
            <CalendarDays size={16} />
            {new Date(trip.plan.startDate + 'T12:00:00Z').toLocaleDateString('it-IT', {
              day: 'numeric',
              month: 'long',
              timeZone: 'UTC',
            })}{' '}
            –{' '}
            {new Date(trip.plan.endDate + 'T12:00:00Z').toLocaleDateString('it-IT', {
              day: 'numeric',
              month: 'long',
              timeZone: 'UTC',
            })}
          </span>
          <span>
            <Users size={16} />
            {trip.plan.travellers.length} viaggiatori
          </span>
        </div>
        <div className="hero-route" aria-hidden="true">
          <span />
          <i />
          <span />
          <i />
          <span />
          <Footprints size={22} />
        </div>
      </header>
      <div className="overview-controls">
        <ViewSwitch
          stepId={
            trip.plan.steps.find(
              (s) =>
                s.id === sessionStorage.getItem(`passo:last-step:${trip.id}`) &&
                activeIds(trip).has(s.id),
            )?.id ?? current?.id
          }
          active="overview"
        />
        <button
          className="now-link"
          disabled={!current}
          onClick={() => current && navigate(`/trips/${trip.id}/steps/${current.id}`)}
        >
          Adesso <ArrowUpRight size={16} />
        </button>
      </div>
      <nav className="day-nav" aria-label="Giorni del viaggio">
        {trip.plan.days.map((d, i) => (
          <button
            key={d.id}
            className={activeDay === d.id ? 'active' : ''}
            onClick={() => {
              setActiveDay(d.id);
              sections.current[d.id]?.scrollIntoView({ behavior: 'smooth' });
            }}
          >
            <span>Giorno {i + 1}</span>
            <strong>
              {new Date(d.date + 'T12:00:00Z').toLocaleDateString('it-IT', {
                weekday: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </strong>
          </button>
        ))}
      </nav>
      {trip.plan.days.map((day, i) => (
        <section
          key={day.id}
          id={day.id}
          ref={(e) => {
            sections.current[day.id] = e;
          }}
          className="day-section"
        >
          <div className="day-heading">
            <span className="day-number">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <p className="eyebrow">{dayLabel(day.date)}</p>
              <h2>{day.title}</h2>
              <p>{day.summary}</p>
            </div>
          </div>
          {editing && (
            <div className="day-edit-row">
              <button
                className="button subtle adapt-button"
                onClick={() => edit({ dayId: day.id })}
              >
                Adatta la giornata
              </button>
            </div>
          )}
          {trip.travel?.notes[day.id] && <p className="travel-note">{trip.travel.notes[day.id]}</p>}
          {!day.stepIds.length && (
            <p className="empty-day">
              Giornata libera. Aggiungi una tappa o riprendi una visita dal diario.
            </p>
          )}
          <div className="timeline">
            {day.stepIds.map((id) => {
              const step = trip.plan.steps.find((s) => s.id === id)!;
              return <TimelineStep key={id} step={step} />;
            })}
          </div>
          {!!archivedSteps(trip, day.id).filter((s) => s.kind === 'stop').length && (
            <details className="archived-stops">
              <summary>
                Tappe fuori programma ·{' '}
                {archivedSteps(trip, day.id).filter((s) => s.kind === 'stop').length}
              </summary>
              {archivedSteps(trip, day.id)
                .filter((s) => s.kind === 'stop')
                .map((s) => (
                  <Link key={s.id} to={`/trips/${trip.id}/steps/${s.id}`}>
                    {s.title}
                    <small>Dettagli e biglietti →</small>
                  </Link>
                ))}
            </details>
          )}
          <div className="day-end">
            <span />
            <p>
              {i === trip.plan.days.length - 1
                ? 'Un viaggio da portare con voi.'
                : 'Un altro giorno da scoprire.'}
            </p>
            <span />
          </div>
        </section>
      ))}
      <aside className="notebook-note">
        <Compass size={23} />
        <div>
          <strong>Il programma vi accompagna.</strong>
          <p>
            Le tappe facoltative possono aspettare. Lasciate spazio anche a quello che incontrate
            lungo la strada.
          </p>
        </div>
      </aside>
    </main>
  );
}
function TimelineStep({ step }: { step: Step }) {
  const { trip, edit, editing } = useTrip();
  const done = trip.state.progress[step.id] === 'done',
    skipped = trip.state.progress[step.id] === 'skipped';
  const zone = step.timezone ?? trip.plan.timezone;
  const url = `/trips/${trip.id}/steps/${step.id}`;
  const dayId = trip.plan.days.find((d) => d.stepIds.includes(step.id))!.id;
  let fixed = false;
  try {
    fixed = Boolean(fixedStart(trip, step));
  } catch {
    fixed = true;
  }
  const tickets = trip.state.tickets.filter((t) => t.stepId === step.id && t.status === 'ready');
  const booked = trip.state.reservations.find((r) => r.stepId === step.id && r.status === 'booked');
  if (step.kind === 'leg')
    return (
      <div className={`timeline-row leg-row ${done || skipped ? 'completed' : ''}`}>
        <div className="time-column leg-time">{time(step.start, zone)}</div>
        <span className="timeline-dot small-dot" />
        <Link
          className="leg-card"
          to={url}
          aria-label={`${step.title}, percorso ${step.durationMinutes} minuti`}
        >
          <div className="leg-icon">
            {step.mode === 'walk' ? <Footprints size={18} /> : <TrainFront size={18} />}
          </div>
          <div className="leg-summary">
            <strong>
              {step.mode === 'walk'
                ? 'A piedi'
                : step.mode === 'train'
                  ? 'In treno'
                  : 'Trasferimento'}{' '}
              <span>· circa {step.durationMinutes} min</span>
            </strong>
            {step.estimate && <span className="poi-count">Tempo provvisorio</span>}
            {step.pois.length > 0 && (
              <span className="poi-count">
                <Camera size={13} />
                {step.pois.length}{' '}
                {step.pois.length === 1 ? 'punto di interesse' : 'punti di interesse'}
              </span>
            )}
          </div>
          <ChevronRight size={16} />
        </Link>
      </div>
    );
  return (
    <div className={`timeline-row stop-row ${done || skipped ? 'completed' : ''}`}>
      <div className="time-column">
        <strong>{time(booked?.slot ?? step.start, zone)}</strong>
        <span>{time(step.end, zone)}</span>
      </div>
      <span className={`timeline-dot ${done ? 'done' : ''}`}>{done && <Check size={12} />}</span>
      <Link className={`stop-card category-${step.category}`} to={url}>
        <div className="card-topline">
          <span className="category-label">
            {step.category === 'meal'
              ? 'A tavola'
              : step.category === 'logistics'
                ? 'Da organizzare'
                : step.category === 'free-time'
                  ? 'Tempo per voi'
                  : 'Da scoprire'}
          </span>
          {step.optional && <span className="optional-label">Facoltativa</span>}
        </div>
        <h3>{step.title}</h3>
        <p>{step.summary}</p>
        <div className="card-bottom">
          <span>
            {skipped ? 'Saltata' : done ? 'Visitata' : booked ? 'Prenotato' : 'Scopri la tappa'}{' '}
            <ArrowRight size={13} />
          </span>
          {tickets.length > 0 && (
            <span className="ticket-badge">
              <Ticket size={13} />
              {tickets.length}
            </span>
          )}
        </div>
      </Link>
      {fixed && <span className="fixed-label">Orario fisso</span>}
      {editing && (
        <button
          className="step-edit-button"
          aria-label={`Adatta ${step.title}`}
          onClick={() => edit({ dayId, stepId: step.id })}
        >
          Adatta
        </button>
      )}
    </div>
  );
}
