import type { dayInsights } from '../domain/ai-insights';
import { money } from '../domain/trip';

export function AiInsights({ insights }: { insights: ReturnType<typeof dayInsights> }) {
  return (
    <details className="ai-context-widget">
      <summary>Riepilogo della giornata · {insights.date}</summary>
      <p>
        {insights.remainingStepIds.length} attività rimanenti ·{' '}
        {Math.ceil(insights.remainingMinutes)} min di attività · {insights.walkingMinutes} min a
        piedi nel programma
      </p>
      <p className="small">
        Pause e margini nel programma: {insights.gaps.reduce((sum, gap) => sum + gap.minutes, 0)}{' '}
        min. Tempi a piedi indicativi; il passo e le condizioni possono variare.
      </p>
      {Object.entries(insights.costs).map(([currency, row]) => (
        <p className="small" key={currency}>
          Stima per tutti: {money(row.min, currency)}–{money(row.max, currency)} · Pagato:{' '}
          {money(row.paid, currency)}
          {row.euro && currency !== 'EUR' && (
            <>
              {' '}
              · ≈ {money(row.euro.min, 'EUR')}–{money(row.euro.max, 'EUR')} (cambio del{' '}
              {row.euro.asOf})
            </>
          )}
          {row.unknown > 0 && <> · {row.unknown} costi da verificare: totale incompleto</>}
        </p>
      ))}
      {Object.keys(insights.costs).length === 0 && (
        <p className="small">Non ci sono stime dei costi collegate alle tappe della giornata.</p>
      )}
      <p className="small muted">{insights.costNote}</p>
      {insights.issues.map((issue, i) => (
        <p className="small warning-note" key={`${issue.stepId}-${i}`}>
          {issue.message}
        </p>
      ))}
      <p className="small muted">
        Calcolato il {new Date(insights.calculatedAt).toLocaleString('it-IT')} · {insights.timezone}
      </p>
    </details>
  );
}
