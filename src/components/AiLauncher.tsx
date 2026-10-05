import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, ArrowRight } from 'lucide-react';
import { db } from '../client/db';
import { loadTrips, request } from '../client/api';
import { useOnline } from '../client/context';
import { Modal } from './Modal';

export function AiLauncher() {
  const online = useOnline(),
    location = useLocation(),
    navigate = useNavigate();
  const [cached, setCached] = useState(false),
    [picker, setPicker] = useState(false);
  const config = useQuery({
    queryKey: ['ai-config'],
    queryFn: () => request<{ ai?: { enabled: boolean } }>('/config'),
    enabled: online,
    staleTime: 60_000,
    retry: false,
  });
  const trips = useQuery({
    queryKey: ['trips'],
    queryFn: loadTrips,
    enabled: picker,
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    let alive = true;
    void db.meta.get('config').then((item) => {
      if (alive)
        setCached(!!(item?.value as { ai?: { enabled: boolean } } | undefined)?.ai?.enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!(config.data?.ai?.enabled ?? cached)) return null;
  const openTrip = (path: string) => {
    setPicker(false);
    const params = new URLSearchParams(location.search);
    params.set('assistant', '1');
    navigate(`${path}?${params}`, { replace: path === location.pathname });
  };
  return (
    <>
      <button
        className="icon-button"
        aria-label="Apri assistente di viaggio"
        title="Chiedi aiuto"
        onClick={() =>
          /^\/trips\/[^/]+(?:\/|$)/.test(location.pathname)
            ? openTrip(location.pathname)
            : setPicker(true)
        }
      >
        <Sparkles size={19} />
      </button>
      {picker && (
        <Modal title="Assistente di viaggio" fullScreen onClose={() => setPicker(false)}>
          <div className="ai-trip-picker">
            <p>Quale viaggio rivediamo insieme?</p>
            {trips.isPending && <p role="status">Carico i tuoi viaggi…</p>}
            {trips.error && (
              <p className="error-note" role="alert">
                Non riesco a caricare i viaggi. Controlla la connessione e riprova.
              </p>
            )}
            {trips.data?.map((trip) => (
              <button
                className="button subtle full"
                key={trip.id}
                onClick={() => openTrip(`/trips/${trip.id}`)}
              >
                {trip.title}
                <ArrowRight size={17} />
              </button>
            ))}
            {trips.data?.length === 0 && <p>Non ci sono ancora viaggi da rivedere.</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
