import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import {
  Footprints,
  ArrowRight,
  ArrowUpRight,
  LockKeyhole,
  LogOut,
  CalendarDays,
  Users,
  Compass,
  WifiOff,
} from 'lucide-react';
import { db, clearPrivateData } from './client/db';
import { loadTrips, request, syncPending, RequestError } from './client/api';
import { TripShell, Loading, ErrorPanel, useOnline } from './client/context';
import { Overview } from './components/Overview';
import { Details } from './components/Details';
import { Wallet } from './components/Wallet';
import { Preparations } from './components/Preparations';
const TicketViewer = lazy(() => import('./components/TicketViewer'));

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'in' | 'out'>('loading'),
    [update, setUpdate] = useState<(() => void) | null>(null);
  const online = useOnline(),
    client = useQueryClient();
  useEffect(() => {
    const refresh = registerSW({
      immediate: true,
      onNeedRefresh: () =>
        setUpdate(() => () => {
          void refresh(true);
        }),
    });
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stored = await db.meta.get('session');
        const valid = !!stored && (stored.value as { expiresAt: number }).expiresAt > Date.now();
        if (!valid) {
          await clearPrivateData();
          if (alive) setAuth('out');
          return;
        }
        if (navigator.onLine) {
          try {
            await request('/session');
          } catch (e) {
            if (e instanceof RequestError && e.status === 401) {
              await clearPrivateData();
              if (alive) setAuth('out');
              return;
            }
          }
        }
        if (alive) setAuth('in');
      } catch {
        if (alive) setAuth('out');
      }
    })();
    const loggedOut = () => {
      client.clear();
      setAuth('out');
    };
    window.addEventListener('passo:logged-out', loggedOut);
    return () => {
      alive = false;
      window.removeEventListener('passo:logged-out', loggedOut);
    };
  }, [client]);
  useEffect(() => {
    if (auth === 'in' && online) void syncPending();
  }, [online, auth]);
  const signOut = async () => {
    const pending = await db.pending.count();
    if (
      pending &&
      !confirm(
        'Ci sono modifiche non sincronizzate. Uscendo perderai queste modifiche e le copie offline. Continuare?',
      )
    )
      return;
    try {
      if (online) await request('/session', 'DELETE');
    } catch {
      /* Local privacy cleanup always runs. */
    }
    await clearPrivateData();
    client.clear();
    setAuth('out');
  };
  return (
    <ErrorBoundary>
      <a className="skip-link" href="#main-content">
        Vai al contenuto
      </a>
      <header className="app-header">
        <div>
          <Link to="/" className="brand" aria-label="Passo, i tuoi viaggi">
            <span className="brand-mark">
              <Footprints size={22} />
            </span>
            passo<span className="brand-period">.</span>
          </Link>
          <div className="header-right">
            {!online && <WifiOff size={16} aria-label="Senza connessione" />}
            {auth === 'in' ? (
              <button
                className="icon-button"
                onClick={() => {
                  void signOut();
                }}
                aria-label="Esci e cancella copie offline"
              >
                <LogOut size={18} />
              </button>
            ) : (
              <span className="header-tag">Un viaggio alla volta</span>
            )}
          </div>
        </div>
      </header>
      <div id="main-content">
        {auth === 'loading' ? (
          <Loading />
        ) : auth === 'out' ? (
          <Login onLogin={() => setAuth('in')} />
        ) : (
          <Routes>
            <Route path="/" element={<TripList />} />
            <Route path="/trips/:tripId/*" element={<TripShell />}>
              <Route index element={<Overview />} />
              <Route path="steps/:stepId" element={<Details />} />
              <Route path="tickets" element={<Wallet />} />
              <Route
                path="tickets/:ticketId"
                element={
                  <Suspense fallback={<Loading message="Apriamo i biglietti…" />}>
                    <TicketViewer />
                  </Suspense>
                }
              />
              <Route path="preparation" element={<Preparations />} />
              <Route path="*" element={<ErrorPanel message="Questa pagina non esiste." />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </div>
      {update && (
        <div className="update-banner" role="status">
          <span>Una nuova versione di Passo è pronta.</span>
          <button onClick={update}>Aggiorna</button>
          <button onClick={() => setUpdate(null)}>Più tardi</button>
        </div>
      )}
    </ErrorBoundary>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await request<{ expiresAt: number }>('/session', 'POST', { key: key.trim() });
      await db.meta.put({ id: 'session', value: session });
      setKey('');
      onLogin();
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Accesso non riuscito');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page login-page">
      <div className="login-visual" aria-hidden="true">
        <div className="login-path" />
        <span className="login-pin first">
          <MapPinMark />
        </span>
        <span className="login-pin middle">
          <Footprints size={30} />
        </span>
        <span className="login-pin last">
          <Compass size={32} />
        </span>
      </div>
      <p className="eyebrow">LA STRADA È GIÀ QUI</p>
      <h1>
        Ogni viaggio,
        <br />
        un passo alla volta.
      </h1>
      <p className="login-description">
        Il programma, le piccole scoperte lungo la strada e i vostri biglietti. Tutto insieme, anche
        quando manca la connessione.
      </p>
      <form
        className="login-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label htmlFor="access-key">
          <LockKeyhole size={16} />
          La vostra chiave di accesso
        </label>
        <input
          id="access-key"
          name="access-key"
          type="password"
          autoComplete="current-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Inserisci la chiave del viaggio"
          required
          maxLength={256}
        />
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
        <button className="button full" type="submit" disabled={busy}>
          {busy ? 'Un momento…' : 'Apri i tuoi viaggi'}
          <ArrowRight size={18} />
        </button>
      </form>
      <p className="login-footnote">
        <LockKeyhole size={12} />
        Uno spazio privato, solo per voi.
      </p>
    </main>
  );
}
function MapPinMark() {
  return (
    <svg viewBox="0 0 40 40" width="32" height="32" fill="none" aria-hidden="true">
      <path
        d="M20 35S7 24 7 15a13 13 0 0 1 26 0c0 9-13 20-13 20Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle cx="20" cy="15" r="4" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function TripList() {
  const query = useQuery({
    queryKey: ['trips'],
    queryFn: loadTrips,
    staleTime: 60000,
    retry: false,
  });
  if (query.isPending) return <Loading />;
  if (query.error)
    return (
      <ErrorPanel
        message={(query.error as Error).message}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  return (
    <main className="page trip-list-page">
      <p className="eyebrow">IL MONDO, UN PO’ ALLA VOLTA</p>
      <h1>Dove si va?</h1>
      <p className="muted list-intro">I vostri viaggi, pronti da vivere.</p>
      {query.data?.length ? (
        <div className="trip-grid">
          {[...query.data]
            .sort((a, b) => a.startDate.localeCompare(b.startDate))
            .map((trip, i) => (
              <Link className="trip-cover" key={trip.id} to={`/trips/${trip.id}`}>
                <div className="trip-cover-top">
                  <span className="eyebrow">{trip.destinations[0]}</span>
                  <ArrowUpRight size={24} />
                </div>
                <div className={`cover-sketch sketch-${i % 2}`} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <h2>
                  {trip.title}
                  <span>.</span>
                </h2>
                <p>{trip.subtitle}</p>
                <div className="trip-cover-meta">
                  <span>
                    <CalendarDays size={15} />
                    {new Date(trip.startDate + 'T12:00:00Z').toLocaleDateString('it-IT', {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    })}{' '}
                    –{' '}
                    {new Date(trip.endDate + 'T12:00:00Z').toLocaleDateString('it-IT', {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    })}
                  </span>
                  <span>
                    <Users size={15} />
                    {trip.travellers}
                  </span>
                </div>
                <div className="cover-open">
                  Il viaggio vi aspetta
                  <ArrowRight size={17} />
                </div>
              </Link>
            ))}
        </div>
      ) : (
        <div className="empty">
          <Compass size={38} />
          <h2>La prossima avventura comincia qui.</h2>
          <p>
            {navigator.onLine
              ? 'Aggiungi il primo viaggio con l’agente.'
              : 'Non ci sono viaggi salvati su questo telefono. Collegati per scaricarli.'}
          </p>
        </div>
      )}
      <p className="notebook-footer">Una buona strada lascia spazio alle sorprese.</p>
    </main>
  );
}
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="empty" role="alert">
        <h1>Qualcosa si è fermato.</h1>
        <p>Ricarica la pagina per riprendere il viaggio.</p>
        <button className="button" onClick={() => location.reload()}>
          Ricarica
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
