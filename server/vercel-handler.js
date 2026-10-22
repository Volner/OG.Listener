import { isIP } from 'node:net';
import { createLocalApi } from './local-api.js';
import { createAudienceApi } from './audience.mjs';
import { createCorsPolicy } from './cors.js';

function reply(req, res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
}

// Vercel supplies this header at its own ingress. The caller enables this
// resolver using the trusted runtime environment, never a request header.
function platformClientIp(req) {
  const value = req.headers?.['x-real-ip'];
  if (typeof value !== 'string') return undefined;
  const address = value.trim();
  return isIP(address) ? address : undefined;
}

/** A single metadata API per warm instance; no listener, uploads or static files. */
export function createVercelHandler({ env = process.env, apiOptions = {}, audienceHandler } = {}) {
  const cors = createCorsPolicy(env);
  let api;
  function runtime() {
    if (!api) api = createLocalApi({
      ...apiOptions,
      env,
      // The serverless runtime does not expose a stable socket peer allowlist.
      // Keep ordinary server TRUST_PROXY settings out of this adapter.
      trustProxy: 'none',
      clientIp: env.VERCEL === '1' ? platformClientIp : undefined,
      audienceHandler: audienceHandler ?? createAudienceApi({ env, fetchImpl: apiOptions.fetchImpl }),
    });
    return api;
  }

  async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Rewrites select this function while preserving the original URL. Do not
    // decode opaque local: track identifiers or reconstruct them from query.
    const pathname = (req.url || '').split('?')[0];
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (!isApi && pathname !== '/healthz') return reply(req, res, 404, { error: 'Not found.' });
    try {
      if (pathname === '/healthz') {
        if (cors(req, res)) return;
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.setHeader('Allow', 'GET, HEAD');
          return reply(req, res, 405, { error: 'Method not allowed.' });
        }
        return reply(req, res, 200, { ok: true });
      }
      const current = runtime();
      await current.ready;
      // Await the route itself, including provider work and limiter cleanup.
      // Returning before it settles can freeze a serverless invocation early.
      await current.middleware(req, res, () => reply(req, res, 404, { error: 'API route not found.' }));
    } catch (error) {
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      reply(req, res, error.status === 403 ? 403 : 503, {
        error: error.status === 403 ? 'This origin is not allowed to use the API.' : 'Service unavailable.',
      });
    }
  }
  handler.close = async () => { await api?.close(); };
  return handler;
}
