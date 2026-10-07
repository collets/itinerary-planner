import { useEffect, useRef, useState } from 'react';
import { Sparkles, Route, ArrowUpRight } from 'lucide-react';
import { useTrip } from '../client/context';
import { request, fetchTrip, syncPending, type TripResult } from '../client/api';
import { db, journal, saveAiAdvice } from '../client/db';
import { projectAiProposal, type AiRequest, type AiProposal } from '../domain/ai';
import type { TravelCommand } from '../domain/travel';
import type { AiJobView } from '../server/ai';
import { PlaceInformation } from './PlaceInformation';
import { Modal } from './Modal';
import { SchedulePreview } from './TravelEditor';
import { AiInsights } from './AiInsights';
import { time } from '../domain/trip';

export type AiTarget = {
  dayId: string;
  stepId?: string;
  draft?: TravelCommand;
  generic?: boolean;
  purpose?: 'information' | 'adapt';
};
type SavedAdvice = {
  text: string;
  preference: 'fastest' | 'scenic';
  request?: AiRequest;
  baseEtag?: string;
  job?: AiJobView;
  savedAt: number;
  draft?: TravelCommand;
  turns?: Array<{ text: string; job: AiJobView }>;
};
const pending = new Set(['queued', 'running', 'planning', 'routing']);
const informationPrompt =
  'Cerca e aggiorna orari, prezzi, informazioni e curiosità di questa tappa per la data della visita, citando le fonti.';
const informationFields = [
  ['identifiedPlace', 'luogo individuato'],
  ['description', 'descrizione'],
  ['details', 'approfondimenti'],
  ['trivia', 'curiosità'],
  ['entrance', 'ingresso'],
  ['openingHours', 'aperture'],
  ['price', 'prezzo'],
  ['website', 'sito ufficiale'],
  ['bookingUrl', 'prenotazione'],
] as const;
const stageLabels = {
  research: 'Luoghi vicini',
  model: 'Valutazione della richiesta',
  lookup: 'Ricerca del luogo',
  information: 'Informazioni e fonti',
  routes: 'Percorso a piedi',
  finalize: 'Anteprima delle modifiche',
};

