import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import api, { type ApiRequest } from '../api/index';
import { hashKey } from '../src/server/auth';
it('preserves HTTPS origin and secure cookies after a native Vercel rewrite', async () => {
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('APP_ACCESS_KEY_HASH', hashKey('adapter-test-key'));
  vi.stubEnv('SESSION_SECRET', 'adapter-test-session-secret-at-least-thirty-two');
  try {
    const req = new IncomingMessage(new Socket()) as ApiRequest & { rawBody: Buffer };
    req.method = 'POST';
    req.url = '/api?route=v1/session';
    req.query = { route: 'v1/session' };
    req.headers = {
      host: 'trip.example',
      origin: 'https://trip.example',
      'content-type': 'application/json',
    };
    req.rawHeaders = [
      'Host',
      'trip.example',
      'Origin',
      'https://trip.example',
      'Content-Type',
      'application/json',
    ];
    req.rawBody = Buffer.from(JSON.stringify({ key: 'adapter-test-key' }));
    const output: Buffer[] = [];
    const res = new ServerResponse(req);
    res.assignSocket(
      new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }) as Socket,
    );
    await api(req, res);
    expect(res.statusCode).toBe(200);
    expect(Buffer.concat(output).toString()).toContain('Secure');
    expect(req.url).toBe('https://trip.example/api/v1/session');
  } finally {
    vi.unstubAllEnvs();
  }
});
