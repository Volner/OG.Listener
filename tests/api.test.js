import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalApi } from '../server/local-api.js';
import { createProviders, ProviderError, artworkUrl, previewUrl, previewExpiration, safeMetadata } from '../server/providers.js';

const ID1 = '1111111111111111111111', ID2 = '2222222222222222222222';
const COVER = 'https://i.scdn.co/image/provider-cover', AUDIO = 'https://cdnt-preview.dzcdn.net/api/verified-preview.mp3';
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-api-')); let api, server, base;
  async function start() { api = createLocalApi({ root, requestIntervalMs: 0, appleIntervalMs: 0, deezerIntervalMs: 0, musicbrainzIntervalMs: 0, ...options }); await api.ready; server = createServer((req, res) => api.middleware(req, res, () => { res.statusCode = 404; res.end(); })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await start(); t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  return { root, get base() { return base; }, get api() { return api; }, get server() { return server; }, async restart() { await stop(); await start(); } };
}
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('visible metadata returns remote URLs, redirects media without fetching bytes, and writes no files', async t => {
  let spotifyCalls = 0, deezerCalls = 0;
  const app = await fixture(t, { fetchImpl: () => assert.fail('API must never fetch media bytes'), providers: {
    spotify: async () => { spotifyCalls++; return { artwork: COVER, artworkSource: 'Spotify oEmbed' }; },
    deezer: async track => { deezerCalls++; return { artwork: 'https://cdn-images.dzcdn.net/images/cover/x.jpg', previewUrl: AUDIO, genres: ['Rock'], source: 'Deezer', matchedTitle: track.name, matchedArtist: track.artist }; },
  } });
  const tracks = [{ id: ID1, name: 'One', artist: 'Artist' }, { id: ID2, name: 'Two', artist: 'Artist' }];
  const response = await post(app.base, '/api/catalog/resolve', { tracks: [...tracks, tracks[0]] }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(Object.keys(result.entries).length, 2); assert.deepEqual(result.errors, []);
  assert.equal(result.entries[ID1].artwork, COVER); assert.equal(result.entries[ID1].artworkLocal, undefined); assert.equal(result.entries[ID1].previewUrl, AUDIO); assert.deepEqual(result.entries[ID1].genres, ['Rock']); assert.equal(spotifyCalls, 2); assert.equal(deezerCalls, 2);
  for (const [route, remote] of [['artwork', COVER], ['audio', AUDIO]]) { const media = await fetch(`${app.base}/api/${route}/${ID1}`, { redirect: 'manual' }); assert.equal(media.status, 302); assert.equal(media.headers.get('location'), remote); assert.equal(media.headers.get('cache-control'), 'no-store'); }
  assert.deepEqual(await readdir(app.root), []); await post(app.base, '/api/catalog/resolve', { tracks }); assert.equal(spotifyCalls, 2); assert.equal(deezerCalls, 2);
  const status = await (await fetch(`${app.base}/api/status`)).json(); assert.deepEqual(status, { ok: true, storage: 'memory', mediaFiles: 0 });
  await app.restart(); assert.equal((await fetch(`${app.base}/api/artwork/${ID1}`, { redirect: 'manual' })).status, 404); assert.deepEqual(await readdir(app.root), []);
});

test('legacy jobs and global catalog listing are removed, batches remain bounded', async t => {
  const app = await fixture(t, { providers: { spotify: () => assert.fail('Legacy jobs must not query providers') } }); const tracks = [{ id: ID1, name: 'One', artist: 'Artist' }];
  for (const route of ['/api/catalog/jobs', '/api/catalog/pause', '/api/catalog/resume']) assert.equal((await post(app.base, route, { tracks })).status, 410);
  assert.equal((await fetch(`${app.base}/api/catalog/jobs`)).status, 410);
  assert.equal((await fetch(`${app.base}/api/catalog?cursor=0`)).status, 410);
  assert.equal((await post(app.base, '/api/catalog/resolve', { tracks: Array.from({ length: 101 }, () => tracks[0]) })).status, 400); assert.deepEqual(await readdir(app.root), []);
});

test('simultaneous visible lookups share one request and permanent misses are negatively cached', async t => {
  let calls = 0; const app = await fixture(t, { providers: { spotify: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); throw new ProviderError('No exact track', { status: 404 }); } } }); const tracks = [{ id: ID1, name: 'Unknown', artist: 'Artist' }];
  await Promise.all([post(app.base, '/api/catalog/resolve', { tracks }), post(app.base, '/api/catalog/resolve', { tracks })]);
  const result = await (await post(app.base, '/api/catalog/resolve', { tracks })).json(); assert.equal(calls, 1); assert.equal(result.errors[0].status, 404); assert.deepEqual(result.entries, {});
});

