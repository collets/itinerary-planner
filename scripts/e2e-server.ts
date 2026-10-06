import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { preview } from 'vite';
import { exampleTrip } from '../src/domain/fixture';
import { FileStorage } from '../src/server/storage';
import { TripService } from '../src/server/service';
import { hashKey } from '../src/server/auth';
import { createApp } from '../src/server/app';
import { AiService } from '../src/server/ai';
import { MockAiProviders } from '../src/server/ai-providers';
const portOffset = Number(process.env.E2E_PORT_OFFSET ?? 0);
const apiPort = 3001 + portOffset;
const clientPort = 5173 + portOffset;
const controlPort = 3002 + portOffset;
const directory = await mkdtemp(join(tmpdir(), 'passo-e2e-'));
process.env.APP_ACCESS_KEY_HASH = hashKey('e2e-access-key');
process.env.AGENT_API_TOKEN_HASH = hashKey('e2e-agent-token');
process.env.SESSION_SECRET = 'e2e-test-session-secret-more-than-thirty-two';
process.env.STORAGE_DRIVER = 'file';
const trip = exampleTrip();
trip.plan.costs[0].currency = 'PLN';
trip.plan.costs[0].min = 45;
trip.plan.costs[0].max = 55;
const store = new FileStorage(directory),
  service = new TripService(store);
const initial = await service.create(trip.id, trip.plan);
const rate = {
  currency: 'PLN',
  euroPerUnit: 0.234,
  asOf: '2026-10-02',
  fetchedAt: new Date().toISOString(),
  source: 'https://api.frankfurter.dev/v2/providers/ecb/rate/pln/eur',
};
await store.write('rates/pln.json', new TextEncoder().encode(JSON.stringify(rate)), 'create');
await service.mutate(trip.id, initial.etag, (d) => {
  d.state.exchangeRates = [rate];
});
// Synthetic, network-free AI exercises the production UI without paid calls.
const ai = new AiService(service, new MockAiProviders());
await ai.budget.configure(true);
const api = serve({ fetch: createApp(service, ai).fetch, port: apiPort, hostname: '127.0.0.1' });
const client = await preview({
  preview: {
    port: clientPort,
    host: 'localhost',
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
});
// Test-only control port: stopping the origin verifies cache-only navigation in WebKit.
// Playwright 1.63 offline emulation has an upstream service-worker regression (#42775).
let paused = false;
const control = createServer((_request, response) => {
  void (async () => {
    if (_request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    if (_request.url === '/offline' && !paused) {
      await Promise.all([
        new Promise<void>((resolve) => api.close(() => resolve())),
        new Promise<void>((resolve) => client.httpServer.close(() => resolve())),
      ]);
      paused = true;
    } else if (_request.url === '/online' && paused) {
      await Promise.all([
        new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve)),
        new Promise<void>((resolve) => client.httpServer.listen(clientPort, 'localhost', resolve)),
      ]);
      paused = false;
    }
    response.writeHead(200).end('ok');
  })().catch(() => response.writeHead(500).end());
});
control.listen(controlPort, '127.0.0.1');
const close = async () => {
  control.close();
  api.close();
  client.httpServer.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
console.log('Test server ready.');
