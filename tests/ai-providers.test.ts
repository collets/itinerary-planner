import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveAiProviders,
  liveProvidersFromEnvironment,
  providerJson,
  modelJsonSchema,
  type LiveAiConfig,
} from '../src/server/ai-live';
import { aiProviders } from '../src/server/ai-config';
import { aiContext, AiRequestSchema, withDiscovery } from '../src/domain/ai';
import { exampleTrip } from '../src/domain/fixture';
import { MockAiProviders } from '../src/server/ai-providers';
import { AiBudgetService } from '../src/server/ai-budget';
import { FileStorage } from '../src/server/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-10-05T12:00:00Z');
// Synthetic unit prices and coordinates. They are not live provider prices or
// coordinates for an actual trip; no test ever reaches a provider.
const config: LiveAiConfig = {
  model: 'unit-test-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
  reasoningEffort: 'none',
  price: {
    id: 'unit-test-price',
    inputPerMillion: 100_000,
    outputPerMillion: 200_000,
    search: 0,
    route: 0,
    expiresAt: '2026-10-10T12:00:00Z',
  },
};
const key = 'unit-test-inference-key-not-a-real-credential',
  routeKey = 'unit-test-routing-key-not-a-real-credential';
const provider = () => new LiveAiProviders(config, key, routeKey, () => now);
const context = () =>
  aiContext(
    exampleTrip(),
    AiRequestSchema.parse({ id: 'test', dayId: 'day-one', text: 'Ritardo di 30 minuti' }),
  );
const result = async () => (await new MockAiProviders().plan(context())).value;
const json = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      value && typeof value === 'object' && 'status' in value
        ? { service_tier: 'default', ...value }
        : value,
    ),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function locatedTrip() {
  const trip = exampleTrip();
  trip.plan.places.forEach((p, i) => {
    p.coordinates = { lat: 45 + i * 0.001, lng: 12 + i * 0.001, verifiedOn: '2026-10-01' };
  });
  return trip;
}
function directions(duration = 600, distance = 800) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          summary: { duration, distance },
          segments: [{ steps: [{ name: 'Synthetic Road' }, { name: '-' }] }],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [12, 45],
            [12.001, 45.001],
          ],
        },
      },
    ],
  };
}

