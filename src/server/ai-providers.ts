import type {
  AiContext,
  AiModelOutput,
  AiRoute,
  AiDiscovery,
  AiPlaceLookup,
} from '../domain/ai.js';
import { AiPlanError } from '../domain/ai.js';
import type { PlaceInformation } from '../domain/place-information.js';
import type { EnrichmentQuery } from './ai-enrichment.js';
import type { Trip } from '../domain/schema.js';

export type RouteQuery = { fromPlaceId: string; toPlaceId: string; poiPlaceIds: string[] };
export type Charged<T> = { value: T; actualCost: number };
export interface AiProviders {
  mode: 'mock' | 'live';
  modelBound(context: AiContext): number;
  plan(context: AiContext, signal: AbortSignal, requestId?: string): Promise<Charged<unknown>>;
  informationAvailable?: boolean;
  enrichmentBound?(): number;
  enrich?(
    query: EnrichmentQuery,
    signal: AbortSignal,
    requestId: string,
  ): Promise<Charged<PlaceInformation | null>>;
  discoveryBound(): number;
  discover(context: AiContext, trip: Trip, signal: AbortSignal): Promise<Charged<AiDiscovery>>;
  lookup?(queries: AiPlaceLookup[], trip: Trip, signal: AbortSignal): Promise<Charged<AiDiscovery>>;
  routeBound(query: RouteQuery): number;
  validateRoute?(query: RouteQuery, trip: Trip): void;
  route(query: RouteQuery, trip: Trip, signal: AbortSignal): Promise<Charged<AiRoute>>;
}

/** Synthetic demo adapter: never calls a network or invents route facts. */
export class MockAiProviders implements AiProviders {
  mode = 'mock' as const;
  modelBound() {
    return 0;
  }
  routeBound() {
    return 0;
  }
  discoveryBound() {
    return 0;
  }
  async discover(): Promise<Charged<AiDiscovery>> {
    return {
      actualCost: 0,
      value: { places: [], sources: [], notes: ['Demo: nessuna ricerca online.'] },
    };
  }
  async lookup(
    _queries: AiPlaceLookup[],
    _trip: Trip,
    _signal: AbortSignal,
  ): Promise<Charged<AiDiscovery>> {
    return {
      actualCost: 0,
      value: { places: [], sources: [], notes: ['Demo: nessuna ricerca online.'] },
    };
  }
  async plan(
    context: AiContext,
    _signal?: AbortSignal,
    _requestId?: string,
  ): Promise<Charged<AiModelOutput>> {
    const text = context.request.text.toLocaleLowerCase('it');
    if (/sostitui|alternativ|cambia.*(?:tappa|visita)/.test(text))
      return {
        actualCost: 0,
        value: {
          message: 'Vuoi sostituire la tappa scelta con un’altra visita.',
          clarification:
            'La demo non cerca nuove visite e non calcola nuovi collegamenti. Questa richiesta richiede il servizio AI attivo con percorsi verificati. Puoi intanto provare una modifica degli orari della tappa.',
          options: [],
          lookups: [],
        },
      };
    const selected =
      context.steps.find((s) => s.id === context.request.stepId) ??
      context.steps.find((s) => s.kind === 'stop' && !s.completed && !s.fixed && !s.booked);
    const actions: AiModelOutput['options'][number]['actions'] = [];
    const minutes = Number(text.match(/\b(\d{1,3})\s*(?:min|minuti)\b/)?.[1]);
    if (selected && minutes >= 1 && minutes <= 720 && /ritard|dopo|posticip/.test(text))
      actions.push({
        type: 'delay',
        stepId: selected.id,
        placeId: null,
        title: null,
        minutes,
        start: null,
        durationMinutes: null,
        afterId: null,
      });
    else if (selected && /salt|togli|rimuov/.test(text))
      actions.push({
        type: 'skip',
        stepId: selected.id,
        placeId: null,
        title: null,
        minutes: null,
        start: null,
        durationMinutes: null,
        afterId: null,
      });
    else if (selected && minutes >= 1 && minutes <= 720 && /accorci|durat|dedic/.test(text))
      actions.push({
        type: 'timing',
        stepId: selected.id,
        placeId: null,
        title: null,
        minutes: null,
        start: null,
        durationMinutes: minutes,
        afterId: null,
      });
    const routes = /percors|strad|cammin|luoghi|passegg|punti di interesse/.test(text)
      ? context.steps
          .filter(
            (s) => s.kind === 'leg' && 'mode' in s && s.mode === 'walk' && !s.completed && !s.fixed,
          )
          .slice(0, 2)
          .flatMap((s) =>
            'fromPlaceId' in s
              ? [
                  {
                    fromPlaceId: s.fromPlaceId,
                    toPlaceId: s.toPlaceId,
                    poiPlaceIds: 'poiPlaceIds' in s ? s.poiPlaceIds.slice(0, 3) : [],
                  },
                ]
              : [],
          )
      : [];
    const actionable = actions.length > 0 || routes.length > 0;
    return {
      actualCost: 0,
      value: {
        message: 'Modalità dimostrativa: nessuna chiamata AI o ricerca online.',
        lookups: [],
        clarification: actionable
          ? null
          : 'Indica una tappa e un ritardo in minuti, oppure chiedi di rivedere i percorsi. In questa demo uso soltanto i dati già presenti nel viaggio.',
        options: actionable
          ? [
              {
                title: actions.length ? 'Adatta gli orari' : 'Rivedi la passeggiata',
                explanation:
                  'Anteprima basata sul programma esistente. Verifica gli orari e le stime prima di applicarla.',
                actions,
                routes,
                sourceIds: [],
              },
            ]
          : [],
      },
    };
  }
  async route(query: RouteQuery, trip: Trip): Promise<Charged<AiRoute>> {
    const existing = trip.plan.steps.find(
      (s) =>
        s.kind === 'leg' &&
        s.mode === 'walk' &&
        s.fromPlaceId === query.fromPlaceId &&
        s.toPlaceId === query.toPlaceId,
    );
    if (!existing || existing.kind !== 'leg')
      throw new AiPlanError(
        'invalid',
        'Il nuovo collegamento richiede dati di percorso: la demo non inventa distanze o tempi.',
      );
    if (query.poiPlaceIds.some((id) => !existing.pois.some((p) => p.placeId === id)))
      throw new AiPlanError(
        'invalid',
        'La demo può suggerire solo i luoghi già presenti lungo questo percorso.',
      );
    return {
      actualCost: 0,
      value: {
        fromPlaceId: query.fromPlaceId,
        toPlaceId: query.toPlaceId,
        durationMinutes: Math.max(1, existing.durationMinutes),
        distanceKm: existing.distanceKm,
        streets: existing.streets.slice(0, 40),
        pois: existing.pois
          .filter((p) => query.poiPlaceIds.includes(p.placeId))
          .map((p) => ({ ...p, visitMinutes: 0 })),
        estimate: true,
        provider: 'mock',
        checkedAt: new Date().toISOString(),
        directMinutes: Math.max(1, existing.durationMinutes),
        extraWalkingMinutes: 0,
        geometry: [],
        citations: [
          {
            title: 'Itinerario esistente',
            description:
              'Dati ripresi dal viaggio; nessuna verifica online. Il tempo e il tragitto restano stime.',
            estimate: true,
          },
        ],
      },
    };
  }
}
