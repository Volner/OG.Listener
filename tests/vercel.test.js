import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createVercelHandler } from '../server/vercel-handler.js';

const ID = '1111111111111111111111';
const COVER = 'https://i.scdn.co/image/verified-vercel-cover';
const ORIGIN = 'https://owner.github.io';

async function serve(t, handler, beforeRequest) {
  const operations = [], errors = [];
  const server = createServer((req, res) => {
    void (async () => {
      await beforeRequest?.(req);
      const operation = handler(req, res);
      operations.push(operation);
      await operation;
    })().catch(error => { errors.push(error); res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await handler.close?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { base: `http://127.0.0.1:${server.address().port}`, operations };
}

async function fixture(t, options = {}, beforeRequest) {
  const { apiOptions, ...rest } = options;
  return serve(t, createVercelHandler({
    env: { CORS_ORIGINS: ORIGIN },
    apiOptions: { requestIntervalMs: 0, providers: {}, ...apiOptions },
    ...rest,
  }), beforeRequest);
}

const post = (base, route, value) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(value),
});

function rawRequest(base, target) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(base), { path: target }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Vercel entry exposes health and API JSON with CORS and security headers', async t => {
  const { base } = await fixture(t);
  const health = await fetch(`${base}/healthz`, { headers: { Origin: ORIGIN } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(await (await fetch(`${base}/healthz`, { method: 'HEAD' })).text(), '');
  assert.equal((await fetch(`${base}/healthz`, { method: 'POST' })).status, 405);
  const status = await fetch(`${base}/api/status`, { headers: { Origin: ORIGIN } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, storage: 'memory', mediaFiles: 0 });
  assert.equal(status.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Origin: 'https://other.example' } })).status, 403);
});

