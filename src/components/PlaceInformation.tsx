import type { PlaceInformation as Information } from '../domain/place-information';
import { money } from '../domain/trip';
import { EuroEstimate } from './EuroEstimate';

/** Same sourced facts in the review widget and the saved stop detail. */
export function PlaceInformation({ information }: { information: Information }) {
  const citations = (ids: string[]) => (
    <span className="research-citations">
      {ids.map((id) => {
        const source = information.sources.find((s) => s.id === id);
        return source ? (
          <a key={id} href={source.url} target="_blank" rel="noopener noreferrer">
            {source.title}
          </a>
        ) : null;
      })}
    </span>
  );
  return (
    <section className="place-information" aria-label="Informazioni ricercate sul luogo">
      <p className="small muted">
        Consultato il {new Date(information.checkedAt).toLocaleDateString('it-IT')} · visita del{' '}
        {information.visitDate.split('-').reverse().join('/')}. Sintesi AI da fonti pubbliche;
        verifica eventuali variazioni.
      </p>
      {information.description && (
        <div>
          <p>{information.description.text}</p>
          {citations(information.description.sourceIds)}
        </div>
      )}
      {information.openingHours && (
        <div>
          <h4>Orari per la visita</h4>
          <p>{information.openingHours.text}</p>
          {citations(information.openingHours.sourceIds)}
        </div>
      )}
      {information.price && (
        <div>
          <h4>Prezzo indicato</h4>
          <p>
            {information.price.label}: {money(information.price.min, information.price.currency)}
            {information.price.max !== information.price.min
              ? ` – ${money(information.price.max, information.price.currency)}`
              : ''}
            {information.price.basis === 'person' ? ' / persona' : ' / gruppo'}{' '}
            <EuroEstimate
              min={information.price.min}
              max={information.price.max}
              currency={information.price.currency}
            />
          </p>
          {citations(information.price.sourceIds)}
          <p className="small muted">
            Prezzo informativo, non un pagamento o una prenotazione. Non modifica la stima originale
            del viaggio.
          </p>
        </div>
      )}
      {!information.openingHours && (
        <p className="small muted">Aperture per questa data da verificare.</p>
      )}
      {!information.price && <p className="small muted">Prezzo del biglietto da verificare.</p>}
      {(information.details || information.trivia || information.entrance) && (
        <details>
          <summary>Storia, curiosità e informazioni pratiche</summary>
          {(['details', 'trivia', 'entrance'] as const).map(
            (key) =>
              information[key] && (
                <div key={key}>
                  <h4>
                    {
                      {
                        details: 'Da sapere',
                        trivia: 'Uno sguardo in più',
                        entrance: 'Ingresso e accesso',
                      }[key]
                    }
                  </h4>
                  <p>{information[key].text}</p>
                  {citations(information[key].sourceIds)}
                </div>
              ),
          )}
        </details>
      )}
      {(['website', 'bookingUrl'] as const).map(
        (key) =>
          information[key] && (
            <p key={key}>
              <a
                className="text-link"
                href={information[key].url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {key === 'website' ? 'Sito del luogo' : 'Informazioni e prenotazione'}
              </a>{' '}
              {citations(information[key].sourceIds)}
            </p>
          ),
      )}
      {information.warnings.map((warning, i) => (
        <p className="warning-note small" key={i}>
          {warning}
        </p>
      ))}
    </section>
  );
}
