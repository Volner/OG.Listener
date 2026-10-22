import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalogBatch } from '../src/lib/api.js';

test('catalog client keeps partial per-track errors available to the queue', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({ entries: {}, errors: [{ id: 'one', status: 503, error: 'offline' }] }), { headers: { 'Content-Type': 'application/json' } });
  assert.equal((await resolveCatalogBatch([{ id: 'one' }])).errors[0].status, 503);
});

test('catalog client preserves top-level 429 and Retry-After delay', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '4' } });
  await assert.rejects(resolveCatalogBatch([]), error => error.status === 429 && error.retryAfterSeconds === 4);
});

test('non-JSON 429 from a proxy still preserves the rate-limit status and delay', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('Too many requests', { status: 429, headers: { 'Retry-After': '2' } });
  await assert.rejects(resolveCatalogBatch([]), error => error.status === 429 && error.retryAfterSeconds === 2);
});

test('catalog requests send music identity without private listening dates, counts or events', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let sent, requestedUrl;
  globalThis.fetch = async (url, options) => { requestedUrl = url; sent = JSON.parse(options.body); return Response.json({ entries: {}, errors: [] }); };
  await resolveCatalogBatch([{ id: 'one', name: 'Song', artist: 'Artist', uri: 'spotify:track:one', firstPlayed: '2019-01-01', plays: 12, events: [[0, 1, 2]], source: 'private-archive.zip' }]);
  assert.deepEqual(sent.tracks, [{ id: 'one', name: 'Song', artist: 'Artist', uri: 'spotify:track:one' }]);
  assert.equal(requestedUrl, '/api/catalog/resolve');
});
