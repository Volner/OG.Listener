import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLastfmProvider, lastfmGenreTags } from '../server/lastfm.js';
import { createLocalApi } from '../server/local-api.js';
import { safeMetadata } from '../server/providers.js';

const track = { id: '1111111111111111111111', name: 'One More Time', artist: 'Daft Punk' };
const response = (data, options = {}) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...options.headers }, status: options.status || 200 });
const info = (name = track.name, tags = ['French House', 'House', 'electronic', 'favorites']) => ({ track: { name, artist: { name: track.artist }, url: 'https://www.last.fm/music/Daft+Punk/_/One+More+Time', toptags: { tag: tags.map(name => ({ name })) }, listeners: '99999', streamable: { fulltrack: '1' } } });

test('Last.fm stays disabled without an application key and never asks visitors to authenticate', async () => {
  const provider = createLastfmProvider({ fetchImpl: () => assert.fail('Unconfigured provider must not query Last.fm') });
  assert.equal(provider.source().configured, false);
  assert.equal(provider.source().requiresKey, true);
  assert.equal(await provider.resolve(track), null);
});

test('Last.fm keeps community labels separate and only promotes recognized musical styles', async () => {
  assert.deepEqual(lastfmGenreTags(['hiphop', 'HIP-HOP', 'rnb', 'post-punk', 'favorites', 'seen live', '2019', 'Russia']), ['Hip-Hop', 'R&B', 'Post-Punk']);
  let calls = 0;
  const provider = createLastfmProvider({ apiKey: 'fixture-key', intervalMs: 0, fetchImpl: async value => {
    calls++; const url = new URL(value);
    assert.equal(url.hostname, 'ws.audioscrobbler.com');
    assert.equal(url.searchParams.get('method'), 'track.getInfo');
    assert.equal(url.searchParams.get('autocorrect'), '0');
    assert.equal(url.searchParams.has('username'), false);
    return response(info());
  } });
  const metadata = await provider.resolve(track);
  assert.deepEqual(metadata.tags, ['French House', 'House', 'electronic', 'favorites']);
  assert.deepEqual(metadata.genres, ['House', 'Electronic']);
  assert.equal(metadata.genreScope, 'track');
  assert.equal(metadata.previewUrl, undefined);
  assert.equal(metadata.audioUrl, undefined);
  assert.equal(metadata.listeners, undefined);
  assert.equal(metadata.lastfmUrl, 'https://www.last.fm/music/Daft+Punk/_/One+More+Time');
  assert.deepEqual(await provider.resolve({ ...track, name: 'ONE MORE TIME', artist: 'DAFT-PUNK' }), metadata);
  assert.equal(calls, 1);
});

test('Last.fm refuses a different title, artist, or live/remixed recording instead of attaching its tags', async () => {
  for (const returned of [info('One More Time (Live)'), { track: { ...info().track, artist: { name: 'A Tribute Band' } } }]) {
    let calls = 0;
    const provider = createLastfmProvider({ apiKey: 'fixture-key', intervalMs: 0, fetchImpl: async () => { calls++; return response(returned); } });
    await assert.rejects(provider.resolve(track), error => error.status === 404);
    await assert.rejects(provider.resolve(track), error => error.status === 404);
    assert.equal(calls, 1, 'A permanent mismatch is negatively cached');
  }
});

test('artist fallback is explicit and shared across tracks, including concurrent requests', async () => {
  let artistCalls = 0, trackCalls = 0;
  const provider = createLastfmProvider({ apiKey: 'fixture-key', intervalMs: 0, fetchImpl: async value => {
    const query = new URL(value).searchParams;
    if (query.get('method') === 'artist.getInfo') {
      artistCalls++;
      return response({ artist: { name: 'Daft Punk', url: 'https://www.last.fm/music/Daft+Punk', tags: { tag: [{ name: 'House' }, { name: 'French' }] } } });
    }
    trackCalls++; return response(info(query.get('track'), ['favorites']));
  } });
  const values = await Promise.all([provider.resolve(track), provider.resolve({ ...track, name: 'Something About Us' })]);
  assert.equal(trackCalls, 2); assert.equal(artistCalls, 1);
  for (const value of values) {
    assert.deepEqual(value.tags, ['favorites']);
    assert.deepEqual(value.artistTags, ['House', 'French']);
    assert.deepEqual(value.genres, ['House']);
    assert.deepEqual(value.artistGenres, ['House']);
    assert.equal(value.genreScope, 'artist');
  }
});