test('metadata and negative lookups expire in memory; expiring CDN tokens cap cache lifetimes', async t => {
  let calls = 0; const app = await fixture(t, { metadataTtlMs: 20, negativeTtlMs: 20, providers: { spotify: async track => { calls++; if (track.id === ID2) throw new ProviderError('Missing', { status: 404 }); return { artwork: COVER }; } } });
  const tracks = [{ id: ID1, name: 'One', artist: 'Artist' }, { id: ID2, name: 'Missing', artist: 'Artist' }];
  await post(app.base, '/api/catalog/resolve', { tracks }); assert.equal(calls, 2);
  await new Promise(resolve => setTimeout(resolve, 30)); await post(app.base, '/api/catalog/resolve', { tracks }); assert.equal(calls, 4);
  assert.equal(previewExpiration('https://cdnt-preview.dzcdn.net/x.mp3?hdnea=exp%3D1792534983~acl%3D%2Fx'), 1792534983000);
  assert.equal(previewExpiration(AUDIO), Infinity); assert.deepEqual(await readdir(app.root), []);
});

test('fast covers return before slow genres, while concurrent enrichment reuses their Spotify request', async t => {
  let spotifyCalls = 0, releaseDetails;
  const detailGate = new Promise(resolve => { releaseDetails = resolve; });
  const app = await fixture(t, { providers: {
    spotify: async () => { spotifyCalls++; await new Promise(resolve => setTimeout(resolve, 20)); return { artwork: COVER, source: 'Spotify oEmbed' }; },
    deezer: async () => { await detailGate; return { previewUrl: AUDIO, genres: ['Trap'], source: 'Deezer' }; },
  } });
  const tracks = [{ id: ID1, name: 'One', artist: 'Artist' }];
  const enrichment = post(app.base, '/api/catalog/resolve', { tracks, details: true });
  const fast = await (await post(app.base, '/api/catalog/resolve', { tracks, details: false })).json();
  assert.equal(fast.entries[ID1].artwork, COVER); assert.equal(fast.entries[ID1].genres?.length || 0, 0); assert.equal(spotifyCalls, 1);
  releaseDetails(); const full = await (await enrichment).json(); assert.deepEqual(full.entries[ID1].genres, ['Trap']); assert.equal(spotifyCalls, 1);
  const cached = await (await post(app.base, '/api/catalog/resolve', { tracks, details: false })).json(); assert.deepEqual(cached.entries[ID1].genres, ['Trap']);
});

test('detail lookup adds Apple audio only when needed and preserves preview attribution', async t => {
  let appleCalls = 0; const app = await fixture(t, { providers: {
    spotify: async () => ({ artwork: COVER, artworkSource: 'Spotify oEmbed', source: 'Spotify oEmbed' }), deezer: async () => { throw new ProviderError('Not found', { status: 404 }); },
    apple: async () => { appleCalls++; return { previewUrl: 'https://audio-ssl.itunes.apple.com/preview', previewSource: 'Apple Music / iTunes', previewExternalUrl: 'https://music.apple.com/us/song/one/123', genres: ['R&B'], source: 'Apple Music / iTunes', matchedArtist: 'Artist' }; },
  } });
  await post(app.base, '/api/catalog/resolve', { tracks: [{ id: ID1, name: 'One', artist: 'Artist' }] }); assert.equal(appleCalls, 0);
  const metadata = await (await fetch(`${app.base}/api/tracks/${ID1}?title=One&artist=Artist`)).json(); assert.equal(metadata.artwork, COVER); assert.equal(metadata.previewSource, 'Apple Music / iTunes'); assert.equal(metadata.previewExternalUrl, 'https://music.apple.com/us/song/one/123'); assert.deepEqual(metadata.genres, ['R&B']);
  await fetch(`${app.base}/api/tracks/${ID1}?title=One&artist=Artist`); assert.equal(appleCalls, 1);
});

