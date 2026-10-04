import { useTrip } from '../client/context';
export function euroEstimate(min: number, max: number, euroPerUnit: number) {
  const formatter = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  });
  return `≈ ${formatter.format(min * euroPerUnit)}${max !== min ? ' – ' + formatter.format(max * euroPerUnit) : ''}`;
}
export function EuroEstimate({
  min,
  max = min,
  currency,
}: {
  min: number | null;
  max?: number | null;
  currency: string;
}) {
  const { trip } = useTrip();
  const rate = trip.state.exchangeRates.find((r) => r.currency === currency);
  if (!rate || min === null || max === null || currency === 'EUR') return null;
  return (
    <small
      className="euro-estimate"
      title={`Cambio di riferimento del ${rate.asOf}; il cambio effettivo può variare.`}
    >
      {euroEstimate(min, max, rate.euroPerUnit)}
    </small>
  );
}