describe('OpenAI Responses adapter contracts', () => {
  it('reserves large-context cache-write exposure and blocks it under the original request cap', async () => {
    const live = new LiveAiProviders(
      {
        ...config,
        contextWindow: 1_050_000,
        maxOutputTokens: 4096,
        reasoningEffort: 'none',
        price: { ...config.price, inputPerMillion: 250_000, outputPerMillion: 750_000 },
      },
      key,
      routeKey,
      () => now,
    );
    const maximum = live.modelBound(context());
    expect(maximum).toBe(265_572);
    const directory = await mkdtemp(join(tmpdir(), 'passo-context-budget-'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const budget = new AiBudgetService(new FileStorage(directory), () => now);
      await budget.configure(true, {
        monthly: 1_000_000,
        daily: 1_000_000,
        request: 250_000,
        operations: 12,
      });
      await budget.start({
        id: 'large-context',
        scope: 'example-trip',
        requestHash: 'a'.repeat(64),
      });
      await expect(
        budget.reserve('large-context', {
          id: 'inference',
          fingerprint: 'b'.repeat(64),
          maxCost: maximum,
        }),
      ).rejects.toMatchObject({ code: 'limit' });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('uses one strict stateless call without hosted tools, browser fields, retries or retained responses', async () => {
    const output = await result();
    const fetch = vi.fn().mockResolvedValue(
      json({
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 200 },
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const live = provider();
    const charged = await live.plan(context(), new AbortController().signal, 'job-correlation');
    expect(charged.value).toEqual(output);
    expect(charged.actualCost).toBe(50);
    expect(live.modelBound(context())).toBe(1024);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      model: 'unit-test-model',
      service_tier: 'default',
      store: false,
      background: false,
      stream: false,
      tools: [],
      truncation: 'disabled',
      max_output_tokens: 1024,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body).not.toHaveProperty('previous_response_id');
    expect(options.headers['X-Client-Request-Id']).toBe('job-correlation');
    expect(options.redirect).toBe('error');
    expect(options.headers.Authorization).toBe(`Bearer ${key}`);
    expect(modelJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['message', 'clarification', 'options'],
    });
  });
  it('preserves a known charge when the model refuses, truncates or produces unusable JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        status: 'incomplete',
        usage: { input_tokens: 100, output_tokens: 1024 },
        output: [{ type: 'message', content: [{ type: 'refusal' }] }],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await provider().plan(context(), new AbortController().signal)).toEqual({
      value: null,
      actualCost: 215,
    });
  });
  it('rejects missing usage and anomalous token usage without retrying the provider', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status: 'completed', output: [] }));
    vi.stubGlobal('fetch', fetch);
    await expect(provider().plan(context(), new AbortController().signal)).rejects.toThrow();
    fetch.mockResolvedValue(
      json({ status: 'completed', usage: { input_tokens: 9000, output_tokens: 0 }, output: [] }),
    );
    await expect(provider().plan(context(), new AbortController().signal)).rejects.toThrow(
      'verified bound',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized context and stale pricing before dispatch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const input = context();
    input.request.text = 'x'.repeat(25000);
    await expect(provider().plan(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid',
    });
    const expired = new LiveAiProviders(
      { ...config, price: { ...config.price, expiresAt: '2020-01-01T00:00:00Z' } },
      key,
      routeKey,
      () => now,
    );
    expect(() => expired.modelBound(context())).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects unpriced processing tiers rather than settling at standard prices', async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        status: 'completed',
        service_tier: 'priority',
        usage: { input_tokens: 100, output_tokens: 10 },
        output: [],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(provider().plan(context(), new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe('bounded routing and secondary-source research', () => {
  it('uses the current HeiGIT endpoint, provider geometry and measured detour rather than model geometry', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(directions(600)))
      .mockResolvedValueOnce(json(directions(900, 1200)));
    vi.stubGlobal('fetch', fetch);
    const trip = locatedTrip();
    const charged = await provider().route(
      { fromPlaceId: 'blue-square', toPlaceId: 'blue-museum', poiPlaceIds: ['blue-garden'] },
      trip,
      new AbortController().signal,
    );
    expect(charged.actualCost).toBe(0);
    expect(charged.value).toMatchObject({
      durationMinutes: 15,
      directMinutes: 10,
      extraWalkingMinutes: 5,
      distanceKm: 1.2,
      streets: ['Synthetic Road'],
      estimate: false,
      geometry: [
        [12, 45],
        [12.001, 45.001],
      ],
      pois: [{ placeId: 'blue-garden', detourMinutes: 5, visitMinutes: 5 }],
    });
    expect(charged.value.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '© openrouteservice by HeiGIT | Data from OpenStreetMap',
        }),
        expect.objectContaining({ url: 'https://creativecommons.org/licenses/by-sa/4.0/' }),
      ]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe(
      'https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson',
    );
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.coordinates).toEqual([
      [12, 45],
      [12.002, 45.002],
      [12.001, 45.001],
    ]);
  });
  it('does not invent coordinates or call routing for stale, unknown or faraway places', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const query = { fromPlaceId: 'blue-square', toPlaceId: 'blue-museum', poiPlaceIds: [] };
    await expect(
      provider().route(query, exampleTrip(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid' });
    const trip = locatedTrip();
    trip.plan.places[1].coordinates!.verifiedOn = '2020-01-01';
    expect(() => provider().validateRoute(query, trip)).toThrow();
    trip.plan.places[1].coordinates = { lat: -40, lng: -100, verifiedOn: '2026-10-01' };
    expect(() => provider().validateRoute(query, trip)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends only public coordinates to research and keeps secondary-source evidence distinct from opening-hours verification', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          query: {
            geosearch: [
              { pageid: 123, title: 'Synthetic Monument', lat: 45.001, lon: 12.001, dist: 50 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          query: {
            pages: {
              '123': {
                pageid: 123,
                title: 'Synthetic Monument',
                extract: 'A fictional public landmark used in this test.',
              },
            },
          },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const trip = locatedTrip();
    const input = context();
    input.request.text = 'SECRET_PERSON_AND_QUESTION';
    const discovery = (await provider().discover(input, trip, new AbortController().signal)).value;
    expect(discovery.places[0]).toMatchObject({
      name: 'Synthetic Monument',
      coordinates: { lat: 45.001, lng: 12.001, verifiedOn: '2026-10-05' },
      openingHours: 'Da verificare.',
    });
    expect(discovery.sources[0]).toMatchObject({
      status: 'verified_secondary',
      url: 'https://it.wikipedia.org/?curid=123',
    });
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain('SECRET');
      expect(init.headers).not.toHaveProperty('Authorization');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(withDiscovery(trip, discovery).plan.places).toHaveLength(4);
  });
  it('limits the response body and refuses unexpected destinations and redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('x'.repeat(1000)));
    vi.stubGlobal('fetch', fetch);
    await expect(
      providerJson('https://api.openai.com/v1/responses', {}, new AbortController().signal, 50),
    ).rejects.toThrow('exceeds limit');
    await expect(
      providerJson('http://localhost/private', {}, new AbortController().signal),
    ).rejects.toThrow('destination rejected');
    await expect(
      providerJson('https://attacker.example/', {}, new AbortController().signal),
    ).rejects.toThrow('destination rejected');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
});
describe('private provider failure diagnostics', () => {
  it('reports failure categories without disclosing credentials, URLs or error bodies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('SECRET provider response', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      providerJson(
        'https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson?private=SECRET',
        { headers: { Authorization: 'SECRET credential' }, body: 'SECRET payload' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Provider rejected request');
    expect(warn).toHaveBeenCalledWith('AI provider failure', {
      provider: 'api.heigit.org',
      category: 'http',
      status: 403,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    fetch.mockRejectedValueOnce(new TypeError('SECRET transport exception'));
    await expect(
      providerJson(
        'https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson',
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('SECRET transport exception');
    expect(warn).toHaveBeenLastCalledWith('AI provider failure', {
      provider: 'api.heigit.org',
      category: 'network',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
describe('owner-only provider activation gates', () => {
  it('does not infer live access from keys alone or reuse ordinary staging storage', () => {
    vi.stubEnv('AI_MODE', 'live');
    vi.stubEnv('OPENAI_API_KEY', key);
    vi.stubEnv('OPENROUTESERVICE_API_KEY', routeKey);
    vi.stubEnv(
      'AI_PRICING_JSON',
      JSON.stringify({
        ...config,
        price: { ...config.price, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() },
      }),
    );
    expect(liveProvidersFromEnvironment()).toBeUndefined();
    for (const name of [
      'AI_LIVE_ENABLED',
      'AI_PROVIDER_SPEND_CAP_CONFIRMED',
      'AI_ROUTING_FREE_PLAN_CONFIRMED',
    ])
      vi.stubEnv(name, 'true');
    expect(liveProvidersFromEnvironment()?.mode).toBe('live');
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('APP_ENVIRONMENT', 'staging');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('AI_PRODUCTION_ENABLED', 'true');
    expect(aiProviders()?.mode).toBe('live');
  });
  it('permits mock previews only after the same isolation checks as the build guard', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('AI_MODE', 'mock');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'feature/ai-assistance');
    vi.stubEnv('AI_PREVIEW_ENABLED', 'true');
    vi.stubEnv('AI_PREVIEW_PROJECT_ID', 'prj_ai');
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_ai');
    vi.stubEnv('APP_ENVIRONMENT', 'ai-preview');
    vi.stubEnv('STORAGE_DRIVER', 'blob');
    vi.stubEnv('AI_PREVIEW_STORE_ID', 'store_new');
    vi.stubEnv('BLOB_STORE_ID', 'new');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    vi.stubEnv('STAGING_SEED', '');
    expect(aiProviders()?.mode).toBe('mock');
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_shared');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_ai');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'staging');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('AI_STAGING_BRANCH_ENABLED', 'true');
    expect(aiProviders()?.mode).toBe('mock');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'unreviewed');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'staging');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('AI_PRODUCTION_ENABLED', 'true');
    expect(aiProviders()).toBeUndefined();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('BLOB_STORE_ID', 'staging');
    expect(aiProviders()).toBeUndefined();
  });
});