test('Deezer matches full title and artist, rejects live versions and shares album genres', async () => {
  let albumCalls = 0; const providers = createProviders({ appleIntervalMs: 0, deezerIntervalMs: 0, fetchImpl: async url => {
    if (url.includes('/album/')) { albumCalls++; return Response.json({ id: 42, genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] } }); }
    return Response.json({ data: [{ title: 'One (Live)', artist: { name: 'Artist' }, preview: AUDIO }, { title: 'One', artist: { name: 'Other' }, preview: AUDIO }, { title: 'ONE!', artist: { name: 'ARTIST' }, preview: AUDIO, duration: 120, album: { id: 42, cover_big: 'https://cdn-images.dzcdn.net/cover.jpg' } }] });
  } });
  const result = await providers.deezer({ name: 'one', artist: 'artist' }); assert.equal(result.matchedArtist, 'ARTIST'); assert.equal(result.matchedTitle, 'ONE!'); assert.equal(result.previewUrl, AUDIO); assert.deepEqual(result.genres, ['Rap/Hip Hop']); await providers.deezer({ name: 'ONE', artist: 'ARTIST' }); assert.equal(albumCalls, 1);
  const none = createProviders({ deezerIntervalMs: 0, fetchImpl: async () => Response.json({ data: [{ title: 'One (Live)', artist: { name: 'Artist' }, preview: AUDIO }] }) }); await assert.rejects(none.deezer({ name: 'One', artist: 'Artist' }), error => error.status === 404);
});

test('only verified HTTPS provider URLs survive metadata; local paths and suffix attacks are removed', () => {
  for (const value of ['http://i.scdn.co/image/x', 'https://scdn.co.evil.test/x', 'https://user:pass@i.scdn.co/x', 'https://i.scdn.co:444/x', '/api/artwork/123', 'blob:https://example.com/id', 'data:image/png;base64,x']) assert.equal(artworkUrl(value), null, value);
  assert.equal(previewUrl('https://itunes.apple.com.evil.test/x'), null); assert.equal(previewUrl(AUDIO), AUDIO);
  assert.deepEqual(safeMetadata({ artwork: COVER, artworkLocal: '/api/artwork/123', previewUrl: 'file:///music.mp3', externalUrl: 'javascript:alert(1)' }), { artwork: COVER });
});

test('automatic artist genre fallback uses curated MusicBrainz genres and refuses ambiguous artists', async () => {
  const mbid = 'cc197bad-dc9c-440d-a5b5-d52ba2e14234';
  const providers = createProviders({ musicbrainzIntervalMs: 0, fetchImpl: async url => url.includes('inc=genres') ? Response.json({ genres: [{ name: 'trap', count: 5 }, { name: 'r&b', count: 2 }, { name: 'unknown', count: 0 }] }) : Response.json({ artists: [{ id: mbid, name: 'ARTIST', tags: [{ name: 'russian', count: 100 }] }] }) });
  assert.deepEqual((await providers.artistGenres('artist!')).genres, ['trap', 'r&b']);
  const ambiguous = createProviders({ musicbrainzIntervalMs: 0, fetchImpl: async () => Response.json({ artists: [{ id: mbid, name: 'Artist' }, { id: mbid, name: 'ARTIST' }] }) });
  assert.deepEqual((await ambiguous.artistGenres('artist')).genres, []);
});

