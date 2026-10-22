import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequestLimiter, clientAddress } from '../server/request-limits.js';

function request(address = '198.51.100.1', headers = {}) {
  return Object.assign(new EventEmitter(), { socket: { remoteAddress: address }, headers, aborted: false });
}
const response = () => Object.assign(new EventEmitter(), { destroyed: false });

test('client IP comes from the socket; only an opted-in loopback proxy may provide X-Real-IP', () => {
  const headers = { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '192.0.2.7' };
  assert.equal(clientAddress(request('127.0.0.1', headers)), '127.0.0.1');
  assert.equal(clientAddress(request('203.0.113.1', headers), 'loopback'), '203.0.113.1');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', headers), 'loopback'), '203.0.113.9');
  assert.equal(clientAddress(request('::1', { 'x-real-ip': 'invalid', 'x-forwarded-for': '192.0.2.7' }), 'loopback'), '::1');
  assert.equal(clientAddress(request('127.0.0.1', { 'x-real-ip': '203.0.113.9, 192.0.2.7' }), 'loopback'), '127.0.0.1');
});

test('an explicitly listed Docker gateway is trusted without trusting its network or X-Forwarded-For', () => {
  const headers = { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '192.0.2.7' };
  assert.equal(clientAddress(request('172.17.0.1', headers), 'loopback'), '172.17.0.1');
  assert.equal(clientAddress(request('172.17.0.1', headers), 'loopback,172.17.0.1'), '203.0.113.9');
  assert.equal(clientAddress(request('::ffff:172.17.0.1', headers), ' loopback , 172.17.0.1 '), '203.0.113.9');
  assert.equal(clientAddress(request('172.17.0.1', headers), '::ffff:172.17.0.1'), '203.0.113.9');
  assert.equal(clientAddress(request('172.17.0.2', headers), 'loopback,172.17.0.1'), '172.17.0.2');
  assert.equal(clientAddress(request('172.17.0.1', { 'x-forwarded-for': '192.0.2.7' }), '172.17.0.1'), '172.17.0.1');
  assert.equal(clientAddress(request('172.17.0.1', headers), 'none'), '172.17.0.1');
});

test('a trusted platform resolver separates visitors and validates its result before using it', async () => {
  const limiter = createRequestLimiter({
    clientIp: req => req.platformAddress,
    limits: { requestsPerMinute: 1, burst: 1 },
  });
  const first = Object.assign(request('127.0.0.1'), { platformAddress: '203.0.113.1' });
  const second = Object.assign(request('127.0.0.1'), { platformAddress: '203.0.113.2' });
  (await limiter.acquire(first))();
  (await limiter.acquire(second))();
  await assert.rejects(limiter.acquire(first), error => error.status === 429);
  const invalid = Object.assign(request('127.0.0.1', { 'x-forwarded-for': '192.0.2.9' }), { platformAddress: '203.0.113.3, 192.0.2.9' });
  (await limiter.acquire(invalid))();
  await assert.rejects(limiter.acquire(request('127.0.0.1')), error => error.status === 429);
  assert.equal(limiter.snapshot().ipEntries, 3);
  limiter.close();
  assert.throws(() => createRequestLimiter({ clientIp: true }), /trusted server-side resolver/);
});

test('separate visitors behind an explicitly trusted gateway retain independent quotas', async () => {
  const limiter = createRequestLimiter({ env: { TRUST_PROXY: 'loopback,172.17.0.1' }, limits: { requestsPerMinute: 1, burst: 1 } });
  const first = request('172.17.0.1', { 'x-real-ip': '203.0.113.1' });
  const second = request('172.17.0.1', { 'x-real-ip': '203.0.113.2' });
  (await limiter.acquire(first))(); (await limiter.acquire(second))();
  await assert.rejects(limiter.acquire(first), error => error.status === 429);
  assert.equal(limiter.snapshot().ipEntries, 2); limiter.close();
});

