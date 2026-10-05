import type { Context } from 'hono';
import { ApiError } from './storage.js';

// Supplemental process-local throttling. Vercel WAF must cover distributed traffic;
// these counters must never be used as a financial spending limit.
export function createThrottle(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (c: Context, bucket: 'login' | 'write' | 'rates' | 'ai' | 'ai-admin', maximum: number) => {
    const time = now();
    let window = windows.get(bucket);
    if (!window || time - window.start >= 60000) {
      window = { start: time, count: 0 };
      windows.set(bucket, window);
    }
    if (window.count >= maximum) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((window.start + 60000 - time) / 1000))));
      throw new ApiError(429, 'Troppe richieste. Attendi un minuto e riprova.');
    }
    window.count++;
  };
}

// Count actual bytes even if Content-Length is absent or dishonest. Authenticate
// private routes before invoking this function, especially for binary uploads.
export async function limitBody(c: Context, maximum: number, json: boolean) {
  const declared = c.req.header('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new ApiError(413, 'La richiesta è troppo grande.');
  if (!c.req.raw.body) return;
  const reader = c.req.raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, 'La richiesta è troppo grande.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Node adapters may expose an empty stream for bodyless POST/DELETE requests.
  if (
    size > 0 &&
    json &&
    c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    throw new ApiError(415, 'Invia i dati in formato JSON.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  c.req.raw = new Request(c.req.raw, { body: bytes });
}
