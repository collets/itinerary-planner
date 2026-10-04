import { handle } from '@hono/node-server/vercel';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createApp } from '../src/server/app';
const handler = handle(createApp());
export default async function api(req: VercelRequest, res: VercelResponse) {
  const route = req.query.route;
  if (typeof route === 'string') {
    const url = new URL(req.url ?? '/', 'https://localhost');
    url.searchParams.delete('route');
    req.url = `/api/${route}${url.search}`;
  }
  // Vercel terminates TLS before the Node adapter; preserve the public HTTPS origin.
  if (process.env.VERCEL) req.url = new URL(req.url ?? '/', `https://${req.headers.host}`).href;
  await handler(req, res);
}
