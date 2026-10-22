import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createAudienceApi, createChartmetricClient, normalizeChartmetricListeners } from '../server/audience.mjs';
import { createKworbClient, parseKworbListeners, normalizeArchiveChecked } from '../server/kworb.mjs';

const artistId = '4gzpq5DPGxSnKTe4SA8HAU';
const artist = { name: 'Coldplay', artistId, firstPlayed: '2019-02-01T00:00:00.000Z' };
const payload = { obj: { listeners: [
  { value: 13, timestp: '2019-01-31T00:00:00.000Z', interpolated: false },
  { value: 2000000, timestp: '2026-01-01T00:00:00.000Z' },
] } };
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

async function call(handler, path, body, method = 'POST') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.url = path;
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  let result;
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value) { result = { status: this.status, body: JSON.parse(value), serialized: value }; },
  };
  const handled = await handler(req, res, new URL(path, 'http://localhost'));
  return { handled, ...result };
}

test('audience API reports configuration without exposing credentials and requires server configuration', async () => {
  const configured = createAudienceApi({ env: { CHARTMETRIC_REFRESH_TOKEN: 'private-refresh-token' } });
  const status = await call(configured, '/api/audience/providers', undefined, 'GET');
  assert.equal(status.body.providers[0].id, 'kworb');
  assert.equal(status.body.providers[0].paid, false);
  assert.equal(status.body.providers.find(item => item.id === 'chartmetric').configured, true);
  assert.ok(!status.serialized.includes('private-refresh-token'));
  let requested = false;
  const missing = createAudienceApi({ env: {}, fetchImpl: () => { requested = true; } });
  const result = await call(missing, '/api/audience/import', { provider: 'chartmetric', artists: [artist] });
  assert.equal(result.status, 428);
  assert.equal(result.body.code, 'provider_not_configured');
  assert.equal(requested, false);
  assert.equal((await call(missing, '/other', undefined, 'GET')).handled, false);
});

test('documented listener endpoint uses Spotify ID and reuses token and historical cache', async () => {
  const calls = [];
  const client = createChartmetricClient({
    env: { CHARTMETRIC_REFRESH_TOKEN: 'refresh' }, requestIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return url.endsWith('/api/token') ? response({ token: 'access', expires_in: 3600 }) : response(payload);
    },
  });
  const result = await client.artistHistory(artist);
  assert.equal(result.coverage.hasBaseline, true);
  assert.equal(result.snapshots[0].listeners, 13);
  const statsCall = calls[1];
  assert.equal(statsCall.url.pathname, `/api/artist/${artistId}/stat/spotify`);
  assert.equal(statsCall.url.searchParams.get('field'), 'listeners');
  assert.equal(statsCall.url.searchParams.get('isDomainId'), 'true');
  assert.equal(statsCall.url.searchParams.get('interpolated'), 'false');
  assert.equal(statsCall.url.searchParams.get('since'), '2019-01-01');
  assert.equal(statsCall.options.headers.Authorization, 'Bearer access');
  assert.strictEqual(await client.artistHistory(artist), result);
  await client.artistHistory({ ...artist, name: 'Second', artistId: '5p7f24Rk5HkUZsaS3BLG5F' });
  assert.equal(calls.filter(({ url }) => url.pathname === '/api/token').length, 1);
  assert.equal(calls.length, 3);
});

test('history normalizer rejects other metrics and removes interpolation and invalid evidence', () => {
  assert.throws(() => normalizeChartmetricListeners({ obj: { followers: payload.obj.listeners } }, 'A'), /monthly listeners/);
  const snapshots = normalizeChartmetricListeners({ obj: { listeners: [
    ...payload.obj.listeners,
    { value: 14, timestp: '2019-01-31T00:00:00.000Z' },
    { value: 1000, timestp: '2019-01-30T00:00:00.000Z', interpolated: true },
    { value: null, timestp: '2019-01-29T00:00:00.000Z' },
    { value: 500, timestp: 'invalid' },
    { value: -10, timestp: '2020-01-01' },
    { value: 1, timestp: '2999-01-01' },
  ] } }, 'A');
  assert.deepEqual(snapshots.map((point) => point.listeners), [14, 2000000]);
  assert.equal(snapshots[0].source, 'Chartmetric');
  assert.equal(snapshots[0].metric, 'monthly_listeners');
});

