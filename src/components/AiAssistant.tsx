import { useEffect, useRef, useState } from 'react';
import { Sparkles, Route, ArrowUpRight } from 'lucide-react';
import { useTrip } from '../client/context';
import { request, fetchTrip, syncPending, type TripResult } from '../client/api';
import { db, journal } from '../client/db';
import { projectAiProposal, type AiRequest, type AiProposal } from '../domain/ai';
import type { TravelCommand } from '../domain/travel';
import type { AiJobView } from '../server/ai';
import { Modal } from './Modal';
import { SchedulePreview } from './TravelEditor';

export type AiTarget = { dayId: string; stepId?: string; draft?: TravelCommand };
type SavedAdvice = {
  text: string;
  preference: 'fastest' | 'scenic';
  request?: AiRequest;
  baseEtag?: string;
  job?: AiJobView;
  savedAt: number;
};
const pending = new Set(['queued', 'running', 'planning', 'routing']);

export function AiAssistant({ target, onClose }: { target: AiTarget; onClose: () => void }) {
  const { trip, etag, online, refresh, notify, aiMode } = useTrip();
  const [text, setText] = useState(
    target.draft
      ? 'Suggerisci il percorso migliore e i luoghi lungo la strada dopo questa modifica.'
      : '',
  );
  const [preference, setPreference] = useState<'fastest' | 'scenic'>('fastest');
  const [saved, setSaved] = useState<SavedAdvice | undefined>();
  const [job, setJob] = useState<AiJobView | undefined>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const alive = useRef(true),
    stop = useRef(false);
  const key = `ai:${trip.id}:${target.dayId}:${target.stepId ?? 'day'}`;
  const endpoint = `/trips/${trip.id}/ai`;
  const day = trip.plan.days.find((d) => d.id === target.dayId);
  useEffect(() => {
    alive.current = true;
    void db.meta
      .get(key)
      .then((item) => {
        if (!alive.current) return;
        const cached = item?.value as SavedAdvice | undefined;
        if (cached && !target.draft) {
          setSaved(cached);
          setJob(cached.job);
          setText(cached.text);
          setPreference(cached.preference);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive.current) {
          setLoaded(true);
          setError('Non riesco a leggere i consigli salvati sul telefono.');
        }
      });
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, [key, target.draft]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      if (alive.current)
        void db.meta
          .put({ id: key, value: { ...saved, text, preference, savedAt: Date.now() } })
          .catch(() => setError('La bozza non è stata salvata sul telefono.'));
    }, 350);
    return () => clearTimeout(timer);
  }, [text, preference, loaded, key, saved]);
  const remember = async (value: SavedAdvice) => {
    if (!alive.current) return;
    await db.meta.put({ id: key, value });
    if (alive.current) {
      setSaved(value);
      setJob(value.job);
    }
  };
  const progress = async (current: AiJobView, value: SavedAdvice) => {
    await remember({ ...value, job: current, savedAt: Date.now() });
    for (
      let step = 0;
      step < 20 && pending.has(current.status) && !stop.current && alive.current;
      step++
    ) {
      if (!navigator.onLine)
        throw new Error(
          'Connessione interrotta. La richiesta resta salvata: riaprila quando torni online.',
        );
      if (current.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (stop.current || !alive.current) break;
        current = await request<AiJobView>(`${endpoint}/requests/${current.id}`);
      } else
        current = await request<AiJobView>(
          `${endpoint}/requests/${current.id}/advance`,
          'POST',
          {},
        );
      await remember({ ...value, job: current, savedAt: Date.now() });
    }
  };
  const generate = async (resume = false) => {
    if (!online || busy) return;
    setBusy(true);
    setError('');
    stop.current = false;
    try {
      await syncPending();
      if ((await journal(trip.id)).length)
        throw new Error('Prima risolvi e sincronizza le modifiche locali del viaggio.');
      let value: SavedAdvice;
      if (resume && saved?.request && saved.baseEtag) value = saved;
      else {
        if (job && pending.has(job.status))
          throw new Error('Riprendi o annulla la richiesta in corso prima di crearne un’altra.');
        const fresh = await fetchTrip(trip.id);
        value = {
          text,
          preference,
          request: {
            id: crypto.randomUUID(),
            dayId: target.dayId,
            ...(target.stepId ? { stepId: target.stepId } : {}),
            text,
            preference,
            ...(target.draft ? { draft: target.draft } : {}),
          },
          baseEtag: fresh.etag,
          savedAt: Date.now(),
        };
        await remember(value);
      }
      const current = await request<AiJobView>(
        `${endpoint}/requests`,
        'POST',
        value.request,
        value.baseEtag,
      );
      await progress(current, value);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Richiesta non riuscita.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const cancel = async () => {
    stop.current = true;
    if (!saved?.request || !online) return;
    try {
      const current = await request<AiJobView>(
        `${endpoint}/requests/${saved.request.id}/cancel`,
        'POST',
        {},
      );
      await remember({ ...saved, job: current, savedAt: Date.now() });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Annullamento non riuscito.');
    }
  };
  const apply = async (proposal: AiProposal) => {
    if (!online || busy) return;
    setBusy(true);
    setError('');
    try {
      await syncPending();
      if ((await journal(trip.id)).length)
        throw new Error('Sincronizza le modifiche locali prima di applicare la proposta.');
      const fresh = await fetchTrip(trip.id);
      if (fresh.etag !== proposal.baseEtag && !fresh.trip.travel?.appliedIds.includes(proposal.id))
        throw new Error('Il programma è cambiato. Richiedi una nuova valutazione.');
      await request<TripResult>(
        `${endpoint}/proposals/${proposal.id}/apply`,
        'POST',
        { previewHash: proposal.previewHash },
        fresh.etag,
      );
      if (alive.current) {
        if (saved && job)
          await remember({
            ...saved,
            job: {
              ...job,
              status: 'applied',
              message: 'Proposta applicata al programma condiviso.',
            },
            savedAt: Date.now(),
          });
        await refresh();
        notify('Proposta applicata. Puoi annullarla dalla cronologia.');
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Applicazione non riuscita. Verifica il programma prima di riprovare.',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal title={`Chiedi aiuto · ${day?.title ?? 'Viaggio'}`} onClose={onClose}>
      <div className="ai-assistant">
        <div className="ai-intro">
          <Sparkles size={22} />
          <p>
            Rivediamo la giornata insieme. Nessuna modifica viene salvata finché non confermi una
            proposta.
          </p>
        </div>
        {aiMode === 'mock' && (
          <p className="warning-note">
            Demo senza costi: nessuna chiamata AI o ricerca online. Usa “Siamo in ritardo di 30
            minuti” o chiedi di rivedere i percorsi.
          </p>
        )}
        {!online && (
          <p className="warning-note">
            Sei offline. Puoi scrivere una bozza e leggere i consigli salvati. Generazione e
            conferma richiedono una connessione.
          </p>
        )}
        {target.draft && (
          <p className="travel-note">
            La modifica in anteprima è inclusa nella richiesta e verrà salvata insieme alla
            proposta, solo dopo la conferma.
          </p>
        )}
        <label>
          Cosa vuoi cambiare?
          <textarea
            aria-label="Richiesta di assistenza"
            rows={4}
            maxLength={2000}
            value={text}
            disabled={busy}
            placeholder="Siamo in ritardo di 30 minuti. Come adattiamo il pomeriggio?"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label>
          La passeggiata
          <select
            value={preference}
            disabled={busy}
            onChange={(e) => setPreference(e.target.value as typeof preference)}
          >
            <option value="fastest">Il percorso più rapido</option>
            <option value="scenic">Con luoghi interessanti lungo la strada</option>
          </select>
        </label>
        <button
          className="button full"
          disabled={
            !loaded || !online || busy || !text.trim() || (!!job && pending.has(job.status))
          }
          onClick={() => void generate()}
        >
          <Sparkles size={17} />
          {busy ? 'Valutazione in corso…' : 'Prepara una proposta'}
        </button>
        {saved?.request && (!job || pending.has(job.status)) && (
          <button
            className="button subtle full"
            disabled={!online || busy}
            onClick={() => void generate(true)}
          >
            Riprendi la richiesta salvata
          </button>
        )}
        {(busy || (!!job && pending.has(job.status))) && (
          <button className="button subtle full" disabled={!online} onClick={() => void cancel()}>
            Annulla richiesta
          </button>
        )}
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
        {job && (
          <section className="ai-advice" aria-live="polite">
            <p className="small muted">
              Consiglio salvato · {new Date(saved?.savedAt ?? Date.now()).toLocaleString('it-IT')}
            </p>
            <p role="status">{job.message}</p>
            {job.proposals.map((proposal) => (
              <Proposal
                key={proposal.id}
                proposal={proposal}
                available={
                  online &&
                  job.status === 'ready' &&
                  proposal.baseEtag === etag &&
                  Date.parse(proposal.expiresAt) > Date.now()
                }
                busy={busy}
                onApply={() => void apply(proposal)}
              />
            ))}
            {job.status === 'uncertain' && (
              <p className="warning-note">
                Questa richiesta non viene ripetuta automaticamente. Serve una verifica della spesa
                da parte dell’operatore.
              </p>
            )}
          </section>
        )}
        <p className="small muted">
          Le risposte possono contenere errori. Prenotazioni, attività completate e orari fissi
          restano protetti. La bozza non viene inviata automaticamente quando torna la connessione.
        </p>
      </div>
    </Modal>
  );
}
function Proposal({
  proposal,
  available,
  busy,
  onApply,
}: {
  proposal: AiProposal;
  available: boolean;
  busy: boolean;
  onApply: () => void;
}) {
  const { trip, etag } = useTrip();
  let preview: ReturnType<typeof projectAiProposal> | undefined;
  try {
    if (etag === proposal.baseEtag) preview = projectAiProposal(trip, proposal);
  } catch {
    /* A stale preview cannot be applied. */
  }
  return (
    <article className="ai-proposal">
      <h3>{proposal.title}</h3>
      <p>{proposal.explanation}</p>
      {preview ? (
        <SchedulePreview before={trip} after={preview} />
      ) : (
        <p className="warning-note">
          Il programma è cambiato. Genera una nuova proposta per confrontare gli orari aggiornati.
        </p>
      )}
      {proposal.routes.map((route, i) => (
        <section className="ai-route" key={i}>
          <h4>
            <Route size={17} />
            {trip.plan.places.find((p) => p.id === route.fromPlaceId)?.name} →{' '}
            {trip.plan.places.find((p) => p.id === route.toPlaceId)?.name}
          </h4>
          <p>
            {route.durationMinutes} min a piedi
            {route.distanceKm !== undefined
              ? ` · ${route.distanceKm.toLocaleString('it-IT')} km`
              : ''}{' '}
            · {route.estimate ? 'stima' : 'percorso calcolato'}
          </p>
          <p className="small">
            Diretto: {route.directMinutes} min · Deviazione: +{route.extraWalkingMinutes} min ·
            Soste: {route.pois.reduce((n, p) => n + p.visitMinutes, 0)} min
          </p>
          {route.streets.length > 0 && <p className="small">{route.streets.join(' → ')}</p>}
          {route.pois.map((p) => (
            <p className="small" key={p.placeId}>
              <strong>{trip.plan.places.find((place) => place.id === p.placeId)?.name}</strong>:{' '}
              {p.note} {p.visitMinutes > 0 && `· sosta ${p.visitMinutes} min`}
            </p>
          ))}
        </section>
      ))}
      {proposal.citations.length > 0 && (
        <details>
          <summary>Fonti e verifiche</summary>
          {proposal.citations.map((source, i) => (
            <p className="small" key={i}>
              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.title} <ArrowUpRight size={13} />
                </a>
              ) : (
                <strong>{source.title}</strong>
              )}{' '}
              · {source.description}
              {source.estimate ? ' · da verificare' : ''}
            </p>
          ))}
        </details>
      )}
      {proposal.warnings.map((warning, i) => (
        <p className="small muted" key={i}>
          {warning}
        </p>
      ))}
      <button className="button full" disabled={!available || !preview || busy} onClick={onApply}>
        Applica questa proposta
      </button>
    </article>
  );
}