test('cross-origin reads and writes are denied, private archive/cache paths are never served', async t => {
  const app = await fixture(t); for (const [route, method] of [['/api/status', 'GET'], ['/api/catalog/pause', 'POST']]) assert.equal((await fetch(`${app.base}${route}`, { method, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(`${app.base}/api/status`, { headers: { Origin: `ftp://${new URL(app.base).host}` } })).status, 403); for (const route of ['/upload/archives/secret.json', '/upload/cache/catalog.json']) assert.equal((await fetch(`${app.base}${route}`)).status, 403);
});

test('configured frontend origins receive CORS on metadata, provider errors and rate limits without credentials', async t => {
  const origin = 'https://listener.example';
  const app = await fixture(t, { env: { CORS_ORIGINS: `${origin}, https://owner.github.io` }, providers: {} });
  for (const [route, expected] of [['/api/status', 200], [`/api/tracks/${ID1}`, 404], ['/api/missing', 404]]) {
    const response = await fetch(`${app.base}${route}`, { headers: { Origin: origin } });
    assert.equal(response.status, expected, route);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.match(response.headers.get('vary'), /(?:^|,\s*)Origin(?:,|$)/);
    assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
  const limited = await fixture(t, { env: { CORS_ORIGINS: origin }, limits: { burst: 1, requestsPerMinute: 1 } });
  assert.equal((await fetch(`${limited.base}/api/status`, { headers: { Origin: origin } })).status, 200);
  const response = await fetch(`${limited.base}/api/status`, { headers: { Origin: origin } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok((await response.json()).retryAfterSeconds > 0);
});

test('CORS preflight validates exact origins, requested method and headers before admission limits', async t => {
  const origin = 'https://owner.github.io';
  const app = await fixture(t, { env: { CORS_ORIGINS: origin }, limits: { burst: 1, requestsPerMinute: 1 } });
  const headers = { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${app.base}/api/catalog/resolve`, { method: 'OPTIONS', headers });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, HEAD, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
  for (const denied of ['https://owner.github.io.evil.example', `${origin}/repository`, 'null', 'ftp://owner.github.io']) {
    const response = await fetch(`${app.base}/api/catalog/resolve`, { method: 'OPTIONS', headers: { ...headers, Origin: denied } });
    assert.equal(response.status, 403, denied);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const invalid of [
    { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Headers': 'Content-Type, Authorization' },
    { 'Access-Control-Request-Headers': 'X-File-Name' },
  ]) {
    const response = await fetch(`${app.base}/api/catalog/resolve`, { method: 'OPTIONS', headers: { ...headers, ...invalid } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-methods'), null);
  }
  const missingMethod = await fetch(`${app.base}/api/status`, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(missingMethod.status, 403);
  assert.equal(app.api.limiter.snapshot().ipEntries, 0);
  // Invalid origins and preflights have not consumed the visitor's first slot.
  assert.equal((await fetch(`${app.base}/api/status`)).status, 200);
});

test('CORS configuration rejects wildcard, path, credential and non-HTTPS public origins at startup', async () => {
  for (const origin of [
    '*', 'https://*.example', 'null', 'not-an-origin', 'https://owner.github.io/repository',
    'https://owner.github.io/', 'https://user:pass@owner.github.io', 'https://owner.github.io?query=1',
    'https://owner.github.io#fragment', 'http://public.example', 'ftp://localhost',
    'https://owner.github.io,', 'https://owner.github.io,,https://other.example',
  ]) {
    assert.throws(() => createLocalApi({ env: { CORS_ORIGINS: origin }, providers: {} }), /CORS_ORIGINS/, origin);
  }
  const api = createLocalApi({ env: { CORS_ORIGINS: 'https://owner.github.io, http://localhost:5173, http://127.0.0.1:3000, http://[::1]:5173' }, providers: {} });
  await api.close();
});

test('archive upload is removed and status never discloses filenames or visitor requests', async t => {
  const app = await fixture(t, { providers: { spotify: async () => ({ artwork: COVER, firstPlayed: '2020-01-01', plays: 999, userId: 'private-user', filename: 'private-archive.zip', events: ['private'] }) } });
  const response = await fetch(`${app.base}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'private-archive.json' }, body: '[{"private":"history"}]' });
  assert.equal(response.status, 410); assert.deepEqual(await readdir(app.root), []);
  const result = await (await post(app.base, '/api/catalog/resolve', { tracks: [{ id: ID1, name: 'One', artist: 'Artist', firstPlayed: '2020-01-01', plays: 999, userId: 'private-user' }], history: ['private'] })).json();
  assert.deepEqual(result.entries[ID1], { id: ID1, artwork: COVER, genres: [], artistGenres: [] });
  const status = await (await fetch(`${app.base}/api/status`)).json(); assert.deepEqual(status, { ok: true, storage: 'memory', mediaFiles: 0 });
  assert.equal((await fetch(`${app.base}/api/catalog`)).status, 410); assert.deepEqual(await readdir(app.root), []);
});

test('per-IP burst returns Retry-After and ignores spoofed forwarding headers by default', async t => {
  const app = await fixture(t, { limits: { burst: 1, requestsPerMinute: 1 } });
  assert.equal((await fetch(`${app.base}/api/status`)).status, 200);
  const response = await fetch(`${app.base}/api/status`, { headers: { 'X-Forwarded-For': '198.51.100.5', 'X-Real-IP': '198.51.100.6' } });
  assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok((await response.json()).retryAfterSeconds > 0); assert.equal(app.api.limiter.snapshot().ipEntries, 1);
});

test('API active work and queue are bounded, queued requests continue after a slot is released', async t => {
  let unblock, firstStarted; const gate = new Promise(resolve => { unblock = resolve; }); const started = new Promise(resolve => { firstStarted = resolve; });
  const app = await fixture(t, { limits: { maxActive: 1, maxQueued: 1, queueTimeoutMs: 1000 }, providers: { spotify: async () => { firstStarted(); await gate; return { artwork: COVER }; } } });
  const first = post(app.base, '/api/catalog/resolve', { tracks: [{ id: ID1 }], details: false }); await started;
  const second = fetch(`${app.base}/api/status`);
  for (let attempt = 0; attempt < 100 && !app.api.limiter.snapshot().queued; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(app.api.limiter.snapshot().queued, 1);
  const full = await fetch(`${app.base}/api/status`); assert.equal(full.status, 429); assert.ok(Number(full.headers.get('retry-after')) >= 1);
  assert.equal(app.api.limiter.snapshot().active, 1); assert.equal(app.api.limiter.snapshot().queued, 1);
  unblock(); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(app.api.limiter.snapshot().active, 0); assert.equal(app.api.limiter.snapshot().queued, 0);
});

test('aborting a batch stops new tracks while keeping its slot until started lookups finish', async t => {
  let unblock, startedFour; const calls = [];
  const gate = new Promise(resolve => { unblock = resolve; }); const started = new Promise(resolve => { startedFour = resolve; });
  const app = await fixture(t, { limits: { maxActive: 1, maxQueued: 1, queueTimeoutMs: 1000 }, providers: { spotify: async track => { calls.push(track.id); if (calls.length === 4) startedFour(); await gate; return { artwork: COVER }; } } });
  const disconnected = new Promise(resolve => { app.server.once('request', (_req, res) => { res.once('close', resolve); }); });
  const controller = new AbortController();
  const tracks = Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1).padStart(22, '0') }));
  const pending = fetch(`${app.base}/api/catalog/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks, details: false }), signal: controller.signal });
  const aborted = assert.rejects(pending, error => error.name === 'AbortError');
  await started; assert.equal(calls.length, 4); controller.abort(); await aborted; await disconnected;
  assert.equal(app.api.limiter.snapshot().active, 1);
  const waiting = fetch(`${app.base}/api/status`);
  for (let attempt = 0; attempt < 100 && !app.api.limiter.snapshot().queued; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(app.api.limiter.snapshot().queued, 1);
  unblock(); assert.equal((await waiting).status, 200);
  assert.deepEqual(calls, tracks.slice(0, 4).map(track => track.id));
  assert.equal(app.api.limiter.snapshot().active, 0); assert.equal(app.api.limiter.snapshot().queued, 0);
});

test('audience requests use the same admission limit and provider rate errors carry retry metadata', async t => {
  const app = await fixture(t, { limits: { burst: 1, requestsPerMinute: 1 }, audienceHandler: async (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"coverage":[]}'); return true; } });
  assert.equal((await post(app.base, '/api/audience/resolve', { artists: [] })).status, 200);
  assert.equal((await post(app.base, '/api/audience/resolve', { artists: [] })).status, 429);
  const rateLimited = await fixture(t, { providers: { spotify: async () => { throw new ProviderError('Provider limit', { status: 429 }); } } });
  const result = await (await post(rateLimited.base, '/api/catalog/resolve', { tracks: [{ id: ID1 }], details: false })).json();
  assert.equal(result.errors[0].status, 429); assert.ok(result.errors[0].retryAfterSeconds > 0);
});
