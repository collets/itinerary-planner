import { config } from 'dotenv';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import { createApp } from '../src/server/app';
config({ path: '.env.local', quiet: true });
const api = serve({ fetch: createApp().fetch, port: 3001, hostname: '127.0.0.1' });
const vite = await createServer();
await vite.listen();
vite.printUrls();
const shutdown = async () => {
  api.close();
  await vite.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
