import { normalizeApiBase } from '../src/lib/api-url.js';

export function readPagesConfig(env = {}) {
  const apiBase = normalizeApiBase(env.VITE_API_BASE_URL || '');
  if (!apiBase) throw new Error('GitHub Pages requires VITE_API_BASE_URL: set the HTTPS origin of your separately hosted API in repository Variables.');
  const configured = env.VITE_BASE_PATH || '/';
  if (typeof configured !== 'string' || !configured.startsWith('/') || configured.startsWith('//') || /[\\?#\s\u0000-\u001f\u007f]/.test(configured)) {
    throw new Error('VITE_BASE_PATH must be an absolute site path, for example /OG.Listener/.');
  }
  for (const segment of configured.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { throw new Error('VITE_BASE_PATH contains an invalid URL escape.'); }
    if (decoded === '.' || decoded === '..' || /[\\/?#\s\u0000-\u001f\u007f]/.test(decoded)) {
      throw new Error('VITE_BASE_PATH cannot contain traversal or encoded path separators.');
    }
  }
  return { apiBase, base: configured.endsWith('/') ? configured : `${configured}/` };
}
