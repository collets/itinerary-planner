/** Application-owned permissions. Provider output cannot extend this registry. */
export const AI_CAPABILITIES = [
  {
    id: 'read_itinerary',
    permission: 'read',
    provider: 'local',
    limit: 60,
    label: 'Programma, margini e attività rimanenti',
  },
  {
    id: 'evaluate_schedule',
    permission: 'read',
    provider: 'local',
    limit: 60,
    label: 'Orari, vincoli e aperture già verificate',
  },
  {
    id: 'calculate_costs',
    permission: 'read',
    provider: 'local',
    limit: 2000,
    label: 'Stime dei costi e conversioni salvate',
  },
  {
    id: 'resolve_public_place',
    permission: 'read',
    provider: 'discovery',
    limit: 2,
    label: 'Ricerca di luoghi pubblici',
  },
  {
    id: 'research_place_information',
    permission: 'read',
    provider: 'information',
    limit: 2,
    label: 'Orari, prezzi, informazioni e curiosità con fonti',
  },
  {
    id: 'resolve_route_location',
    permission: 'propose',
    provider: 'discovery',
    limit: 2,
    label: 'Posizioni da fonti pubbliche, da confermare',
  },
  {
    id: 'calculate_walking_route',
    permission: 'read',
    provider: 'routing',
    limit: 6,
    label: 'Percorsi a piedi e punti di interesse',
  },
  {
    id: 'build_proposal',
    permission: 'propose',
    provider: 'local',
    limit: 2,
    label: 'Modifiche coordinate nella giornata',
  },
  {
    id: 'undo_change',
    permission: 'propose',
    provider: 'local',
    limit: 1,
    label: 'Annullamento dalla cronologia con anteprima',
  },
] as const;
export const AI_LIMITS = {
  modelRounds: 3,
  lookupRounds: 1,
  informationPlaces: 2,
  routes: 6,
} as const;

/** Documentation contracts for typed planner requests; these are not model-callable writes. */
export const AI_CAPABILITY_CONTRACTS = {
  read_itinerary: {
    input: 'AiRequestSchema dayId / stepId',
    output: 'aiContext allowlisted selected day',
    evidence: 'Saved itinerary; estimates retain their labels.',
    effect: 'Read only; no provider dispatch.',
    fallback: 'Ask for an available day or step.',
  },
  evaluate_schedule: {
    input: 'AiTaskSchema constraints and selected day',
    output: 'dayInsights / validateConstraints',
    evidence: 'Saved times, progress, protected anchors and date-specific opening overlays.',
    effect: 'Read only; final proposal must pass deterministic validation.',
    fallback: 'Explain conflicts or unverified hours; never promise queue or availability.',
  },
  calculate_costs: {
    input: 'Saved base costs, day membership, traveller count, exchange rates',
    output: 'dayInsights costs',
    evidence: 'Original currency and dated saved FX; missing prices remain unknown.',
    effect: 'Read only; actual payments are local UI data and excluded from model input.',
    fallback: 'Show incomplete totals and original currency when conversion is unavailable.',
  },
  resolve_public_place: {
    input: 'AiPlaceLookupsSchema (public name and area)',
    output: 'AiDiscoverySchema',
    evidence: 'Cited public identity, primary Earth coordinates and freshness/distance checks.',
    effect: 'One persisted free lookup round; no trip write.',
    fallback: 'Return ambiguity choices or limited coverage; no invented coordinates.',
  },
  research_place_information: {
    input: 'Validated EnrichmentQuery / informationRequests / placeInformationRequests',
    output: 'PlaceInformationSchema',
    evidence: 'Citations and checked/visit dates; identity required without coordinates.',
    effect: 'Quoted paid research, maximum two public places; facts do not save automatically.',
    fallback: 'Keep unknown fields and show independent facts even if a change is infeasible.',
  },
  resolve_route_location: {
    input: 'locationRequests existing placeId and discovered candidateId',
    output: 'AiLocationUpdateSchema',
    evidence: 'Fresh coordinates and verified sources for a public candidate.',
    effect: 'Proposed coordinate/source overlay; stable identity; explicit apply and scoped undo.',
    fallback: 'Offer information separately; identify building-point/entrance uncertainty.',
  },
  calculate_walking_route: {
    input: 'Validated RouteQuery using evidenced public endpoints / ordered POIs',
    output: 'AiRouteSchema',
    evidence: 'Routing provider, checked date, attribution, measured walking and estimated dwell.',
    effect: 'Maximum six logical routes, each at most five directions; proposed leg changes only.',
    fallback:
      'Explain missing routing evidence; transit and arbitrary private geocoding unavailable.',
  },
  build_proposal: {
    input: 'AiModelOutputSchema options / approved draft / persisted evidence',
    output: 'AiProposalSchema',
    evidence:
      'Deterministic schedule projection, hard constraints, protected anchors and citations.',
    effect:
      'At most two previews; three bounded reasoning passes; apply is an independent user action.',
    fallback: 'Refine within the same cap or explain infeasibility; no partial compound write.',
  },
  undo_change: {
    input: 'historyRequest restricted to available undoChoices IDs',
    output: 'One AiProposalSchema undo command',
    evidence: 'Current fingerprints of a selected-day history entry.',
    effect: 'Version-bound preview; explicit apply; no routing/research or financial reversal.',
    fallback: 'Explain intervening edits or history outside the selected day.',
  },
} satisfies Record<
  (typeof AI_CAPABILITIES)[number]['id'],
  {
    input: string;
    output: string;
    evidence: string;
    effect: string;
    fallback: string;
  }
>;

/** Shared stage contracts: timeout is not proof of zero charge and never enables a retry. */
export const AI_STAGE_POLICY = {
  timeoutMilliseconds: 40000,
  paidRetries: 0,
  failures: ['budget', 'usage', 'evidence', 'conflict', 'provider', 'contract'],
} as const;
