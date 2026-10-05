import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Outlet, useNavigate, NavLink, Link } from 'react-router-dom';
import {
  Footprints,
  Route,
  Tickets,
  ListChecks,
  RefreshCw,
  Download,
  WifiOff,
  ArrowLeft,
  CircleHelp,
} from 'lucide-react';
import { queueTravel } from './api';
import { applyTravel, type TravelCommand } from '../domain/travel';
import { TravelEditor, type EditTarget } from '../components/TravelEditor';
import { TravelSync } from '../components/TravelSync';
import { db, overlay } from './db';
import { loadTrip, queueChange, syncPending, request, type TripResult } from './api';
import type { Progress, Trip } from '../domain/schema';
import { currentStep } from '../domain/trip';
import { OfflineDialog } from '../components/OfflineDialog';

type TripContextValue = TripResult & {
  editing: boolean;
  edit: (target: EditTarget) => void;
  saveTravel: (command: TravelCommand, base: Trip, revise: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  changeProgress: (id: string, status: Progress) => Promise<void>;
  changeTask: (id: string, done: boolean) => Promise<void>;
  online: boolean;
  notify: (message: string) => void;
};
const TripContext = createContext<TripContextValue | null>(null);
export function useTrip() {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error('Trip context missing');
  return ctx;
}
export function useOnline() {
  const [online, set] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => set(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
export function Loading({ message = 'Prepariamo il viaggio…' }: { message?: string }) {
  return (
    <div className="empty">
      <Footprints size={32} className="loading-icon" />
      <p>{message}</p>
    </div>
  );
}
export function ErrorPanel({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <CircleHelp size={32} />
      <h2>Facciamo un altro tentativo</h2>
      <p>{message}</p>
      {retry && (
        <button className="button" onClick={retry}>
          Riprova
        </button>
      )}
      <Link className="text-link" to="/">
        Torna ai viaggi
      </Link>
    </div>
  );
}
export function TripShell() {
  const { tripId = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const online = useOnline();
  const query = useQuery({
    queryKey: ['trip', tripId],
    queryFn: () => loadTrip(tripId),
    staleTime: 60000,
    retry: false,
  });
  const [editor, setEditor] = useState<EditTarget | null>(null),
    [config, setConfig] = useState({ editing: true, staging: false });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = await db.meta.get('config');
      if (saved && alive) setConfig(saved.value as typeof config);
      try {
        const next = await request<typeof config>('/config');
        await db.meta.put({ id: 'config', value: next });
        if (alive) setConfig(next);
      } catch {
        /* Cached settings remain usable offline. */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [notice, setNotice] = useState(''),
    [showOffline, setShowOffline] = useState(false),
    [savedAt, setSavedAt] = useState<number | null>(null);
  const notify = (message: string) => {
    setNotice(message);
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const update = () => {
      void client.invalidateQueries({ queryKey: ['trip', tripId] });
    };
    window.addEventListener('passo:synced', update);
    const timer = online
      ? setInterval(() => {
          void db.travelCommands.count().then((count) => {
            if (count) void syncPending();
          });
        }, 15000)
      : undefined;
    if (online) void syncPending();
    return () => {
      window.removeEventListener('passo:synced', update);
      if (timer) clearInterval(timer);
    };
  }, [online, tripId, client]);
  useEffect(() => {
    void db.trips.get(tripId).then((v) => setSavedAt(v?.downloaded ? v.savedAt : null));
  }, [tripId, query.data?.trip.revision, showOffline]);
  useEffect(() => {
    const trip = query.data?.trip;
    if (!trip || !online || query.data?.offline) return;
    const currencies = [
      ...new Set([
        ...trip.plan.costs.map((c) => c.currency),
        ...trip.state.reservations.flatMap((r) => (r.currency ? [r.currency] : [])),
      ]),
    ].filter((c) => c !== 'EUR');
    const stale = currencies.some(
      (c) =>
        !trip.state.exchangeRates.some(
          (r) => r.currency === c && Date.now() - Date.parse(r.fetchedAt) < 24 * 60 * 60 * 1000,
        ),
    );
    const key = `passo:rates-attempt:${trip.id}`;
    if (stale && Date.now() - Number(sessionStorage.getItem(key) ?? 0) > 60000) {
      sessionStorage.setItem(key, String(Date.now()));
      void request<TripResult>(`/trips/${trip.id}/rates`, 'POST', {})
        .then(() => client.invalidateQueries({ queryKey: ['trip', trip.id] }))
        .catch(() => {
          /* Preserve original prices and any previously saved rate. */
        });
    }
  }, [query.data, online, client]);
  if (query.isPending) return <Loading />;
  if (!query.data)
    return (
      <ErrorPanel
        message={query.error instanceof Error ? query.error.message : 'Viaggio non disponibile.'}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  const { trip, etag, offline } = query.data;
  const base = `/trips/${trip.id}`;
  const refresh = async () => {
    if (navigator.onLine) await syncPending();
    await query.refetch();
  };
  const next = currentStep(trip);
  const change = async (item: {
    kind: 'task' | 'progress';
    itemId: string;
    value: boolean | Progress;
    expected: boolean | Progress;
  }) => {
    const before = client.getQueryData<TripResult>(['trip', trip.id]);
    // Update controls synchronously; persist the queued change before networking.
    client.setQueryData<TripResult>(['trip', trip.id], (old) =>
      old
        ? {
            ...old,
            trip: {
              ...old.trip,
              state: {
                ...old.trip.state,
                ...(item.kind === 'progress'
                  ? {
                      progress: {
                        ...old.trip.state.progress,
                        [item.itemId]: item.value as Progress,
                      },
                    }
                  : {
                      taskCompletion: {
                        ...old.trip.state.taskCompletion,
                        [item.itemId]: item.value as boolean,
                      },
                    }),
              },
            },
          }
        : old,
    );
    try {
      await queueChange({ ...item, tripId: trip.id });
    } catch (error) {
      client.setQueryData(['trip', trip.id], before);
      throw error;
    }
    if (online) await syncPending();
    else notify('Salvato su questo telefono. Sincronizziamo quando torna la connessione.');
  };
  const ctx: TripContextValue = {
    trip,
    etag,
    offline,
    online: online && !offline,
    refresh,
    editing: config.editing,
    edit: setEditor,
    saveTravel: async (command, base, revise) => {
      if (!config.editing) throw new Error('Le modifiche sono disattivate.');
      if (revise) {
        const preview = applyTravel(base, command);
        await db.travelCommands.update(command.id, {
          command,
          preview,
          conflict: false,
          error: undefined,
        });
        const cache = await db.trips.get(trip.id);
        if (cache) await db.trips.put({ ...cache, trip: base });
      } else await queueTravel(base, command);
      const cache = await db.trips.get(trip.id);
      client.setQueryData<TripResult>(['trip', trip.id], {
        trip: await overlay(cache?.trip ?? base),
        etag: cache?.etag ?? etag,
        offline,
      });
      if (online) void syncPending();
    },
    notify,
    changeProgress: (id, status) =>
      change({
        kind: 'progress',
        itemId: id,
        value: status,
        expected: trip.state.progress[id] ?? 'pending',
      }),
    changeTask: (id, done) =>
      change({
        kind: 'task',
        itemId: id,
        value: done,
        expected: trip.state.taskCompletion[id] ?? false,
      }),
  };
  return (
    <TripContext.Provider value={ctx}>
      <div className="trip-toolbar">
        <div className="toolbar-inner">
          <Link className="trip-back" to="/">
            <ArrowLeft size={16} />
            <span>{trip.plan.title}</span>
          </Link>
          <div className="toolbar-actions">
            <button
              className="icon-button"
              onClick={() => {
                void refresh();
              }}
              aria-label="Aggiorna viaggio"
              disabled={!online}
            >
              <RefreshCw size={18} className={query.isFetching ? 'spin' : ''} />
            </button>
            <button
              className="icon-button"
              aria-label="Salva viaggio offline"
              onClick={() => setShowOffline(true)}
            >
              <Download size={18} />
            </button>
          </div>
        </div>
      </div>
      {offline || !online ? (
        <div className="offline-bar">
          <WifiOff size={14} /> Stai usando il viaggio salvato{' '}
          {savedAt && `· ${new Date(savedAt).toLocaleString('it-IT')}`}
        </div>
      ) : null}
      {config.staging && <div className="staging-bar">STAGING · Ambiente di prova</div>}
      <TravelSync />
      <Outlet />
      <nav className="bottom-nav" aria-label="Navigazione viaggio">
        <NavLink to={base} end>
          <Route size={21} />
          <span>Itinerario</span>
        </NavLink>
        <button onClick={() => next && navigate(`${base}/steps/${next.id}`)}>
          <Footprints size={21} />
          <span>Adesso</span>
        </button>
        <NavLink to={`${base}/tickets`}>
          <Tickets size={21} />
          <span>Biglietti</span>
        </NavLink>
        <NavLink to={`${base}/preparation`}>
          <ListChecks size={21} />
          <span>Preparativi</span>
        </NavLink>
      </nav>
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button aria-label="Chiudi messaggio" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      {editor && <TravelEditor target={editor} onClose={() => setEditor(null)} />}
      {showOffline && <OfflineDialog onClose={() => setShowOffline(false)} />}
    </TripContext.Provider>
  );
}
export function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {children}
    </div>
  );
}
export function useLocalTripState(trip: Trip) {
  return {
    completed: trip.plan.steps.filter((s) => trip.state.progress[s.id] === 'done').length,
    total: trip.plan.steps.length,
  };
}
