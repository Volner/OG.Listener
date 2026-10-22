import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProductionServer } from '../server/http-server.mjs';

const ID1 = '1111111111111111111111', ID2 = '2222222222222222222222';
const HTML = '<!doctype html><html><body>OG.Listener<script type="module" src="/assets/index-AbCdEf12.js"></script></body></html>';

async function fixture(t, apiOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-production-'));
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(dist, 'data'), { recursive: true });
  await mkdir(path.join(dist, 'src'), { recursive: true });
  for (const [name, content] of [
    ['index.html', HTML], ['favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['assets/index-AbCdEf12.js', 'globalThis.ogListener = true;'],
    ['assets/index-AbCdEf12.css', 'body{color:white}'],
    ['assets/index-AbCdEf12.js.map', 'private-source-map'],
    ['assets/source.js', 'unhashed-source'], ['.env', 'PRIVATE_SECRET=value'],
    ['data/history.json', '{"events":["private-history"]}'],
    ['data/catalog.json', '{"private":"catalog"}'], ['src/App.jsx', 'private-source'],
  ]) await writeFile(path.join(dist, name), content);
  const app = await createProductionServer({
    root, env: {}, audienceHandler: async () => false,
    apiOptions: { requestIntervalMs: 0, providers: {}, ...apiOptions }, shutdownTimeoutMs: 100,
  });
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dist, base, app };
}

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

