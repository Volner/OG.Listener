import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogQueue } from '../src/lib/catalog-queue.js';

const tracks = Array.from({ length: 15 }, (_, index) => ({ id: String(index + 1), name: `Track ${index + 1}` }));
const flush = () => new Promise(resolve => setImmediate(resolve));
const success = list => ({ entries: Object.fromEntries(list.map(track => [track.id, { artwork: `https://example.test/${track.id}.jpg` }])), errors: [] });

test('partial HTTP-200 errors remain visible; retry does not repeat successful tracks or duplicate in-flight failures', async t => {
  const calls = [];
  let state;
  let retryResolve;
  const received = [];
  const queue = createCatalogQueue({
    onState: next => { state = next; }, onEntries: entries => received.push(...Object.keys(entries)),
    resolve: async (list, { details }) => {
      calls.push({ ids: list.map(track => track.id), details });
      if (!details && calls.length === 1) return { entries: { '1': { artwork: 'https://example.test/1.jpg' } }, errors: [{ id: '2', status: 503, error: 'Provider offline' }] };
      if (!details) return new Promise(resolve => { retryResolve = () => resolve(success(list)); });
      return success(list);
    },
  });
  t.after(() => queue.close());
  queue.add([tracks[0], tracks[1], tracks[0]]);
  await flush();
  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].id, '2');
  assert.deepEqual(received, ['1', '1']);
  queue.add([tracks[1]]);
  queue.retry(); queue.retry(); queue.add([tracks[1]]);
  assert.equal(calls.filter(call => !call.details).length, 2);
  assert.deepEqual(calls.filter(call => !call.details)[1].ids, ['2']);
  retryResolve();
  await flush();
  assert.deepEqual(state.failures, []);
  assert.equal(calls.filter(call => call.details && call.ids.includes('2')).length, 1);
});

test('429 pauses queued work and respects Retry-After even when retry is clicked repeatedly', async t => {
  let time = 1000;
  let nextTimer;
  let state;
  const calls = [];
  const queue = createCatalogQueue({
    now: () => time,
    setTimer: (callback, delay) => { nextTimer = { callback, at: time + delay }; return nextTimer; },
    clearTimer: handle => { if (nextTimer === handle) nextTimer = null; },
    onState: next => { state = next; },
    resolve: async (list, { details }) => {
      calls.push({ ids: list.map(track => track.id), details });
      if (calls.length === 1) return { entries: {}, errors: [{ id: '1', status: 429, error: 'Rate limited', retryAfterSeconds: 2 }] };
      return success(list);
    },
  });
  t.after(() => queue.close());
  queue.add([tracks[0]]);
  await flush();
  queue.retry(); queue.retry(); queue.add([tracks[1], tracks[0]]);
  assert.equal(state.retryAt, 3000);
  assert.equal(calls.length, 1);
  assert.equal(nextTimer.at, 3000);
  time = 2999;
  queue.retry();
  assert.equal(calls.length, 1);
  time = 3000;
  nextTimer.callback();
  await flush();
  assert.deepEqual(state.failures, []);
  assert.deepEqual(calls.filter(call => !call.details).map(call => call.ids), [['1'], ['1', '2']]);
});

test('a top-level network failure is retryable and does not schedule a hot retry loop', async t => {
  let calls = 0;
  let state;
  const queue = createCatalogQueue({ onState: next => { state = next; }, resolve: async list => { calls++; if (calls === 1) throw new TypeError('Failed to fetch'); return success(list); } });
  t.after(() => queue.close());
  queue.add([tracks[0]]);
  await flush();
  assert.equal(calls, 1);
  assert.equal(state.failures[0].status, 503);
  queue.retry();
  await flush();
  assert.equal(calls, 3);
  assert.deepEqual(state.failures, []);
});

test('reset aborts old work and ignores late results without corrupting a new library queue', async t => {
  let finishOld;
  let oldSignal;
  const received = [];
  const queue = createCatalogQueue({
    onEntries: entries => received.push(...Object.keys(entries)),
    resolve: async (list, { signal }) => {
      if (list[0].id === '1') { oldSignal = signal; return new Promise(resolve => { finishOld = () => resolve(success(list)); }); }
      return success(list);
    },
  });
  t.after(() => queue.close());
  queue.add([tracks[0]]);
  queue.reset();
  assert.equal(oldSignal.aborted, true);
  queue.add([tracks[1]]);
  finishOld();
  await flush();
  assert.deepEqual(received, ['2', '2']);
});

test('cover concurrency is bounded and genre details wait for the cover batches', async t => {
  const releases = [];
  const calls = [];
  const queue = createCatalogQueue({ resolve: (list, { details }) => {
    calls.push({ ids: list.map(track => track.id), details });
    return new Promise(resolve => releases.push(() => resolve(success(list))));
  } });
  t.after(() => queue.close());
  queue.add([...tracks, ...tracks]);
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.ids.length === 6 && !call.details));
  releases.shift()(); await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].ids.length, 3);
  releases.shift()(); await flush();
  assert.equal(calls.length, 3);
  releases.shift()(); await flush();
  assert.equal(calls[3].details, true);
  while (releases.length) { releases.shift()(); await flush(); }
  const detailIds = calls.filter(call => call.details).flatMap(call => call.ids);
  assert.equal(detailIds.length, tracks.length);
  assert.equal(new Set(detailIds).size, tracks.length);
});
