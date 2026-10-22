const HASH_ROUTING = import.meta.env?.MODE === 'pages';
const BASE_PATH = import.meta.env?.BASE_URL || '/';

/** Hash routes stay within index.html on hosts without a SPA fallback. */
export function readRoute(location = globalThis.location, { hashRouting = HASH_ROUTING } = {}) {
  if (!hashRouting) return location.pathname;
  return location.hash === '#/upload' ? '/upload' : '/';
}

export function routeHref(route, { hashRouting = HASH_ROUTING, base = BASE_PATH } = {}) {
  if (!['/', '/upload'].includes(route)) throw new TypeError('Unknown application route.');
  if (!hashRouting) return route;
  if (typeof base !== 'string' || !base.startsWith('/') || base.startsWith('//') || /[\\?#\s]/.test(base) || base.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new TypeError('Application base must be an absolute URL path.');
  }
  return `${base.endsWith('/') ? base : `${base}/`}#${route}`;
}

export function routeChangeEvents({ hashRouting = HASH_ROUTING } = {}) {
  return hashRouting ? ['popstate', 'hashchange'] : ['popstate'];
}