test('ambiguous artist names are never silently matched to the most popular result', async () => {
  const client = createChartmetricClient({
    env: { CHARTMETRIC_REFRESH_TOKEN: 'refresh' }, requestIntervalMs: 0,
    fetchImpl: async (url) => url.endsWith('/api/token') ? response({ token: 'access' }) : response({ obj: { artists: [
      { id: 1, name: 'Artist' }, { id: 2, name: 'Artist' },
    ] } }),
  });
  await assert.rejects(client.artistHistory({ name: 'Artist', firstPlayed: artist.firstPlayed }), { code: 'ambiguous_artist' });
});

test('audience API preserves missing baseline and returns provider access errors honestly', async () => {
  const handler = createAudienceApi({
    env: { CHARTMETRIC_REFRESH_TOKEN: 'refresh' }, requestIntervalMs: 0,
    fetchImpl: async (url) => url.endsWith('/api/token') ? response({ token: 'access' }) : response({ obj: { listeners: [payload.obj.listeners[1]] } }),
  });
  const result = await call(handler, '/api/audience/import', { provider: 'chartmetric', artists: [artist] });
  assert.equal(result.status, 200);
  assert.equal(result.body.coverage[0].hasBaseline, false);
  assert.equal(result.body.snapshots.length, 1);
  const forbidden = createAudienceApi({
    env: { CHARTMETRIC_REFRESH_TOKEN: 'refresh' }, requestIntervalMs: 0,
    fetchImpl: async () => response({ secret: 'must not appear in output' }, 403),
  });
  const denied = await call(forbidden, '/api/audience/import', { provider: 'chartmetric', artists: [artist] });
  assert.equal(denied.body.snapshots.length, 0);
  assert.equal(denied.body.errors[0].code, 'provider_plan');
  assert.ok(!denied.serialized.includes('must not appear in output'));
  assert.equal((await call(handler, '/api/audience/import', { artists: Array.from({ length: 21 }, () => artist) })).status, 400);
  assert.equal((await call(handler, '/api/audience/import', '{')).status, 400);
});

const listenerHtml = (listeners, { rank = true, name = 'Coldplay' } = {}) => `<html><title>Spotify - Top Artists by Monthly Listeners</title><table><tr>${rank ? '<td>8</td>' : ''}<td class="text"><div><a href="artist/${artistId}_songs.html">${name}</a></div></td><td>${listeners.toLocaleString('en-US')}</td><td>-3,713</td><td>4</td><td>101,505,654</td></tr></table></html>`;

test('Kworb parser reads both old and new monthly-listener layouts and rejects stream tables', () => {
  assert.deepEqual(parseKworbListeners(listenerHtml(77769643, { rank: false })), [{ artistId, name: 'Coldplay', listeners: 77769643 }]);
  assert.equal(parseKworbListeners(listenerHtml(94191398))[0].listeners, 94191398);
  assert.equal(parseKworbListeners(listenerHtml(10, { name: 'R&amp;B &#x41;rtist' }))[0].name, 'R&B Artist');
  assert.throws(() => parseKworbListeners('<title>Spotify Top Songs</title><td>123,456</td>'), /месячных слушателей/);
});

