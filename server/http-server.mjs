import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLocalApi } from './local-api.js';
import { createAudienceApi } from './audience.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const HASHED_ASSET = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|jpe?g|webp|avif|ico|woff2?|ttf|otf)$/i;
const CSP = [
  "default-src 'self'", "script-src 'self'", "connect-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

function headers(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cache-Control', 'no-store');
}

function reply(req, res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Examine the original request target before URL normalization can erase traversal.
function pathname(target = '') {
  const raw = target.split('?')[0];
  if (!raw.startsWith('/') || raw.startsWith('//') || /%2f|%5c/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (/[\\%\u0000-\u0020\u007f]/.test(decoded)) return null;
  if (decoded.split('/').some(segment => segment.startsWith('.'))) return null;
  return decoded;
}

async function assetsFromBuild(distDirectory) {
  const assets = new Map();
  async function add(route, filename, immutable = false) {
    const body = await readFile(filename);
    assets.set(route, {
      body,
      type: CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      cache: immutable ? 'public, max-age=31536000, immutable' : route === '/favicon.svg' ? 'public, max-age=86400' : 'no-cache',
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
    });
  }
  const rootEntries = await readdir(distDirectory, { withFileTypes: true });
  if (!rootEntries.some(entry => entry.name === 'index.html' && entry.isFile())) {
    throw Object.assign(new Error('Build frontend before starting the production server.'), { code: 'DIST_NOT_BUILT' });
  }
  await add('/', path.join(distDirectory, 'index.html'));
  if (rootEntries.some(entry => entry.name === 'favicon.svg' && entry.isFile())) await add('/favicon.svg', path.join(distDirectory, 'favicon.svg'));
  async function scan(directory, route) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Build output only: never follow symlinks or serve source maps / source files.
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) await scan(path.join(directory, entry.name), `${route}/${entry.name}`);
      else if (entry.isFile() && HASHED_ASSET.test(entry.name)) await add(`${route}/${entry.name}`, path.join(directory, entry.name), true);
    }
  }
  if (rootEntries.some(entry => entry.name === 'assets' && entry.isDirectory())) await scan(path.join(distDirectory, 'assets'), '/assets');
  return assets;
}

/** Integrated localhost or standalone API server. No personal history is stored here. */
export async function createProductionServer({
  root = process.cwd(), distDirectory = path.join(root, 'dist'), env = process.env,
  apiOptions = {}, audienceHandler, shutdownTimeoutMs = 10000,
} = {}) {
  const apiOnlyValue = env.API_ONLY ?? '';
  if (!['', 'true', 'false'].includes(apiOnlyValue)) throw new Error('API_ONLY must be true or false.');
  const apiOnly = apiOnlyValue === 'true';
  // Freeze the explicit build asset allowlist at startup. Files later appearing in
  // dist (or private siblings such as upload / .env) can never become public.
  const assets = apiOnly ? new Map() : await assetsFromBuild(distDirectory);
  const api = createLocalApi({
    root, env, ...apiOptions,
    audienceHandler: audienceHandler ?? createAudienceApi({ env, fetchImpl: apiOptions.fetchImpl }),
  });
  await api.ready;
  let stopping = false, closing;
  const server = createServer((req, res) => {
    headers(res);
    // API identifiers are opaque URL segments, including encoded spaces, slashes,
    // Unicode and percent signs in local: IDs. They never select filesystem paths.
    // Match the literal API prefix before decoding; static routes stay strict.
    const rawPath = (req.url || '').split('?')[0];
    const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
    const route = isApi ? rawPath : pathname(req.url);
    if (route === null) return reply(req, res, 404, { error: 'Not found.' });
    if (stopping) {
      res.setHeader('Connection', 'close');
      return reply(req, res, 503, { error: 'Service unavailable.' });
    }
    if (route === '/healthz') {
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return reply(req, res, 405, { error: 'Method not allowed.' }); }
      return reply(req, res, 200, { ok: true });
    }
    if (isApi) {
      try {
        api.middleware(req, res, () => reply(req, res, 404, { error: 'API route not found.' }));
      } catch { reply(req, res, 503, { error: 'Service unavailable.' }); }
      return;
    }
    const asset = assets.get(route === '/upload' ? '/' : route);
    if (!asset) return reply(req, res, 404, { error: 'Not found.' });
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return reply(req, res, 405, { error: 'Method not allowed.' }); }
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Cache-Control', asset.cache);
    res.setHeader('ETag', asset.etag);
    if (req.headers['if-none-match'] === asset.etag) { res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Length', asset.body.length);
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  async function listen({ port = 3000, host = '127.0.0.1' } = {}) {
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', started); reject(error); };
      const started = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', started);
      server.listen(port, host);
    });
    return server.address();
  }
  function close() {
    if (closing) return closing;
    stopping = true;
    let timeout;
    const forced = new Promise(resolve => {
      timeout = setTimeout(() => { server.closeAllConnections(); resolve(); }, shutdownTimeoutMs);
    });
    const connections = new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    closing = Promise.race([Promise.allSettled([connections, api.close()]), forced]).finally(() => clearTimeout(timeout));
    return closing;
  }
  return { server, api, listen, close };
}
