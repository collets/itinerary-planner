import { z } from 'zod';
import { ApiError, type Storage } from './storage.js';
export const RateSchema = z.object({
  currency: z.string(),
  euroPerUnit: z.number().positive().finite(),
  asOf: z.iso.date(),
  fetchedAt: z.iso.datetime(),
  source: z.string().url(),
});
export async function exchangeRate(currency: string, store: Storage) {
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'EUR')
    throw new ApiError(400, 'Invalid conversion currency');
  const path = `rates/${currency.toLowerCase()}.json`,
    cached = await store.read(path);
  const previous = cached
    ? RateSchema.parse(JSON.parse(new TextDecoder().decode(cached.body)))
    : undefined;
  if (previous && Date.now() - Date.parse(previous.fetchedAt) < 24 * 60 * 60 * 1000)
    return previous;
  const source = `https://api.frankfurter.dev/v2/providers/ecb/rate/${currency.toLowerCase()}/eur`;
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Exchange rate unavailable');
    const data = z
      .object({
        date: z.iso.date(),
        rate: z.number().positive().finite(),
        base: z.string(),
        quote: z.string(),
      })
      .parse(await response.json());
    if (data.base.toUpperCase() !== currency || data.quote.toUpperCase() !== 'EUR')
      throw new Error('Unexpected exchange rate');
    const rate = RateSchema.parse({
      currency,
      euroPerUnit: data.rate,
      asOf: data.date,
      fetchedAt: new Date().toISOString(),
      source,
    });
    try {
      await store.write(
        path,
        new TextEncoder().encode(JSON.stringify(rate)),
        cached?.etag ?? 'create',
      );
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 412)) throw e;
    }
    return rate;
  } catch {
    if (previous) return previous;
    throw new ApiError(503, 'Cambio euro non disponibile. I prezzi originali restano validi.');
  }
}