test('Vercel handles a Pages preflight and POST without cookies or archive uploads', async t => {
  const { base } = await fixture(t, { apiOptions: { requestIntervalMs: 0, providers: {
    spotify: async () => ({ artwork: COVER, source: 'Spotify oEmbed' }),
  } } });
  const preflight = await fetch(`${base}/api/catalog/resolve`, { method: 'OPTIONS', headers: {
    Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const response = await post(base, '/api/catalog/resolve', { tracks: [{ id: ID, name: 'Song', artist: 'Artist' }], details: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).entries[ID].artwork, COVER);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await post(base, '/api/upload', { history: 'private' })).status, 410);
});

test('Vercel accepts its already-parsed body without reading an exhausted request stream', async t => {
  const { base } = await fixture(t, { apiOptions: { requestIntervalMs: 0, providers: {
    spotify: async () => ({ artwork: COVER }),
  } } }, async req => {
    if (req.method !== 'POST') return;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
  const response = await post(base, '/api/catalog/resolve', { tracks: [{ id: ID }], details: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).entries[ID].artwork, COVER);
});

test('Vercel preserves original encoded track IDs through nested API routes', async t => {
  const seen = [];
  const { base } = await fixture(t, { apiOptions: { requestIntervalMs: 0, providers: {
    deezer: async track => { seen.push(track.id); return { artwork: COVER, source: 'Deezer' }; },
  } } });
  const ids = ['local:artist name::song', 'local:artist/guest::100% remix', 'local:\u0438\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c::\u043f\u0435\u0441\u043d\u044f'];
  for (const id of ids) {
    const response = await fetch(`${base}/api/tracks/${encodeURIComponent(id)}?title=Song&artist=Artist&apple=false&full=false`);
    assert.equal(response.status, 200, id);
    assert.equal((await response.json()).id, id);
  }
  assert.deepEqual(seen, ids);
});

test('Vercel audience requests accept a host-parsed body and retain provider errors', async t => {
  const { base } = await fixture(t, { env: { CORS_ORIGINS: ORIGIN } }, async req => {
    if (req.method !== 'POST') return;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
  const response = await post(base, '/api/audience/resolve', {
    provider: 'chartmetric', artists: [{ name: 'Artist', firstPlayed: '2024-01-15T00:00:00Z' }],
  });
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'provider_not_configured');
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
});

test('Vercel never serves private files, source code or the frontend build', async t => {
  const { base } = await fixture(t, { apiOptions: { providers: {} } });
  for (const route of [
    '/', '/upload', '/index.html', '/favicon.svg', '/dist/index.html', '/assets/index-AbCdEf12.js',
    '/.env', '/.env.local', '/.git/config', '/src/App.jsx', '/server/local-api.js',
    '/node_modules/react/index.js', '/upload/archives/private.json', '/data/history.json',
    '/api/../.env', '/api/%2e%2e/.env', '/%61pi/status', '/api%2fstatus', '/api/missing',
  ]) {
    const response = await rawRequest(base, route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(response.body, /PRIVATE_SECRET|private-history|createLocalApi|<html/i);
  }
});

test('Vercel awaits provider completion and reuses its public metadata cache across calls', async t => {
  let unblock, started, providerCalls = 0;
  const gate = new Promise(resolve => { unblock = resolve; });
  const providerStarted = new Promise(resolve => { started = resolve; });
  const { base, operations } = await fixture(t, { apiOptions: { requestIntervalMs: 0, providers: {
    spotify: async () => { providerCalls++; started(); await gate; return { artwork: COVER }; },
  } } });
  const body = { tracks: [{ id: ID }], details: false };
  const responsePromise = post(base, '/api/catalog/resolve', body);
  await providerStarted;
  let settled = false;
  const operation = operations.at(-1);
  void operation.then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the handler must not return while providers are still running');
  } finally { unblock(); }
  assert.equal((await responsePromise).status, 200);
  await operation;
  assert.equal(settled, true);
  assert.equal((await post(base, '/api/catalog/resolve', body)).status, 200);
  assert.equal(providerCalls, 1);
});

test('Vercel trusts platform IPs only with the runtime marker and rejects invalid forwarded values', async t => {
  const app = await fixture(t, {
    env: { VERCEL: '1' }, apiOptions: { providers: {}, limits: { requestsPerMinute: 1, burst: 1 } },
  });
  const status = headers => fetch(`${app.base}/api/status`, { headers });
  assert.equal((await status({ 'x-real-ip': '203.0.113.1' })).status, 200);
  assert.equal((await status({ 'x-real-ip': '203.0.113.2' })).status, 200);
  assert.equal((await status({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.4' })).status, 429);
  assert.equal((await status({ 'x-real-ip': 'invalid', 'x-forwarded-for': '192.0.2.4' })).status, 200);
  assert.equal((await status({ 'x-real-ip': '203.0.113.3, 192.0.2.4' })).status, 429);

  const local = await fixture(t, {
    env: { TRUST_PROXY: 'loopback' }, apiOptions: { providers: {}, limits: { requestsPerMinute: 1, burst: 1 } },
  });
  assert.equal((await fetch(`${local.base}/api/status`, { headers: { 'x-real-ip': '203.0.113.1', 'x-vercel-id': 'spoofed', vercel: '1' } })).status, 200);
  assert.equal((await fetch(`${local.base}/api/status`, { headers: { 'x-real-ip': '203.0.113.2', 'x-vercel-id': 'different' } })).status, 429);
});

test('the actual exported Vercel entry retains its limiter between invocations', async t => {
  const keys = ['VERCEL', 'TRUST_PROXY', 'API_BURST', 'API_REQUESTS_PER_MINUTE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.VERCEL = '1';
  process.env.TRUST_PROXY = '*';
  process.env.API_BURST = '1';
  process.env.API_REQUESTS_PER_MINUTE = '1';
  try {
    const { default: handler } = await import('../api/index.js?vercel-entry-test');
    const { base } = await serve(t, handler);
    const status = address => fetch(`${base}/api/status`, { headers: { 'x-real-ip': address } });
    assert.equal((await status('203.0.113.8')).status, 200);
    assert.equal((await status('203.0.113.9')).status, 200);
    const limited = await status('203.0.113.8');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