test('Last.fm backs off for HTTP and API rate limits rather than retrying every visible track', async () => {
  for (const limited of [response({ error: 29, message: 'Rate limit exceeded' }), response({}, { status: 429, headers: { 'Retry-After': '120' } })]) {
    let calls = 0;
    const provider = createLastfmProvider({ apiKey: 'fixture-key', intervalMs: 0, fetchImpl: async () => { calls++; return limited; } });
    await assert.rejects(provider.resolve(track), error => error.transient && error.retryAfter > 0);
    await assert.rejects(provider.resolve({ ...track, name: 'A Different Song' }), error => error.transient && error.retryAfter > 0);
    assert.equal(calls, 1);
  }
});

test('Last.fm respects no-store responses and never exposes untrusted source URLs', async () => {
  let calls = 0;
  const provider = createLastfmProvider({ apiKey: 'fixture-key', intervalMs: 0, fetchImpl: async () => { calls++; const data = info(); data.track.url = 'https://last.fm.evil.example/music/Track'; return response(data, { headers: { 'Cache-Control': 'no-store' } }); } });
  assert.equal((await provider.resolve(track)).lastfmUrl, null);
  await provider.resolve(track); assert.equal(calls, 2);
  assert.equal(safeMetadata({ tags: ['Rock'], lastfmUrl: 'https://last.fm.evil.example/music/Track' }).lastfmUrl, undefined);
  assert.equal(safeMetadata({ tags: ['Rock'], lastfmUrl: 'https://www.last.fm/music/Artist' }).lastfmUrl, 'https://www.last.fm/music/Artist');
});

test('local API enriches tags only for detail requests, preserves album genres, and reports safe provider configuration', async t => {
  let lastfmCalls = 0;
  const api = createLocalApi({ requestIntervalMs: 0, providers: {
    spotify: async () => ({ artwork: 'https://i.scdn.co/image/test' }),
    deezer: async () => ({ genres: ['Pop'], genreSource: 'Deezer album' }),
    lastfm: async () => { lastfmCalls++; return { tags: ['trap', 'favorites'], genres: ['Trap'], genreSource: 'Last.fm track genre tags', tagSource: 'Last.fm community tags', lastfmUrl: 'https://www.last.fm/music/Artist' }; },
    metadataSources: () => [{ id: 'lastfm', name: 'Last.fm', configured: false, requiresKey: true }],
  } });
  const server = createServer((req, res) => api.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const lookup = async details => (await fetch(`${base}/api/catalog/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks: [track], details }) })).json();
  await lookup(false); assert.equal(lastfmCalls, 0);
  const metadata = (await lookup(true)).entries[track.id];
  assert.equal(lastfmCalls, 1);
  assert.deepEqual(metadata.genres, ['Pop', 'Trap']);
  assert.deepEqual(metadata.tags, ['trap', 'favorites']);
  assert.deepEqual(metadata.genreSources, ['Deezer album', 'Last.fm track genre tags']);
  assert.equal(metadata.genreSource, 'Deezer album');
  await lookup(true); assert.equal(lastfmCalls, 1);
  const status = await (await fetch(`${base}/api/catalog/providers`)).json();
  assert.equal(status.sources[0].configured, false);
  assert.equal(status.mediaFiles, 0);
  assert.equal(JSON.stringify(status).includes('fixture-key'), false);
});

test('the merged catalog does not retain Last.fm tags past the source cache expiry', async t => {
  let calls = 0;
  const api = createLocalApi({ requestIntervalMs: 0, providers: {
    spotify: async () => ({ artwork: 'https://i.scdn.co/image/test' }),
    lastfm: async () => ({ tags: [`version-${++calls}`], lastfmExpiresAt: Date.now() }),
  } });
  const server = createServer((req, res) => api.middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let version = 1; version <= 2; version++) {
    const result = await (await fetch(`${base}/api/catalog/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks: [track] }) })).json();
    assert.deepEqual(result.entries[track.id].tags, [`version-${version}`]);
  }
  assert.equal(calls, 2);
});