test('production serves built entry routes with security headers, asset types, cache validation and HEAD', async t => {
  const { base, app } = await fixture(t);
  for (const route of ['/', '/upload']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), HTML);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /media-src 'self' https:/);
    assert.doesNotMatch(csp, /unsafe-eval|huggingface|jsdelivr/);
  }
  const asset = await fetch(`${base}/assets/index-AbCdEf12.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(asset.headers.get('cache-control'), /max-age=31536000, immutable/);
  const head = await fetch(`${base}/assets/index-AbCdEf12.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('content-length'), asset.headers.get('content-length'));
  const unchanged = await fetch(`${base}/assets/index-AbCdEf12.js`, { headers: { 'If-None-Match': asset.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal((await fetch(`${base}/assets/index-AbCdEf12.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  const health = await fetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(app.server.requestTimeout, 30000);
  assert.equal(app.server.headersTimeout, 10000);
});

test('public server never exposes private data, source, arbitrary dist files, traversal or source maps', async t => {
  const { base, dist } = await fixture(t);
  const blocked = [
    '/data/history.json', '/data/catalog.json', '/.env', '/.env.local', '/.git/config',
    '/src/App.jsx', '/server/local-api.js', '/node_modules/react/index.js',
    '/upload/archives/private.json', '/upload/cache/catalog.json', '/private/history.json',
    '/assets/index-AbCdEf12.js.map', '/assets/source.js', '/missing',
    '/../.env', '/assets/../../.env', '/%2e%2e/.env', '/%2eenv',
    '/%252e%252e/.env', '/assets%2f..%2fdata/history.json', '/assets%5c..%5c.env',
    '/assets/..\\.env', '//data/history.json', '/%00', '/%zz',
    '/%61pi/catalog/providers', '/api%2fcatalog/providers', '/api/../.env', '/api/%2e%2e/.env',
  ];
  for (const route of blocked) {
    const response = await rawRequest(base, route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(response.body, /private-history|PRIVATE_SECRET|private-source|unhashed-source/);
  }
  // Even valid-looking files appearing after startup are outside the frozen allowlist.
  await writeFile(path.join(dist, 'assets', 'private-AbCdEf12.js'), 'private-late-file');
  assert.equal((await fetch(`${base}/assets/private-AbCdEf12.js`)).status, 404);
});

test('two visitors only receive explicitly requested metadata and cannot enumerate another visitor history', async t => {
  const { base } = await fixture(t, { providers: {
    spotify: async track => ({ artwork: `https://i.scdn.co/image/${track.id}`, source: 'Spotify oEmbed' }),
  } });
  const visit = async (id, label) => {
    const response = await fetch(`${base}/api/catalog/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ tracks: [{ id, name: label, artist: label }], details: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    return response.json();
  };
  const [first, second] = await Promise.all([visit(ID1, 'First visitor'), visit(ID2, 'Second visitor')]);
  assert.deepEqual(Object.keys(first.entries), [ID1]);
  assert.deepEqual(Object.keys(second.entries), [ID2]);
  for (const route of ['/api/catalog', '/api/upload', '/api/history']) {
    const response = await fetch(`${base}${route}`);
    assert.ok([404, 410].includes(response.status), `${route}: ${response.status}`);
    assert.doesNotMatch(await response.text(), new RegExp(`${ID1}|${ID2}|First visitor|Second visitor`));
  }
  const otherOrigin = await fetch(`${base}/api/catalog/providers`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(otherOrigin.status, 403);
});

test('API accepts opaque encoded local track IDs with spaces, Unicode, slashes and percent signs', async t => {
  const seen = [];
  const { base } = await fixture(t, { providers: {
    deezer: async track => {
      seen.push(track.id);
      return { artwork: 'https://i.scdn.co/image/verified-local-track', source: 'Deezer' };
    },
  } });
  const ids = [
    'local:artist name::my song',
    'local:\u0438\u0441\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c::\u043f\u0435\u0441\u043d\u044f',
    'local:artist/guest::song/remix',
    'local:artist::100% song',
  ];
  for (const id of ids) {
    const response = await fetch(`${base}/api/tracks/${encodeURIComponent(id)}?title=Song&artist=Artist&apple=false&full=false`);
    assert.equal(response.status, 200, id);
    const metadata = await response.json();
    assert.equal(metadata.id, id);
    assert.equal(metadata.artwork, 'https://i.scdn.co/image/verified-local-track');
  }
  assert.deepEqual(seen, ids);
});

test('production fails closed without a real build entry and shutdown is idempotent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-unbuilt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'));
  await assert.rejects(createProductionServer({ root }), error => error.code === 'DIST_NOT_BUILT');
  const { app } = await fixture(t);
  await Promise.all([app.close(), app.close()]);
  assert.equal(app.server.listening, false);
});

test('API-only production starts without dist and exposes only health and CORS-enabled API routes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-api-only-'));
  const origin = 'https://owner.github.io';
  const app = await createProductionServer({
    root, env: { API_ONLY: 'true', CORS_ORIGINS: origin },
    apiOptions: { providers: {} }, audienceHandler: async () => false,
  });
  const address = await app.listen({ port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const status = await fetch(`${base}/api/status`, { headers: { Origin: origin } });
  assert.equal(status.status, 200);
  assert.equal(status.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await status.json(), { ok: true, storage: 'memory', mediaFiles: 0 });
  for (const route of ['/', '/upload', '/index.html', '/favicon.svg', '/assets/index-AbCdEf12.js', '/package.json', '/server/start.mjs']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  }
  const preflight = await fetch(`${base}/api/catalog/resolve`, {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
});

test('production rejects ambiguous API_ONLY values before reading build assets', async () => {
  for (const value of ['1', 'yes', 'TRUE', 'false ', true, false]) {
    await assert.rejects(createProductionServer({ env: { API_ONLY: value } }), /API_ONLY must be true or false/);
  }
});

test('graceful shutdown has a deadline even while a client stalls an API request body', async t => {
  const { app } = await fixture(t);
  const socket = connect(app.server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  const disconnected = new Promise(resolve => socket.once('close', resolve));
  socket.write('POST /api/catalog/resolve HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
  // Let the HTTP parser enter the incomplete request before shutting down.
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = performance.now();
  await app.close();
  await disconnected;
  assert.ok(performance.now() - started < 1500);
  assert.equal(app.server.listening, false);
});