test('per-IP token buckets allow a burst, refill gradually, and keep independent quotas', async () => {
  let time = 0; const limiter = createRequestLimiter({ now: () => time, limits: { requestsPerMinute: 60, burst: 2 } });
  for (let i = 0; i < 2; i++) (await limiter.acquire(request()))();
  await assert.rejects(limiter.acquire(request()), error => error.status === 429 && error.retryAfterSeconds === 1);
  (await limiter.acquire(request('198.51.100.2')))();
  time = 500; await assert.rejects(limiter.acquire(request()), error => error.status === 429);
  time = 1000; (await limiter.acquire(request()))();
  assert.equal(limiter.snapshot().ipEntries, 2); limiter.close();
});

test('IP bookkeeping is bounded and expires idle entries without resetting live quotas', async () => {
  let time = 0; const limiter = createRequestLimiter({ now: () => time, limits: { requestsPerMinute: 60, burst: 1, maxIpEntries: 2, ipTtlMs: 1000 } });
  (await limiter.acquire(request('198.51.100.1')))(); (await limiter.acquire(request('198.51.100.2')))();
  await assert.rejects(limiter.acquire(request('198.51.100.3')), error => error.status === 429);
  assert.equal(limiter.snapshot().ipEntries, 2);
  await assert.rejects(limiter.acquire(request('198.51.100.1')), error => error.status === 429);
  time = 1001; (await limiter.acquire(request('198.51.100.3')))();
  assert.equal(limiter.snapshot().ipEntries, 1); limiter.close();
});

test('admission has a bounded FIFO queue and release is idempotent', async () => {
  const limiter = createRequestLimiter({ limits: { maxActive: 1, maxQueued: 2, queueTimeoutMs: 1000 } });
  const first = await limiter.acquire(request());
  const second = limiter.acquire(request()); const third = limiter.acquire(request());
  await assert.rejects(limiter.acquire(request()), error => error.status === 429);
  assert.equal(limiter.snapshot().active, 1); assert.equal(limiter.snapshot().queued, 2);
  first(); first(); const releaseSecond = await second;
  assert.equal(limiter.snapshot().active, 1); assert.equal(limiter.snapshot().queued, 1);
  releaseSecond(); const releaseThird = await third; releaseThird();
  assert.equal(limiter.snapshot().active, 0); assert.equal(limiter.snapshot().queued, 0); limiter.close();
});

test('waiting requests time out with Retry-After and a disconnected waiter never receives a slot', async () => {
  const limiter = createRequestLimiter({ limits: { maxActive: 1, maxQueued: 1, queueTimeoutMs: 15 } });
  const release = await limiter.acquire(request());
  await assert.rejects(limiter.acquire(request()), error => error.status === 429 && error.retryAfterSeconds === 1);
  assert.equal(limiter.snapshot().queued, 0);
  const req = request(), res = response();
  const waiting = limiter.acquire(req, res); const rejected = assert.rejects(waiting, error => error.status === 499);
  res.destroyed = true; res.emit('close'); await rejected;
  assert.equal(limiter.snapshot().queued, 0); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  release(); assert.equal(limiter.snapshot().active, 0); limiter.close();
});

test('close rejects queued work, clears state, and disables future admission', async () => {
  const limiter = createRequestLimiter({ limits: { maxActive: 1 } });
  const release = await limiter.acquire(request()); const waiting = limiter.acquire(request());
  const rejected = assert.rejects(waiting, error => error.status === 503); limiter.close(); await rejected;
  await assert.rejects(limiter.acquire(request()), error => error.status === 503);
  release(); assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, ipEntries: 0, closed: true });
});

test('environment settings are validated and explicit options override them', () => {
  const limiter = createRequestLimiter({ env: { API_MAX_ACTIVE: '3', API_MAX_QUEUED: '0', TRUST_PROXY: 'loopback' }, limits: { maxActive: 2 } });
  assert.equal(limiter.config.maxActive, 2); assert.equal(limiter.config.maxQueued, 0); limiter.close();
  assert.throws(() => createRequestLimiter({ env: { API_MAX_ACTIVE: '-1' } }), /API_MAX_ACTIVE/);
  assert.throws(() => createRequestLimiter({ env: { TRUST_PROXY: 'true' } }), /TRUST_PROXY/);
  for (const value of ['*', '172.17.0.0/16', 'localhost', 'none,loopback', 'loopback,', '172.17.0.1:80']) {
    assert.throws(() => createRequestLimiter({ env: { TRUST_PROXY: value } }), /TRUST_PROXY/, value);
  }
});
