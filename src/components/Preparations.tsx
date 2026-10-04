import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  ExternalLink,
  ArrowRight,
  Wallet,
  ListChecks,
  GitBranch,
  AlertCircle,
} from 'lucide-react';
import { useTrip, SectionHeading } from '../client/context';
import { budget, money, bookingWarnings } from '../domain/trip';
import { db, type Pending } from '../client/db';
import { EuroEstimate } from './EuroEstimate';
import { resolvePending } from '../client/api';

export function Preparations() {
  const { trip, changeTask, notify, refresh, online } = useTrip();
  const sums = budget(trip);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOptimistic((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([id, value]) => (trip.state.taskCompletion[id] ?? false) !== value,
        ),
      ),
    );
  }, [trip.state.taskCompletion]);
  const checked = (id: string) => optimistic[id] ?? trip.state.taskCompletion[id] ?? false;
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => {
    const load = () => {
      void db.pending.where('tripId').equals(trip.id).toArray().then(setPending);
    };
    load();
    window.addEventListener('passo:synced', load);
    return () => window.removeEventListener('passo:synced', load);
  }, [trip.id, trip.revision]);
  const done = trip.plan.tasks.filter((t) => checked(t.id)).length;
  return (
    <main className="page preparation-page">
      <SectionHeading eyebrow="PRIMA DI PARTIRE" title="Spazio alle cose belle.">
        <p>Poche cose da organizzare, per viaggiare più leggeri.</p>
      </SectionHeading>
      {pending.length > 0 && (
        <section className="warning-note">
          <h2>
            <AlertCircle size={19} />
            Aggiornamenti da sincronizzare
          </h2>
          <p>{pending.length} modifiche su questo telefono.</p>
          {pending
            .filter((p) => p.conflict)
            .map((p) => (
              <div className="conflict-item" key={p.id}>
                <strong>
                  {trip.plan.steps.find((s) => s.id === p.itemId)?.title ??
                    trip.plan.tasks.find((t) => t.id === p.itemId)?.title ??
                    'Tappa rimossa'}
                </strong>
                <p>Il dato condiviso è cambiato. Scegli quale mantenere.</p>
                <div className="button-row">
                  <button
                    className="button subtle"
                    disabled={!online}
                    onClick={() => {
                      void resolvePending(p.id, false)
                        .then(refresh)
                        .catch((e) => notify(e.message));
                    }}
                  >
                    Usa dato condiviso
                  </button>
                  <button
                    className="button subtle"
                    disabled={!online}
                    onClick={() => {
                      void resolvePending(p.id, true)
                        .then(refresh)
                        .catch((e) => notify(e.message));
                    }}
                  >
                    Mantieni questo telefono
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}
      {bookingWarnings(trip).map((warning, i) => (
        <p className="warning-note" key={i}>
          {warning}
        </p>
      ))}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <ListChecks size={20} />
            La vostra checklist
          </h2>
          <span>
            {done}/{trip.plan.tasks.length}
          </span>
        </div>
        <progress
          className="checklist-progress"
          value={done}
          max={Math.max(1, trip.plan.tasks.length)}
        />
        <div className="tasks">
          {trip.plan.tasks.map((task) => (
            <div className={`task-row ${checked(task.id) ? 'task-done' : ''}`} key={task.id}>
              <label>
                <input
                  type="checkbox"
                  checked={checked(task.id) ?? false}
                  onChange={(e) => {
                    const value = e.target.checked;
                    setOptimistic((previous) => ({ ...previous, [task.id]: value }));
                    void changeTask(task.id, value).catch((error) => {
                      setOptimistic((previous) => {
                        const next = { ...previous };
                        delete next[task.id];
                        return next;
                      });
                      notify(error.message);
                    });
                  }}
                />
                <span className="task-custom-check">
                  <Check size={14} />
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.description}</small>
                  {task.priority === 'high' && !checked(task.id) && (
                    <span className="priority-label">Da fare prima</span>
                  )}
                </span>
              </label>
              {task.url && (
                <a
                  className="icon-button"
                  href={task.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Apri sito per ${task.title}`}
                >
                  <ExternalLink size={17} />
                </a>
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="panel budget-panel">
        <div className="panel-heading">
          <h2>
            <Wallet size={20} />
            Quanto mettere in conto
          </h2>
        </div>
        {Object.entries(sums).map(([currency, sum]) => (
          <div className="budget-total" key={currency}>
            <span className="eyebrow">STIMA PER {trip.plan.travellers.length} PERSONE</span>
            <strong>
              {money(sum.min, currency)} – {money(sum.max, currency)}
            </strong>
            <EuroEstimate min={sum.min} max={sum.max} currency={currency} />
            <p>
              {money(sum.min / trip.plan.travellers.length, currency)} –{' '}
              {money(sum.max / trip.plan.travellers.length, currency)} a persona
              <EuroEstimate
                min={sum.min / trip.plan.travellers.length}
                max={sum.max / trip.plan.travellers.length}
                currency={currency}
              />
            </p>
            {sum.paid > 0 && (
              <p className="paid-note">
                Già pagato: {money(sum.paid, currency)} · registrato separatamente dalla stima
                <EuroEstimate min={sum.paid} currency={currency} />
              </p>
            )}
            {sum.unknown > 0 && (
              <p className="muted small">
                {sum.unknown}{' '}
                {sum.unknown === 1
                  ? 'voce con costo da verificare'
                  : 'voci con costo da verificare'}
                , oltre alla stima.
              </p>
            )}
          </div>
        ))}
        <details className="cost-breakdown">
          <summary>Vedi le singole voci</summary>
          <div className="cost-list">
            {trip.plan.costs
              .filter((c) => c.inclusion === 'base')
              .map((c) => (
                <div key={c.id}>
                  <span>
                    {c.title}
                    <small>
                      {c.basis === 'person' ? 'per persona' : 'per il gruppo'} ·{' '}
                      {c.status === 'estimate'
                        ? 'stima'
                        : c.status === 'unknown'
                          ? 'da verificare'
                          : 'tariffa indicata'}
                    </small>
                  </span>
                  <strong>
                    {c.min === null || c.max === null
                      ? 'Da verificare'
                      : c.min === c.max
                        ? money(c.min, c.currency)
                        : `${money(c.min, c.currency)} – ${money(c.max, c.currency)}`}
                    <EuroEstimate min={c.min} max={c.max} currency={c.currency} />
                  </strong>
                </div>
              ))}
          </div>
        </details>
        {trip.plan.costs.some((c) => c.inclusion === 'optional') && (
          <div className="optional-costs">
            <h3>Se aggiungete qualcosa</h3>
            {trip.plan.costs
              .filter((c) => c.inclusion === 'optional')
              .map((c) => (
                <p key={c.id}>
                  {c.title}
                  <strong>
                    {c.min === null ? 'Da verificare' : '+' + money(c.min, c.currency)} /{' '}
                    {c.basis === 'person' ? 'persona' : 'gruppo'}
                    <EuroEstimate min={c.min} max={c.max} currency={c.currency} />
                  </strong>
                </p>
              ))}
          </div>
        )}
        {trip.state.exchangeRates.length > 0 && (
          <p className="muted small">
            Stime in euro al cambio di riferimento:{' '}
            {trip.state.exchangeRates.map((r) => (
              <span key={r.currency}>
                {r.currency}, {new Intl.DateTimeFormat('it-IT').format(new Date(r.asOf))} ·{' '}
                <a href={r.source} target="_blank" rel="noopener noreferrer">
                  fonte BCE via Frankfurter
                </a>
                .{' '}
              </span>
            ))}
            Il cambio della banca può variare.
          </p>
        )}
      </section>
      {trip.plan.alternatives.length > 0 && (
        <section className="alternatives">
          <h2>
            <GitBranch size={21} />
            Un’altra strada possibile
          </h2>
          <p className="muted">
            Scegliete quello che vi ispira. Un agente può adattare orari e percorsi per voi.
          </p>
          {trip.plan.alternatives.map((alt) => (
            <article className="alternative-card" key={alt.id}>
              <h3>{alt.title}</h3>
              <p>{alt.description}</p>
              <span className="cost-difference">{alt.costDifference}</span>
              <Link className="text-link" to={`/trips/${trip.id}/steps/${alt.affectedStepIds[0]}`}>
                Vedi la tappa interessata
                <ArrowRight size={15} />
              </Link>
            </article>
          ))}
        </section>
      )}
      {trip.plan.assumptions.length > 0 && (
        <section className="detail-section">
          <h2>Da tenere presente</h2>
          <ul className="assumptions">
            {trip.plan.assumptions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
