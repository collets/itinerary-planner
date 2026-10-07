import { afterEach, describe, expect, it, vi } from 'vitest';
import { information } from './fixtures/place-information';
import {
  readResearch,
  researchBound,
  researchInputBound,
  researchPrice,
} from '../src/server/ai-enrichment';
import { LiveAiProviders, type LiveAiConfig } from '../src/server/ai-live';

const now = Date.parse('2026-10-05T12:00:00Z');
const query = { name: 'Museo sintetico', lat: 45, lng: 12, visitDate: '2026-11-12' };
const config: LiveAiConfig = {
  model: 'unit-test-model',
  contextWindow: 1050000,
  maxOutputTokens: 4096,
  reasoningEffort: 'none',
  price: {
    id: 'synthetic',
    inputPerMillion: 250000,
    outputPerMillion: 750000,
    search: 0,
    route: 0,
    expiresAt: '2026-10-10T12:00:00Z',
  },
  enrichment: { search: 10000, expiresAt: '2026-10-08T12:00:00Z' },
};
const price = researchPrice(config.price, config.enrichment!);
const provider = () =>
  new LiveAiProviders(
    config,
    'not-real-inference-key-000000',
    'not-real-routing-key-000000',
    () => now,
  );
function response() {
  const { checkedAt: _checkedAt, visitDate: _visitDate, ...facts } = information();
  void _checkedAt;
  void _visitDate;
  return {
    status: 'completed',
    service_tier: 'default',
    usage: { input_tokens: 1000, output_tokens: 500 },
    output: [
      {
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', sources: [{ url: 'https://museum.example/' }] },
      },
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(facts), annotations: [] }],
      },
    ],
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Bounded hosted research', () => {
  it('reserves every search/model pass, and uses the earlier price expiry', () => {
    expect(researchInputBound(1050000)).toBe(384000);
    expect(researchBound(price, 1050000, 4096, now)).toBe(119072);
    expect(price.expiresAt).toBe('2026-10-08T12:00:00.000Z');
    expect(() => researchBound(price, 1050000, 4096, Date.parse(price.expiresAt))).toThrow();
  });
  it('sends only a public identity, enforces hosted call ceilings and never dispatches arbitrary URLs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await provider().enrich(
      query,
      new AbortController().signal,
      'persisted-operation',
    );
    expect(result.value).toEqual(information());
    expect(result.actualCost).toBe(10625);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    expect(JSON.parse(body.input)).toEqual(query);
    expect(body.max_tool_calls).toBe(2);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tools).toEqual([
      { type: 'web_search', search_context_size: 'low', external_web_access: true },
    ]);
    expect(JSON.stringify(body.text.format.schema)).not.toContain('"format":"uri"');
    expect(body.store).toBe(false);
    expect(body.truncation).toBe('disabled');
    expect(init.headers['X-Client-Request-Id']).toBe('persisted-operation');
    expect(init.redirect).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects uncited claims but still returns known costs without logging private text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = response();
    raw.output[0].action!.sources![0].url = 'https://different.example/';
    const facts = information();
    facts.description!.text = 'SECRET input';
    const { checkedAt: _checkedAt, visitDate: _visitDate, ...researched } = facts;
    void _checkedAt;
    void _visitDate;
    raw.output[1].content![0].text = JSON.stringify(researched);
    const result = readResearch(raw, query, price, 1050000, 4096, now);
    expect(result).toEqual({ value: null, actualCost: 10625 });
    expect(warn).toHaveBeenCalledWith('AI research reply rejected', { category: 'citations' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });
  it('settles incomplete/malformed output and conservatively counts all tool actions', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = response();
    raw.status = 'incomplete';
    expect(readResearch(raw, query, price, 1050000, 4096, now)).toEqual({
      value: null,
      actualCost: 10625,
    });
    raw.status = 'completed';
    raw.output[1].content![0].text = '{';
    expect(readResearch(raw, query, price, 1050000, 4096, now).actualCost).toBe(10625);
    raw.output.push({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', sources: [] },
    });
    expect(readResearch(raw, query, price, 1050000, 4096, now).actualCost).toBe(20625);
    raw.output.push({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources: [] },
    });
    expect(() => readResearch(raw, query, price, 1050000, 4096, now)).toThrow('bound');
  });
  it('canonicalizes public tracking links against real tool evidence before validation', () => {
    const raw = response();
    const facts = JSON.parse(raw.output[1].content![0].text!);
    facts.sources[0].url = 'https://museum.example/?utm_source=search#visit';
    raw.output[0].action!.sources![0].url = facts.sources[0].url;
    facts.website.url = facts.sources[0].url;
    raw.output[1].content![0].text = JSON.stringify(facts);
    const result = readResearch(raw, query, price, 1050000, 4096, now);
    expect(result.value?.sources[0].url).toBe('https://museum.example/');
    expect(result.value?.website?.url).toBe('https://museum.example/');
    facts.sources[0].url = 'https://localhost/private';
    raw.output[1].content![0].text = JSON.stringify(facts);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readResearch(raw, query, price, 1050000, 4096, now).value).toBeNull();
  });
  it('does not grant hosted research with missing or expired prices', async () => {
    const noResearch = new LiveAiProviders(
      { ...config, enrichment: undefined },
      'not-real-inference-key-000000',
      'not-real-routing-key-000000',
      () => now,
    );
    expect(noResearch.informationAvailable).toBe(false);
    expect(() => noResearch.enrichmentBound()).toThrow();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      provider().enrich({ ...query, name: 'https://SECRET' }, new AbortController().signal, 'test'),
    ).rejects.toThrow('nome pubblico');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('researches a public name and destination without coordinates, requiring a cited identified place', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = response(),
      query = { name: 'Museo sintetico', area: 'Borgo Blu', visitDate: '2026-11-12' };
    expect(readResearch(raw, query, price, 1050000, 4096, now)).toEqual({
      value: null,
      actualCost: 10625,
    });
    const facts = JSON.parse(raw.output[1].content![0].text!);
    facts.identifiedPlace = { text: 'Museo sintetico, Borgo Blu', sourceIds: ['official'] };
    raw.output[1].content![0].text = JSON.stringify(facts);
    expect(readResearch(raw, query, price, 1050000, 4096, now).value?.identifiedPlace).toEqual(
      facts.identifiedPlace,
    );
    facts.identifiedPlace.sourceIds = ['unseen'];
    raw.output[1].content![0].text = JSON.stringify(facts);
    expect(readResearch(raw, query, price, 1050000, 4096, now).value).toBeNull();
  });
});
