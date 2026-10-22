import { isIP } from 'node:net';

const DEFAULTS = Object.freeze({ maxActive: 12, maxQueued: 24, queueTimeoutMs: 5000, requestsPerMinute: 120, burst: 30, maxIpEntries: 10000, ipTtlMs: 600000 });
const ENV = Object.freeze({ maxActive: 'API_MAX_ACTIVE', maxQueued: 'API_MAX_QUEUED', queueTimeoutMs: 'API_QUEUE_TIMEOUT_MS', requestsPerMinute: 'API_REQUESTS_PER_MINUTE', burst: 'API_BURST', maxIpEntries: 'API_MAX_IP_ENTRIES', ipTtlMs: 'API_IP_TTL_MS' });

function setting(value, fallback, name, minimum = 1) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  return number;
}

function normalizedIp(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  if (!isIP(address)) return null;
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

function trustedAddresses(value) {
  if (typeof value !== 'string') throw new RangeError('TRUST_PROXY must contain none, loopback, or comma-separated exact IP addresses.');
  const setting = value.trim();
  if (!setting || setting === 'none') return new Set();
  const addresses = new Set();
  for (const part of setting.split(',')) {
    const entry = part.trim();
    if (entry === 'loopback') { addresses.add('127.0.0.1'); addresses.add('::1'); continue; }
    const address = normalizedIp(entry);
    if (!address) throw new RangeError('TRUST_PROXY only accepts loopback and exact IP addresses; none must appear alone.');
    addresses.add(address);
  }
  return addresses;
}

function addressFromPeer(req, trusted) {
  const peer = normalizedIp(req.socket?.remoteAddress) || 'unknown';
  if (trusted.has(peer)) {
    return normalizedIp(req.headers?.['x-real-ip']) || peer;
  }
  return peer;
}

/** X-Forwarded-For is ignored. Only explicitly trusted socket peers may overwrite X-Real-IP. */
export function clientAddress(req, trustProxy = '') {
  return addressFromPeer(req, trustedAddresses(trustProxy));
}

function limited(message, retryAfterSeconds = 1, status = 429) {
  return Object.assign(new Error(message), { status, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });
}

/** Process-wide admission control. Only bounded, expiring IP token buckets are retained. */
export function createRequestLimiter({ env = {}, limits = {}, trustProxy = env.TRUST_PROXY || '', clientIp, now = Date.now } = {}) {
  if (clientIp !== undefined && typeof clientIp !== 'function') throw new TypeError('clientIp must be a trusted server-side resolver.');
  const trusted = trustedAddresses(trustProxy);
  const config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, setting(limits[key] ?? env[ENV[key]], fallback, ENV[key], key === 'maxQueued' ? 0 : 1)]));
  // A depleted bucket cannot expire before it would have refilled normally.
  const bucketTtl = Math.max(config.ipTtlMs, config.burst * 60000 / config.requestsPerMinute);
  const buckets = new Map(), queue = [];
  let active = 0, closed = false;

  function charge(req) {
    const time = now(), key = normalizedIp(clientIp?.(req)) || addressFromPeer(req, trusted);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= config.maxIpEntries) {
        for (const [address, entry] of buckets) if (time - entry.updated >= bucketTtl) buckets.delete(address);
        // Do not evict live buckets: rotating addresses must not reset existing quotas.
        if (buckets.size >= config.maxIpEntries) throw limited('Сервер занят. Повторите запрос позже.', Math.min(60, bucketTtl / 1000));
      }
      bucket = { tokens: config.burst, updated: time };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(config.burst, bucket.tokens + Math.max(0, time - bucket.updated) * config.requestsPerMinute / 60000);
    bucket.updated = time;
    if (bucket.tokens < 1) throw limited('Слишком много запросов. Повторите запрос позже.', (1 - bucket.tokens) * 60 / config.requestsPerMinute);
    bucket.tokens--;
  }

  function slot() {
    active++;
    let released = false;
    return () => { if (released) return; released = true; active--; drain(); };
  }
  function drain() {
    while (!closed && active < config.maxActive && queue.length) {
      const waiting = queue.shift(); waiting.cleanup();
      if (waiting.req.aborted || waiting.res?.destroyed) { waiting.reject(limited('Запрос прерван.', 1, 499)); continue; }
      waiting.resolve(slot());
    }
  }
  async function acquire(req, res) {
    if (closed) throw limited('API остановлен.', 1, 503);
    charge(req);
    if (req.aborted || res?.destroyed) throw limited('Запрос прерван.', 1, 499);
    if (active < config.maxActive) return slot();
    if (queue.length >= config.maxQueued) throw limited('Сервер занят. Повторите запрос позже.', config.queueTimeoutMs / 1000);
    return new Promise((resolve, reject) => {
      const waiting = { req, res, resolve, reject, cleanup: null };
      const remove = (error) => { const index = queue.indexOf(waiting); if (index < 0) return; queue.splice(index, 1); waiting.cleanup(); reject(error); };
      const aborted = () => remove(limited('Запрос прерван.', 1, 499));
      const timer = setTimeout(() => remove(limited('Сервер занят. Время ожидания истекло.', config.queueTimeoutMs / 1000)), config.queueTimeoutMs);
      waiting.cleanup = () => { clearTimeout(timer); req.off?.('aborted', aborted); res?.off?.('close', aborted); };
      req.once?.('aborted', aborted); res?.once?.('close', aborted);
      queue.push(waiting);
    });
  }
  function close() {
    closed = true;
    for (const waiting of queue.splice(0)) { waiting.cleanup(); waiting.reject(limited('API остановлен.', 1, 503)); }
    buckets.clear();
  }
  return { acquire, close, config, snapshot: () => ({ active, queued: queue.length, ipEntries: buckets.size, closed }) };
}
