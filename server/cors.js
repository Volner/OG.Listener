const ALLOWED_METHODS = ['GET', 'POST', 'HEAD', 'OPTIONS'];
const ALLOWED_HEADERS = ['content-type'];

function parseOrigin(value, configured = false) {
  if (typeof value !== 'string' || !value || value === 'null') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  // An Origin is a scheme and authority, never a repository path or URL prefix.
  if (url.origin !== value || url.username || url.password || url.search || url.hash || url.hostname.includes('*')) return null;
  if (url.protocol === 'https:') return url;
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])){3}$/.test(url.hostname);
  return url.protocol === 'http:' && (!configured || loopback) ? url : null;
}

function addVaryOrigin(res) {
  const previous = String(res.getHeader('Vary') || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!previous.some(value => value.toLowerCase() === 'origin')) previous.push('Origin');
  res.setHeader('Vary', previous.join(', '));
}

/** Public metadata API only; CORS never enables cookies or archive uploads. */
export function createCorsPolicy(env = {}) {
  const configured = env.CORS_ORIGINS ?? '';
  if (typeof configured !== 'string') throw new Error('CORS_ORIGINS must be a comma-separated list of exact origins.');
  const entries = configured.trim() ? configured.split(',').map(value => value.trim()) : [];
  if (entries.some(value => !parseOrigin(value, true))) {
    throw new Error('CORS_ORIGINS requires exact HTTPS origins without paths, credentials, queries, fragments or wildcards. HTTP is allowed only on loopback.');
  }
  const origins = new Set(entries);
  return (req, res) => {
    addVaryOrigin(res);
    const origin = req.headers.origin;
    if (origin === undefined) return false;
    const parsed = parseOrigin(origin);
    // Preserve integrated localhost/reverse-proxy deployments. Their HTTP server
    // may sit behind TLS termination, so same-origin retains the existing host check.
    const sameHost = parsed && parsed.host === req.headers.host;
    if (!parsed || (!sameHost && !origins.has(origin))) {
      throw Object.assign(new Error('This origin is not allowed to use the API.'), { status: 403 });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    if (req.method !== 'OPTIONS') return false;
    const method = req.headers['access-control-request-method'];
    const requested = req.headers['access-control-request-headers'];
    const headerNames = requested === undefined ? [] : String(requested).split(',').map(value => value.trim().toLowerCase());
    if (!ALLOWED_METHODS.includes(method) || headerNames.some(value => !ALLOWED_HEADERS.includes(value))) {
      throw Object.assign(new Error('The requested CORS method or headers are not allowed.'), { status: 403 });
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 204;
    res.end();
    return true;
  };
}
