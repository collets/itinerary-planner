import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { ApiError } from './storage.js';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const sameHash = (key: string, hash: string | undefined) => {
  const actual = hashKey(key);
  return (
    !!hash && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(actual), Buffer.from(hash))
  );
};
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new ApiError(503, 'Session credentials have not been configured');
  return new TextEncoder().encode(value);
}
export async function role(c: Context): Promise<'agent' | 'browser' | null> {
  const authorization = c.req.header('Authorization');
  if (authorization)
    return authorization.startsWith('Bearer ') &&
      authorization.length <= 263 &&
      sameHash(authorization.slice(7), process.env.AGENT_API_TOKEN_HASH)
      ? 'agent'
      : null;
  const cookie = getCookie(c, 'passo_session');
  if (!cookie || cookie.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(cookie, secret(), {
      issuer: 'passo',
      audience: 'passo-browser',
      algorithms: ['HS256'],
    });
    const accessHash = process.env.APP_ACCESS_KEY_HASH;
    return /^[a-f0-9]{64}$/.test(accessHash ?? '') && payload.sub === accessHash ? 'browser' : null;
  } catch {
    return null;
  }
}
export async function login(c: Context, key: string) {
  if (!sameHash(key, process.env.APP_ACCESS_KEY_HASH))
    throw new ApiError(401, 'Chiave di accesso non valida');
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(process.env.APP_ACCESS_KEY_HASH!)
    .setIssuer('passo')
    .setAudience('passo-browser')
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secret());
  setCookie(c, 'passo_session', token, {
    httpOnly: true,
    secure: c.req.url.startsWith('https:'),
    sameSite: 'Strict',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return { expiresAt };
}
export function logout(c: Context) {
  deleteCookie(c, 'passo_session', { path: '/', secure: c.req.url.startsWith('https:') });
}
export function checkOrigin(c: Context) {
  const origin = c.req.header('Origin');
  const expected = new URL(c.req.url).origin;
  // Vite proxies to the local API port; only the known dev origin is allowed.
  if (
    origin !== expected &&
    !(
      process.env.NODE_ENV !== 'production' &&
      !process.env.VERCEL &&
      origin === 'http://localhost:5173'
    )
  )
    throw new ApiError(403, 'Same-origin request required');
}
