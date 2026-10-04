import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  RotateCw,
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useTrip, Loading, ErrorPanel } from '../client/context';
import { ticketFile } from '../client/api';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export default function TicketViewer() {
  const { trip } = useTrip();
  const { ticketId } = useParams();
  const ticket = trip.state.tickets.find((t) => t.id === ticketId);
  const [file, setFile] = useState<Blob | null>(null),
    [error, setError] = useState(''),
    [url, setUrl] = useState(''),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0);
  useEffect(() => {
    let alive = true;
    if (ticket)
      void ticketFile(trip.id, ticket)
        .then((file) => {
          if (alive) setFile(file);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [trip.id, ticket]);
  useEffect(() => {
    if (!file) return;
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  if (!ticket) return <ErrorPanel message="Il biglietto non è più disponibile." />;
  return (
    <main className="page ticket-viewer" data-no-swipe>
      <Link className="text-link" to={`/trips/${trip.id}/tickets`}>
        <ArrowLeft size={17} />
        Tutti i biglietti
      </Link>
      <h1>{ticket.title}</h1>
      <p className="muted">
        {ticket.travellerIds
          .map((id) => trip.plan.travellers.find((p) => p.id === id)?.name)
          .join(' · ')}
      </p>
      <div className="viewer-controls">
        <button
          className="icon-button"
          aria-label="Riduci zoom"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
        >
          <ZoomOut size={19} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          className="icon-button"
          aria-label="Aumenta zoom"
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
        >
          <ZoomIn size={19} />
        </button>
        <button
          className="icon-button"
          aria-label="Ruota biglietto"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <RotateCw size={18} />
        </button>
        {url && (
          <a className="button subtle" href={url} download={ticket.filename}>
            <Download size={17} />
            Scarica
          </a>
        )}
      </div>
      {error ? (
        <ErrorPanel message={error} />
      ) : !file ? (
        <Loading message="Apriamo il biglietto…" />
      ) : ticket.contentType === 'application/pdf' ? (
        <Pdf file={file} zoom={zoom} rotation={rotation} />
      ) : (
        <div className="image-ticket">
          <img
            src={url}
            alt={ticket.title}
            style={{
              width: `${zoom * 100}%`,
              maxWidth: 'none',
              transform: `rotate(${rotation}deg)`,
            }}
          />
        </div>
      )}
      <p className="muted small">
        Documento originale. Puoi ingrandirlo per mostrare il codice all’ingresso.
      </p>
    </main>
  );
}
function Pdf({ file, zoom, rotation }: { file: Blob; zoom: number; rotation: number }) {
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let loading: pdfjs.PDFDocumentLoadingTask | undefined,
      alive = true;
    void file
      .arrayBuffer()
      .then((bytes) => {
        if (!alive) return;
        loading = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          cMapUrl: '/pdf-assets/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdf-assets/standard_fonts/',
          wasmUrl: '/pdf-assets/wasm/',
        });
        return loading.promise;
      })
      .then((doc) => {
        if (alive && doc) setDocument(doc);
      })
      .catch(() => {
        if (alive)
          setError('Questo PDF non può essere visualizzato qui. Scaricalo e aprilo sul telefono.');
      });
    return () => {
      alive = false;
      void loading?.destroy();
    };
  }, [file]);
  useEffect(() => {
    if (!document || !canvas.current || !container.current) return;
    let rendering: pdfjs.RenderTask | undefined,
      alive = true;
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (!alive || !canvas.current) return;
        const base = pdfPage.getViewport({ scale: 1, rotation });
        const width = container.current!.clientWidth - 24;
        const scale = Math.min(1.4, width / base.width) * zoom;
        const viewport = pdfPage.getViewport({
          scale: scale * Math.min(window.devicePixelRatio || 1, 2),
          rotation,
        });
        const element = canvas.current;
        element.width = viewport.width;
        element.height = viewport.height;
        element.style.width = `${base.width * scale}px`;
        element.style.height = `${base.height * scale}px`;
        rendering = pdfPage.render({
          canvas: element,
          canvasContext: element.getContext('2d')!,
          viewport,
        });
        return rendering.promise;
      })
      .catch((e) => {
        if (alive && e?.name !== 'RenderingCancelledException')
          setError('Visualizzazione non riuscita. Prova a scaricare il documento.');
      });
    return () => {
      alive = false;
      rendering?.cancel();
    };
  }, [document, page, zoom, rotation]);
  return (
    <>
      <div className="pdf-container" ref={container}>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <canvas ref={canvas} aria-label={`Pagina ${page} del biglietto`} />
        )}
      </div>
      {document && document.numPages > 1 && (
        <div className="pdf-pagination">
          <button
            className="icon-button"
            aria-label="Pagina PDF precedente"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft />
          </button>
          <span>
            Pagina {page} di {document.numPages}
          </span>
          <button
            className="icon-button"
            aria-label="Pagina PDF successiva"
            disabled={page === document.numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </>
  );
}