test('free Kworb imports use real archive capture dates, preserve sparse coverage and require no key', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ['20240101133431', 'https://kworb.net/spotify/listeners.html']]);
    const historical = url.includes('/web/');
    // Historical page redirects to a later actual capture; the request timestamp is not evidence.
    return new Response(listenerHtml(historical ? 77769643 : 94191398, { rank: !historical }), { headers: historical ? { 'memento-datetime': 'Mon, 01 Jan 2024 13:34:31 GMT' } : { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  };
  const handler = createAudienceApi({ env: {}, fetchImpl, requestIntervalMs: 0 });
  const result = await call(handler, '/api/audience/import', { artists: [{ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z' }] });
  assert.equal(result.status, 200); assert.equal(result.body.provider, 'kworb'); assert.equal(result.body.snapshots.length, 2); assert.equal(result.body.coverage[0].hasBaseline, true);
  assert.deepEqual(result.body.snapshots.map(point => point.listeners), [77769643, 94191398]);
  assert.equal(result.body.snapshots[0].date, '2024-01-01T13:34:31.000Z'); assert.equal(result.body.snapshots[0].source, 'Kworb'); assert.equal(result.body.snapshots[0].metric, 'monthly_listeners'); assert.equal(result.body.snapshots[0].archived, true);
  const count = calls.length; await call(handler, '/api/audience/import', { artists: [{ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z' }] }); assert.equal(calls.length, count);
  assert.ok(calls.filter(url => url.includes('/web/')).length <= 8);
  const old = await call(handler, '/api/audience/import', { artists: [artist] }); assert.equal(old.body.coverage[0].hasBaseline, false); assert.ok(old.body.snapshots.every(point => Date.parse(point.date) > Date.parse(artist.firstPlayed)));
});

test('a later Wayback capture cannot become a baseline; archive outages keep only observed current data', async () => {
  const client = createKworbClient({ requestIntervalMs: 0, fetchImpl: async url => {
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ['20240101000000', 'https://kworb.net/spotify/listeners.html']]);
    return new Response(listenerHtml(url.includes('/web/') ? 77769643 : 94191398), { headers: url.includes('/web/') ? { 'memento-datetime': 'Mon, 05 Feb 2024 00:00:00 GMT' } : { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  } });
  const result = await client.artistHistory({ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z' }); assert.equal(result.coverage.hasBaseline, false); assert.equal(result.snapshots[0].date, '2024-02-05T00:00:00.000Z');
  const unavailable = createKworbClient({ requestIntervalMs: 0, fetchImpl: async url => url.includes('/cdx/') ? new Response('offline', { status: 503 }) : new Response(listenerHtml(94191398), { headers: { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } }) });
  const partial = await unavailable.artistHistory(artist); assert.equal(partial.snapshots.length, 1); assert.equal(partial.coverage.hasBaseline, false); assert.ok(partial.coverage.warnings.length > 0);
});

test('automatic bulk resolution shares ranking captures and does not crawl archives for untracked names', async () => {
  const calls = [];
  const handler = createAudienceApi({ env: {}, requestIntervalMs: 0, fetchImpl: async url => {
    calls.push(url);
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ['20240101133431', 'https://kworb.net/spotify/listeners.html']]);
    const archived = url.includes('/web/');
    return new Response(listenerHtml(archived ? 77769643 : 94191398), { headers: archived ? { 'memento-datetime': 'Mon, 01 Jan 2024 13:34:31 GMT' } : { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  } });
  const artists = [{ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z' }, ...Array.from({ length: 99 }, (_, i) => ({ name: `Unknown ${i}`, firstPlayed: artist.firstPlayed }))];
  const result = await call(handler, '/api/audience/resolve', { artists });
  assert.equal(result.status, 200);
  assert.equal(result.body.coverage.length, 100);
  assert.equal(result.body.coverage[0].status, 'ready');
  assert.equal(result.body.coverage[0].firstPlayed, artists[0].firstPlayed);
  assert.ok(result.body.coverage.slice(1).every(item => item.status === 'not_tracked' && item.count === 0 && item.retryable === false));
  assert.equal(result.body.summary.tracked, 1);
  assert.equal(calls.length, 6, 'two current tables, two indices, two shared captures');
  await call(handler, '/api/audience/resolve', { artists: artists.slice(1) });
  assert.equal(calls.length, 6, 'a library of unknown names reuses the current ranking, without archive lookups');
  assert.equal((await call(handler, '/api/audience/resolve', { artists: [...artists, artists[0]] })).status, 400);
});

test('archive work is bounded per batch and later batches reuse tables to fill deferred dates', async () => {
  const artists = Array.from({ length: 8 }, (_, i) => ({ name: `Artist ${i}`, artistId: String(i).padStart(22, '0'), firstPlayed: `2024-${String(i + 1).padStart(2, '0')}-15T00:00:00.000Z` }));
  const html = `<title>Spotify - Top Artists by Monthly Listeners</title><table>${artists.map(item => `<tr><td><a href="artist/${item.artistId}_songs.html">${item.name}</a></td><td>100</td></tr>`).join('')}</table>`;
  const captures = artists.map((_, i) => `2024${String(i + 1).padStart(2, '0')}01000000`);
  const calls = [];
  const client = createKworbClient({ requestIntervalMs: 0, maxArchiveRequests: 4, fetchImpl: async url => {
    calls.push(url);
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ...captures.map(stamp => [stamp, 'https://kworb.net/spotify/listeners.html'])]);
    const stamp = /\/web\/(\d{14})/.exec(url)?.[1];
    const observedAt = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z` : '2026-10-20T12:59:18Z';
    return new Response(html, { headers: { [stamp ? 'memento-datetime' : 'last-modified']: new Date(observedAt).toUTCString() } });
  } });
  const first = await client.artistHistories(artists);
  assert.equal(first.summary.archiveRequests, 4);
  assert.ok(first.coverage.some(item => item.status === 'deferred'));
  const second = await client.artistHistories(artists);
  assert.equal(second.summary.archiveRequests, 4);
  assert.ok(second.coverage.filter(item => item.hasBaseline).length > first.coverage.filter(item => item.hasBaseline).length);
  assert.equal(calls.filter(url => !url.includes('/web/') && !url.includes('/cdx/')).length, 2);
  assert.equal(calls.filter(url => url.includes('/cdx/')).length, 2);
});

test('archive continuation completes across cold instances without repeating checked captures', async () => {
  const artists = Array.from({ length: 8 }, (_, i) => ({ name: `Artist ${i}`, artistId: String(i).padStart(22, '0'), firstPlayed: `2024-${String(i + 1).padStart(2, '0')}-15T00:00:00.000Z` }));
  const html = `<title>Spotify - Top Artists by Monthly Listeners</title><table>${artists.map(item => `<tr><td><a href="artist/${item.artistId}_songs.html">${item.name}</a></td><td>100</td></tr>`).join('')}</table>`;
  const captures = artists.map((_, i) => `2024${String(i + 1).padStart(2, '0')}01000000`);
  const checked = new Set(), observations = [], progress = new Map();
  let finished = false;
  for (let pass = 0; pass < 12; pass++) {
    let archiveCalls = 0;
    // A deliberately new client for every request simulates a cold Vercel instance.
    const client = createKworbClient({ requestIntervalMs: 0, maxArchiveRequests: 4, fetchImpl: async url => {
      if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ...captures.map(stamp => [stamp, 'https://kworb.net/spotify/listeners.html'])]);
      const stamp = /\/web\/(\d{14})/.exec(url)?.[1];
      if (stamp) {
        assert.equal(checked.has(url), false, `cold request repeated ${url}`);
        checked.add(url); archiveCalls++;
      }
      return new Response(html, { headers: { [stamp ? 'memento-datetime' : 'last-modified']: new Date(stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00Z` : '2026-10-20T12:59:18Z').toUTCString() } });
    } });
    const result = await client.artistHistories(artists.map(item => ({ ...item, archiveChecked: progress.get(item.name) })));
    observations.push(...result.snapshots);
    assert.ok(archiveCalls <= 4);
    assert.equal(result.summary.archiveRequests, archiveCalls);
    for (const coverage of result.coverage) {
      assert.ok(coverage.archiveChecked.length <= 6);
      progress.set(coverage.artist, coverage.archiveChecked);
    }
    if (result.coverage.every(item => !item.retryable)) { finished = true; break; }
  }
  assert.equal(finished, true, 'all relevant captures finish without a shared RAM cache');
  assert.equal(checked.size, 16, 'each of the eight monthly captures on two pages is fetched once');
  for (const item of artists) {
    assert.ok(observations.some(point => point.artist === item.name && Date.parse(point.date) <= Date.parse(item.firstPlayed) && Date.parse(item.firstPlayed) - Date.parse(point.date) <= 31 * 86400000));
  }
});

test('archive cursors are bounded identities verified against actual captures and cannot fabricate a baseline', async () => {
  assert.deepEqual(normalizeArchiveChecked(null), []);
  assert.deepEqual(normalizeArchiveChecked({ url: 'https://example.com' }), []);
  assert.deepEqual(normalizeArchiveChecked(['https://example.com', '2:20240101000000', '0:invalid', '0:20240101000000', '0:20240101000000']), ['0:20240101000000']);
  assert.ok(normalizeArchiveChecked(Array.from({ length: 1000 }, (_, i) => `0:2024${String(i % 12 + 1).padStart(2, '0')}01000000`)).length <= 3);
  const calls = [];
  const client = createKworbClient({ requestIntervalMs: 0, fetchImpl: async url => {
    calls.push(url);
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ['20240101000000', 'https://kworb.net/spotify/listeners.html']]);
    return new Response(listenerHtml(100), { headers: { [url.includes('/web/') ? 'memento-datetime' : 'last-modified']: url.includes('/web/') ? 'Mon, 01 Jan 2024 00:00:00 GMT' : 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  } });
  const result = await client.artistHistories([{ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z', archiveChecked: ['0:20240101000000', '1:20240101000000', '0:20231201000000'] }]);
  assert.equal(result.coverage[0].hasBaseline, false, 'a cursor supplies no observed listener values');
  assert.deepEqual(result.coverage[0].archiveChecked, ['0:20240101000000', '1:20240101000000']);
  assert.equal(calls.filter(url => url.includes('/web/')).length, 0);
  assert.ok(calls.every(url => url.startsWith('https://kworb.net/spotify/listeners') || url.startsWith('https://web.archive.org/cdx/')));
});

test('archive requests without an actual capture date cannot fabricate a historical point', async () => {
  const client = createKworbClient({ requestIntervalMs: 0, fetchImpl: async url => {
    if (url.includes('/cdx/')) return Response.json([['timestamp', 'original'], ['20240101000000', 'https://kworb.net/spotify/listeners.html']]);
    return new Response(listenerHtml(100), { headers: url.includes('/web/') ? {} : { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  } });
  const result = await client.artistHistory({ ...artist, firstPlayed: '2024-01-15T00:00:00.000Z' });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.coverage.hasBaseline, false);
  assert.equal(result.coverage.status, 'unavailable');
});

test('provider failures are cached so automatic library batches do not hammer an unavailable source', async () => {
  let calls = 0;
  const client = createKworbClient({ requestIntervalMs: 0, fetchImpl: async () => { calls++; return new Response('offline', { status: 503 }); } });
  const first = await client.artistHistories([{ name: 'Unknown', firstPlayed: artist.firstPlayed }]);
  const second = await client.artistHistories([{ name: 'Another', firstPlayed: artist.firstPlayed }]);
  assert.equal(calls, 2);
  assert.equal(first.coverage[0].status, 'unavailable');
  assert.equal(second.coverage[0].retryable, true);
  assert.equal(second.coverage[0].retryAfterSeconds, 60);
});

test('cancelling automatic resolution prevents subsequent archive work', async () => {
  const controller = new AbortController();
  const calls = [];
  const client = createKworbClient({ requestIntervalMs: 0, fetchImpl: async url => {
    calls.push(url); controller.abort();
    return new Response(listenerHtml(100), { headers: { 'last-modified': 'Tue, 20 Oct 2026 12:59:18 GMT' } });
  } });
  await assert.rejects(client.artistHistories([artist], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => !url.includes('web.archive.org')));
});