export function AiAssistant({
  target,
  onTarget,
  onClose,
}: {
  target: AiTarget;
  onTarget: (target: AiTarget) => void;
  onClose: () => void;
}) {
  const { trip, etag, online, refresh, notify, aiMode } = useTrip();
  const [text, setText] = useState(
    target.purpose === 'information'
      ? informationPrompt
      : target.draft
        ? 'Suggerisci il percorso migliore e i luoghi lungo la strada dopo questa modifica.'
        : '',
  );
  const [draft, setDraft] = useState(target.draft);
  const [preference, setPreference] = useState<'fastest' | 'scenic'>('fastest');
  const [saved, setSaved] = useState<SavedAdvice | undefined>();
  const [job, setJob] = useState<AiJobView | undefined>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const alive = useRef(true),
    stop = useRef(false),
    activity = useRef(0);
  const key = `ai:${trip.id}:${target.dayId}:assistant-v2`;
  const legacyKey = `ai:${trip.id}:${target.dayId}:${target.stepId ?? 'day'}${target.purpose === 'information' ? ':information' : ''}`;
  const endpoint = `/trips/${trip.id}/ai`;
  const selectedStep = trip.plan.steps.find((step) => step.id === target.stepId);
  const protectedStep =
    selectedStep &&
    (trip.state.progress[selectedStep.id] === 'done' ||
      !!trip.travel?.locks[selectedStep.id] ||
      trip.state.reservations.some((r) => r.stepId === selectedStep.id && r.status === 'booked') ||
      (selectedStep.kind === 'leg' && selectedStep.mode === 'flight'));
  useEffect(() => {
    alive.current = true;
    void (async () => (await db.meta.get(key)) ?? (await db.meta.get(legacyKey)))()
      .then((item) => {
        if (!alive.current) return;
        const cached = item?.value as SavedAdvice | undefined;
        if (cached && !target.draft) {
          setSaved(cached);
          setJob(cached.job);
          setText(cached.text || (target.purpose === 'information' ? informationPrompt : ''));
          setPreference(cached.preference);
          setDraft(cached.draft);
          if (navigator.onLine && cached.request) {
            const version = activity.current;
            void request<AiJobView>(`${endpoint}/requests/${cached.request.id}`)
              .then((current) => {
                if (alive.current && activity.current === version) {
                  if (current.status === 'applied') setDraft(undefined);
                  void remember({
                    ...cached,
                    draft: current.status === 'applied' ? undefined : cached.draft,
                    job: current,
                    savedAt: Date.now(),
                  });
                }
              })
              .catch(() => {
                /* The cached conversation remains readable offline. */
              });
          }
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
        void saveAiAdvice(key, { ...saved, text, preference, draft, savedAt: Date.now() }).catch(
          () => {
            if (alive.current) setError('La bozza non è stata salvata sul telefono.');
          },
        );
    }, 350);
    return () => clearTimeout(timer);
  }, [text, preference, loaded, key, saved, draft]);
  const remember = async (value: SavedAdvice) => {
    if (!alive.current) return;
    await saveAiAdvice(key, value);
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
      if (stop.current || !alive.current) break;
      await remember({ ...value, job: current, savedAt: Date.now() });
    }
  };
  const generate = async (resume = false, choice?: { id: string; label: string }) => {
    if (!online || busy) return;
    activity.current++;
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
          text: '',
          preference,
          draft,
          turns: [
            ...(saved?.turns ?? []),
            ...(job && saved?.request ? [{ text: saved.request.text, job }] : []),
          ].slice(-3),
          request: {
            id: crypto.randomUUID(),
            dayId: target.dayId,
            ...(job ? { parentJobId: job.id } : {}),
            ...(target.stepId ? { stepId: target.stepId } : {}),
            text: choice?.label ?? text,
            ...(choice ? { choiceId: choice.id } : {}),
            preference,
            purpose: target.purpose ?? 'adapt',
            ...(draft ? { draft } : {}),
          },
          baseEtag: fresh.etag,
          savedAt: Date.now(),
        };
        setText('');
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
    activity.current++;
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
    activity.current++;
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
            draft: undefined,
            job: {
              ...job,
              status: 'applied',
              message: 'Proposta applicata al programma condiviso.',
            },
            savedAt: Date.now(),
          });
        setDraft(undefined);
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
  const resetConversation = async () => {
    if (busy || (job && pending.has(job.status))) return;
    activity.current++;
    setJob(undefined);
    setText('');
    setDraft(undefined);
    setError('');
    await remember({ text: '', preference, savedAt: Date.now() });
  };
  return (
    <Modal title="Assistente di viaggio" fullScreen onClose={onClose}>
      <div className="ai-assistant">
        <div className="ai-conversation">
          <div className="ai-intro">
            <Sparkles size={22} />
            <p>
              Chiedi informazioni, confronta alternative o adatta la giornata. Le modifiche si
              salvano solo dopo la tua conferma.
            </p>
          </div>
          <section className="ai-context-widget" aria-label="Contesto della conversazione">
            <strong>{trip.plan.title}</strong>
            {target.purpose === 'information' && (
              <p className="small">
                Questa richiesta aggiorna le informazioni del luogo, mantenendo gli orari del
                programma.{' '}
                <button
                  className="text-link"
                  disabled={busy || (!!job && pending.has(job.status))}
                  onClick={() =>
                    onTarget({ dayId: target.dayId, stepId: target.stepId, purpose: 'adapt' })
                  }
                >
                  Torna alle modifiche del programma
                </button>
              </p>
            )}
            <label>
              Giornata
              <select
                aria-label="Giornata da rivedere"
                value={target.dayId}
                disabled={busy || !!draft || (!!job && pending.has(job.status))}
                onChange={(e) => onTarget({ dayId: e.target.value, generic: true })}
              >
                {trip.plan.days.map((day) => (
                  <option value={day.id} key={day.id}>
                    {day.date} · {day.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tappa o percorso della conversazione
              <select
                aria-label="Tappa o percorso della conversazione"
                value={target.stepId ?? ''}
                disabled={busy || !!draft || (!!job && pending.has(job.status))}
                onChange={(e) =>
                  onTarget({
                    dayId: target.dayId,
                    ...(e.target.value ? { stepId: e.target.value } : { generic: true }),
                  })
                }
              >
                <option value="">L’intera giornata</option>
                {trip.plan.days
                  .find((day) => day.id === target.dayId)
                  ?.stepIds.map((id) => {
                    const step = trip.plan.steps.find((step) => step.id === id)!;
                    return (
                      <option key={id} value={id}>
                        {step.title}
                      </option>
                    );
                  })}
              </select>
            </label>
            {target.stepId && (
              <p className="small">
                Tappa: {trip.plan.steps.find((step) => step.id === target.stepId)?.title}
              </p>
            )}
            {selectedStep?.kind === 'stop' && (
              <div className="ai-stop-shortcuts" aria-label="Idee per questa tappa">
                {['visit', 'meal', 'free-time'].includes(selectedStep.category) && (
                  <button
                    className="button subtle"
                    disabled={!loaded || busy || !!draft || (!!job && pending.has(job.status))}
                    onClick={() =>
                      onTarget({
                        dayId: target.dayId,
                        stepId: selectedStep.id,
                        purpose: 'information',
                      })
                    }
                  >
                    Aggiorna informazioni con AI
                  </button>
                )}
                <button
                  className="button subtle"
                  disabled={
                    target.purpose === 'information' ||
                    !loaded ||
                    busy ||
                    !!draft ||
                    !!protectedStep ||
                    (!!job && pending.has(job.status))
                  }
                  onClick={() =>
                    setText(
                      `Vorrei sostituire «${selectedStep.title}» con un’altra visita. Quali alternative proponi, considerando gli orari e i percorsi prima e dopo?`,
                    )
                  }
                >
                  Sostituisci la tappa
                </button>
                <button
                  className="button subtle"
                  disabled={
                    target.purpose === 'information' ||
                    !loaded ||
                    busy ||
                    !!draft ||
                    !!protectedStep ||
                    (!!job && pending.has(job.status))
                  }
                  onClick={() =>
                    setText(
                      `Vorrei dedicare 30 minuti a «${selectedStep.title}». Come possiamo adattare il programma?`,
                    )
                  }
                >
                  Accorcia la visita
                </button>
              </div>
            )}
            {protectedStep && (
              <p className="small">
                Questa attività è completata, prenotata o fissa: le proposte manterranno il suo
                orario e la sua posizione nel programma.
              </p>
            )}
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
            <div className="ai-stop-shortcuts" aria-label="Idee per la giornata">
              {[
                [
                  'Cosa ci resta?',
                  'Riassumi le attività rimanenti, i margini e gli orari da rispettare.',
                ],
                [
                  'Controlla la giornata',
                  'Controlla la fattibilità della giornata, i percorsi e le aperture già disponibili. Segnala cosa manca.',
                ],
                [
                  'Ritmo più tranquillo',
                  'Proponi una giornata con meno cammino e pause, mantenendo le attività prenotate e fisse.',
                ],
                [
                  'Costi',
                  'Riassumi i costi stimati della giornata per tutti e i pagamenti separati, con conversioni in euro disponibili.',
                ],
                [
                  'Cronologia',
                  'Quali modifiche della giornata posso annullare? Mostrami le scelte dalla cronologia.',
                ],
              ].map(([label, prompt]) => (
                <button
                  key={label}
                  className="button subtle"
                  disabled={!loaded || busy || !!draft || (!!job && pending.has(job.status))}
                  onClick={() => setText(prompt)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
          {aiMode === 'mock' && (
            <p className="warning-note">
              Demo senza costi: nessuna chiamata AI o ricerca online. Prova “Siamo in ritardo di 30
              minuti”.
            </p>
          )}
          {aiMode === 'mock' && selectedStep?.kind === 'stop' && (
            <p className="small muted">
              La demo può adattare gli orari. Sostituzioni con nuove visite e nuovi percorsi
              richiedono il servizio AI attivo.
            </p>
          )}
          {!online && (
            <p className="warning-note">
              Sei offline. Puoi scrivere una bozza e leggere i consigli salvati. Generazione e
              conferma richiedono una connessione.
            </p>
          )}
          {draft && (
            <p className="travel-note">
              La modifica in anteprima è inclusa nella richiesta. Verrà salvata insieme alla
              proposta solo dopo la conferma.
            </p>
          )}
          {saved?.turns?.map((turn) => (
            <section className="ai-chat-turn" key={turn.job.id}>
              <p className="ai-message ai-message-user">{turn.text}</p>
              <div className="ai-message ai-message-assistant">
                <p>{turn.job.message}</p>
                {turn.job.proposals.map((proposal) => (
                  <details key={proposal.id}>
                    <summary>{proposal.title} · consiglio precedente</summary>
                    <p>{proposal.explanation}</p>
                  </details>
                ))}
              </div>
            </section>
          ))}
          {job && (
            <section className="ai-chat-turn" aria-live="polite">
              <p className="ai-message ai-message-user">{saved?.request?.text}</p>
              <div className="ai-message ai-message-assistant">
                <p className="small muted">
                  Consiglio salvato ·{' '}
                  {new Date(saved?.savedAt ?? Date.now()).toLocaleString('it-IT')}
                </p>
                <p role="status">{job.message}</p>
                {job.task?.constraints.preferences.length ? (
                  <p className="small">
                    Preferenze: {job.task.constraints.preferences.join(' · ')}
                  </p>
                ) : null}
                {job.task && (
                  <div className="small" aria-label="Vincoli della richiesta">
                    {job.task.constraints.keepStepIds.length > 0 && (
                      <p>
                        Da conservare:{' '}
                        {job.task.constraints.keepStepIds
                          .map((id) => trip.plan.steps.find((s) => s.id === id)?.title)
                          .join(', ')}
                        .
                      </p>
                    )}
                    {job.task.constraints.maxWalkingMinutes !== null && (
                      <p>
                        Limite a piedi nella giornata: {job.task.constraints.maxWalkingMinutes} min.
                      </p>
                    )}
                    {job.task.constraints.avoidPlaceIds.length > 0 && (
                      <p>
                        Luoghi da evitare:{' '}
                        {job.task.constraints.avoidPlaceIds
                          .map((id) => trip.plan.places.find((p) => p.id === id)?.name ?? id)
                          .join(', ')}
                        .
                      </p>
                    )}
                    {job.task.constraints.finishBy && (
                      <p>
                        Fine entro le {time(job.task.constraints.finishBy, trip.plan.timezone)}.
                      </p>
                    )}
                    {job.task.constraints.requireOpenPlaceIds.length > 0 && (
                      <p>Le visite richieste devono rientrare nelle aperture verificate.</p>
                    )}
                    {(job.task.constraints.visitNotBefore ||
                      job.task.constraints.visitNotAfter) && (
                      <p>
                        Fascia per visite aggiunte o spostate:{' '}
                        {job.task.constraints.visitNotBefore
                          ? `dalle ${time(job.task.constraints.visitNotBefore, trip.plan.timezone)}`
                          : ''}{' '}
                        {job.task.constraints.visitNotAfter
                          ? `entro le ${time(job.task.constraints.visitNotAfter, trip.plan.timezone)}`
                          : ''}
                        .
                      </p>
                    )}
                  </div>
                )}
                {job.task?.pendingQuestion && job.status === 'clarification' && (
                  <div className="ai-stop-shortcuts" aria-label="Risposte alla domanda">
                    {job.task.pendingQuestion.choices.map((choice) => (
                      <button
                        key={choice.id}
                        className="button subtle"
                        disabled={!online || busy || Date.parse(job.expiresAt) <= Date.now()}
                        onClick={() => void generate(false, choice)}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                )}
                {job.insights && <AiInsights insights={job.insights} />}
                {!!job.trace?.length && (
                  <details>
                    <summary>Verifiche eseguite</summary>
                    {job.trace.map((entry, index) => (
                      <p className="small" key={index}>
                        {stageLabels[entry.stage]} ·{' '}
                        {entry.outcome === 'failed'
                          ? 'non completata'
                          : entry.outcome === 'clarification'
                            ? 'serve una scelta'
                            : 'completata'}
                      </p>
                    ))}
                  </details>
                )}
                {(job.facts ?? []).length > 0 && !job.proposals.length && (
                  <details>
                    <summary>Informazioni e fonti consultate</summary>
                    {job.facts!.map((fact) => (
                      <PlaceInformation key={fact.placeId} information={fact.information} />
                    ))}
                  </details>
                )}
                {job.failure && job.status === 'failed' && (
                  <p className="small">
                    Puoi consultare i dati e le fonti salvate o usare Adatta. La richiesta non viene
                    ripetuta automaticamente.
                  </p>
                )}
              </div>
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
                  La richiesta non viene ripetuta automaticamente. Serve una verifica della spesa da
                  parte dell’operatore.
                </p>
              )}
            </section>
          )}
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
          {job && !pending.has(job.status) && (
            <button className="text-link" disabled={busy} onClick={() => void resetConversation()}>
              Nuova conversazione
            </button>
          )}
          {error && (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
          <p className="small muted">
            I consigli possono contenere errori. Prenotazioni e orari fissi restano protetti. Le
            bozze non vengono inviate automaticamente quando torna la connessione.
          </p>
        </div>
        <form
          className="ai-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <label>
            {job ? 'Continua la conversazione' : 'Cosa vuoi cambiare?'}
            <textarea
              aria-label="Richiesta di assistenza"
              rows={2}
              maxLength={2000}
              value={text}
              disabled={busy}
              placeholder={
                job
                  ? 'Vorrei dedicare meno tempo al museo…'
                  : selectedStep?.kind === 'stop'
                    ? 'Vorrei sostituire questa tappa con un’altra visita…'
                    : 'Siamo in ritardo di 30 minuti…'
              }
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            className="button full"
            type="submit"
            disabled={
              !loaded || !online || busy || !text.trim() || (!!job && pending.has(job.status))
            }
          >
            <Sparkles size={17} />
            {busy ? 'Valutazione in corso…' : 'Invia richiesta'}
          </button>
        </form>
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
      {(proposal.information ?? []).map((update) => (
        <section className="ai-route" key={update.placeId}>
          <h4>
            {[...trip.plan.places, ...proposal.places].find((p) => p.id === update.placeId)?.name} ·
            informazioni proposte
          </h4>
          <p className="small">
            Campi aggiornati:{' '}
            {informationFields
              .filter(
                ([key]) =>
                  JSON.stringify(
                    trip.plan.places.find((p) => p.id === update.placeId)?.information?.[key],
                  ) !== JSON.stringify(update.information[key]),
              )
              .map(([, label]) => label)
              .join(', ') || 'data e fonti della verifica'}
            . I campi non verificati sono indicati come non disponibili.
          </p>
          <PlaceInformation information={update.information} />
        </section>
      ))}
      {(proposal.locations ?? []).map((location) => (
        <section className="ai-route" key={location.placeId}>
          <h4>
            Posizione proposta · {trip.plan.places.find((p) => p.id === location.placeId)?.name}
          </h4>
          <p>
            Luogo individuato: {location.candidateName}. Coordinate da fonte pubblica:{' '}
            {location.coordinates.lat}, {location.coordinates.lng}.
          </p>
          <p className="small">
            Consultate il {location.coordinates.verifiedOn}. La posizione del monumento può
            differire dall’ingresso visitatori. Nome, biglietti e prenotazioni restano collegati
            alla tappa originale.
          </p>
        </section>
      ))}
      {proposal.routes.map((route, i) => (
        <section className="ai-route" key={i}>
          <h4>
            <Route size={17} />
            {
              [...trip.plan.places, ...proposal.places].find((p) => p.id === route.fromPlaceId)
                ?.name
            }{' '}
            →{' '}
            {[...trip.plan.places, ...proposal.places].find((p) => p.id === route.toPlaceId)?.name}
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
              <strong>
                {
                  [...trip.plan.places, ...proposal.places].find((place) => place.id === p.placeId)
                    ?.name
                }
              </strong>
              : {p.note} {p.visitMinutes > 0 && `· sosta ${p.visitMinutes} min`}
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
