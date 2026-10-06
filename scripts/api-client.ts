/** Private CLI transport; credentials never follow redirects or leave this origin. */
export function apiClient(
  address: string,
  token: string | undefined,
  bypass: string | undefined = process.env.ITINERARY_VERCEL_BYPASS_SECRET,
) {
  let base: URL;
  try {
    base = new URL(address);
  } catch {
    throw new Error('Set a valid API origin');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error(
      'Set an HTTPS API origin or a local development origin without credentials, paths or query strings',
    );
  if (bypass && base.protocol !== 'https:')
    throw new Error('Deployment-protection bypass requires HTTPS');
  const headers = (extra?: HeadersInit) => {
    if (!token) throw new Error('Set the required API credential in an ignored environment file');
    const result = new Headers(extra);
    result.set('Authorization', `Bearer ${token}`);
    if (bypass) result.set('x-vercel-protection-bypass', bypass);
    return result;
  };
  const url = (path: string) => {
    const destination = new URL(path, base);
    if (
      destination.origin !== base.origin ||
      destination.username ||
      destination.password ||
      destination.hash ||
      destination.search ||
      !destination.pathname.startsWith('/api/v2/')
    )
      throw new Error('CLI requests must stay within the configured API origin');
    return destination;
  };
  return {
    base: base.origin,
    headers,
    url,
    fetch: (path: string, init: RequestInit = {}) =>
      fetch(url(path), {
        ...init,
        headers: headers(init.headers),
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(30_000),
      }),
  };
}
