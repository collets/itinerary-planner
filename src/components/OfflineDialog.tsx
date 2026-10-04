import { useEffect, useState } from 'react';
import { CheckCircle2, Download, HardDrive, WifiOff } from 'lucide-react';
import { useTrip } from '../client/context';
import { db, forgetTrip } from '../client/db';
import { saveOffline } from '../client/api';
import { Modal } from './Modal';
export function OfflineDialog({ onClose }: { onClose: () => void }) {
  const { trip, online, notify } = useTrip();
  const ready = trip.state.tickets.filter((t) => t.status === 'ready');
  const [selected, setSelected] = useState(ready.map((t) => t.id)),
    [progress, setProgress] = useState<[number, number] | null>(null),
    [error, setError] = useState(''),
    [saved, setSaved] = useState<number | null>(null),
    [usage, setUsage] = useState(0);
  useEffect(() => {
    void db.trips.get(trip.id).then((v) => setSaved(v?.downloaded ? v.savedAt : null));
    void navigator.storage?.estimate?.().then((v) => setUsage(v.usage ?? 0));
  }, [trip.id]);
  const downloading = !!progress && progress[0] !== progress[1];
  const save = async () => {
    setError('');
    try {
      await saveOffline(trip.id, selected, (done, total) => setProgress([done, total]));
      setSaved(Date.now());
      notify('Viaggio pronto offline su questo telefono.');
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : 'Spazio non disponibile. Riprova.');
    }
  };
  return (
    <Modal
      title="Il viaggio, anche offline"
      onClose={() => {
        if (!downloading) onClose();
      }}
    >
      <div className="offline-intro">
        <WifiOff size={30} />
        <p>
          Salva itinerario, percorsi e informazioni su questo telefono. Scegli anche i biglietti da
          portare con te.
        </p>
      </div>
      {ready.length > 0 && (
        <fieldset>
          <legend>Biglietti da salvare</legend>
          {ready.map((t) => (
            <label className="check-row" key={t.id}>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                disabled={downloading}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id),
                  )
                }
              />
              <span>
                {t.title}
                <small>{(t.size / 1024 / 1024).toFixed(1)} MB</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {progress && (
        <div className="download-progress">
          <progress value={progress[0]} max={progress[1]} />
          <p role="status">
            {downloading ? `Download ${progress[0]} di ${progress[1]}…` : 'Download completato'}
          </p>
        </div>
      )}
      {saved && (
        <div className="success-note">
          <CheckCircle2 size={18} />
          <span>Salvato il {new Date(saved).toLocaleString('it-IT')}</span>
        </div>
      )}
      {error && (
        <p className="error-note" role="alert">
          Download incompleto: {error}
        </p>
      )}
      <p className="muted small">
        <HardDrive size={14} /> Spazio utilizzato dall’app: {(usage / 1024 / 1024).toFixed(1)} MB. I
        siti esterni richiedono una connessione.
      </p>
      <button
        className="button full"
        disabled={!online || downloading}
        onClick={() => {
          void save();
        }}
      >
        <Download size={18} />
        {saved ? 'Aggiorna copia offline' : 'Salva viaggio offline'}
      </button>
      {saved && (
        <button
          className="button subtle full"
          disabled={downloading}
          onClick={() => {
            if (
              confirm(
                'Rimuovere la copia offline da questo telefono? Il viaggio online resta disponibile.',
              )
            )
              void forgetTrip(trip.id).then(() => {
                setSaved(null);
                notify('Copia offline rimossa.');
              });
          }}
        >
          Rimuovi copia offline
        </button>
      )}
      <p className="muted small">
        Le copie restano su questo dispositivo. Il browser può liberare spazio; controlla lo stato
        prima di partire.
      </p>
    </Modal>
  );
}
