/** A separately hosted API is an origin, never a proxy URL or a secret. */
export function normalizeApiBase(value = '', { allowLoopbackHttp = false } = {}) {
  if (typeof value !== 'string') throw new TypeError('API base must be a URL origin.');
  const configured = value.trim();
  if (!configured) return '';
  let url;
  try { url = new URL(configured); }
  catch { throw new TypeError('API base must be a valid URL origin.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) {
    throw new TypeError('API base must use HTTPS. HTTP loopback is allowed only during development or tests.');
  }
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(configured) || /[\\?#@\s]/.test(configured) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('API base must contain only an origin, without credentials, a path, a query or a fragment.');
  }
  return url.origin;
}

export function apiUrl(path, configuredBase = import.meta.env?.VITE_API_BASE_URL || '') {
  if (typeof path !== 'string' || !/^\/api(?:\/|\?|$)/.test(path) || /[\\#\s\u0000-\u001f\u007f]/.test(path)) {
    throw new TypeError('API route must be an absolute /api path.');
  }
  for (const segment of path.split('?')[0].split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw new TypeError('API route contains an invalid URL escape.'); }
    if (decoded === '.' || decoded === '..') throw new TypeError('API route cannot traverse paths.');
  }
  const base = normalizeApiBase(configuredBase, { allowLoopbackHttp: import.meta.env?.DEV === true || import.meta.env?.MODE === 'test' });
  // Concatenation preserves encoded slashes and percent signs in opaque track IDs.
  return `${base}${path}`;
}
