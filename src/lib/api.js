import { apiUrl } from './api-url.js';

async function apiRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  let result;
  try { result = await response.json(); }
  catch {
    if (response.ok) throw new Error('Не удалось подключиться к музыкальному каталогу. Повторите попытку позже.');
    result = {};
  }
  if (!response.ok) {
    const error = new Error(result.error?.message || result.error || `Музыкальный каталог: HTTP ${response.status}`);
    error.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    const seconds = Number(retryAfter);
    error.retryAfterSeconds = Math.max(0, Number(result.retryAfterSeconds) || (retryAfter ? Number.isFinite(seconds) ? seconds : (Date.parse(retryAfter) - Date.now()) / 1000 : 0) || 0);
    throw error;
  }
  return result;
}

// Resolve only the currently visible tracks. URLs/metadata stay in process memory.
export const resolveCatalogBatch = (tracks, { signal, apple = false, details = true } = {}) => apiRequest('/api/catalog/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks: tracks.map(track => ({ id: track.id, name: track.name || track.title || '', artist: track.artist || '', ...(track.uri ? { uri: track.uri } : {}) })), apple, details }), signal });
