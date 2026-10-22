// Official streaming APIs only. Search responses stay in RAM; media bytes never pass
// through this module. The browser streams the provider URL directly.
const AUDIUS_API = 'https://api.audius.co/v1';
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const error = (message, status = 404, transient = false) => Object.assign(new Error(message), { status, transient });

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

/** A full stream is never inferred from an arbitrary MP3 URL or a preview URL. */
export function fullAudioUrl(value) {
  const url = httpsUrl(value); if (!url) return null;
  if (url.hostname === 'api.audius.co' && /^\/v1\/tracks\/[A-Za-z0-9]+\/stream$/.test(url.pathname)) {
    if ([...url.searchParams.keys()].some(key => key !== 'app_name')) return null;
    return url.href;
  }
  if ((url.hostname === 'storage.jamendo.com' || url.hostname.endsWith('.storage.jamendo.com')) && /^\/?$/.test(url.pathname) && /^\d+$/.test(url.searchParams.get('trackid') || '') && ['mp31', 'mp32', 'ogg', 'flac'].includes(url.searchParams.get('format'))) return url.href;
  return null;
}

export const exactAudioMatch = (title, artist, candidateTitle, candidateArtist) => !!normalize(title) && !!normalize(artist) && normalize(title) === normalize(candidateTitle) && normalize(artist) === normalize(candidateArtist);

export function createFullAudioProviders({ fetchImpl = fetch, env = {}, timeoutMs = 4500, ttlMs = 30 * 60 * 1000, negativeTtlMs = 5 * 60 * 1000 } = {}) {
  const cache = new Map(), pending = new Map();
  const clientId = typeof env.JAMENDO_CLIENT_ID === 'string' ? env.JAMENDO_CLIENT_ID.trim() : '';
  async function json(url) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } }); }
    catch { throw error('Источник полного трека временно недоступен.', 503, true); }
    if (!response.ok) throw error(`Источник полного трека вернул HTTP ${response.status}.`, response.status === 404 ? 404 : 503, response.status === 429 || response.status >= 500);
    try { return await response.json(); } catch { throw error('Источник полного трека вернул некорректный ответ.', 503, true); }
  }
  const attribution = (source, track, title, artist, audioUrl, link, duration) => ({
    audioUrl, audioKind: 'full', audioSource: source, audioExternalUrl: link,
    audioDurationMs: duration * 1000, matchedTitle: title, matchedArtist: artist,
    source, matchConfidence: 1,
  });
  async function audius(track) {
    const title = track.name || track.title, artist = track.artist;
    if (!title || !artist) throw error('Для поиска нужны название и исполнитель.', 400);
    const params = new URLSearchParams({ query: `${artist} ${title}`.slice(0, 1000), limit: '25', app_name: 'OG.Listener' });
    const data = await json(`${AUDIUS_API}/tracks/search?${params}`);
    const matches = (Array.isArray(data.data) ? data.data : []).filter(item => exactAudioMatch(title, artist, item.title, item.user?.name)
      && /^[A-Za-z0-9]+$/.test(item.id || '') && item.is_streamable === true && item.is_stream_gated === false
      && item.is_available !== false && item.is_unlisted !== true && item.is_delete !== true
      && item.access?.stream !== false && (!item.stream_conditions || Object.keys(item.stream_conditions).length === 0)
      && Number.isFinite(item.duration) && item.duration > 0);
    // Display names are not unique. Prefer a verified artist; otherwise accept only
    // one exact artist account, never a same-title cover/remix or ambiguous account.
    const verified = matches.filter(item => item.user?.is_verified === true);
    const candidates = verified.length ? verified : matches;
    const accounts = new Set(candidates.map(item => item.user?.id || item.user?.handle).filter(Boolean));
    if (!candidates.length || accounts.size !== 1) throw error('Точного открытого полного трека в Audius не найдено.');
    const match = candidates[0];
    if (typeof match.permalink !== 'string' || !/^\/[A-Za-z0-9_][^?#\s]*\/[^?#\s]+$/.test(match.permalink) || match.permalink.includes('\\')) throw error('Audius не вернул ссылку на трек.');
    const link = new URL(match.permalink, 'https://audius.co');
    if (link.hostname !== 'audius.co') throw error('Некорректная ссылка Audius.');
    const audioUrl = fullAudioUrl(`${AUDIUS_API}/tracks/${match.id}/stream?app_name=OG.Listener`);
    return attribution('Audius', track, match.title, match.user.name, audioUrl, link.href, match.duration);
  }
  async function jamendo(track) {
    if (!clientId) throw error('Jamendo не настроен: нужен JAMENDO_CLIENT_ID.', 503);
    const title = track.name || track.title, artist = track.artist;
    if (!title || !artist) throw error('Для поиска нужны название и исполнитель.', 400);
    const params = new URLSearchParams({ client_id: clientId, format: 'json', limit: '25', namesearch: title.slice(0, 500), artist_name: artist.slice(0, 500), type: 'single albumtrack', audioformat: 'mp32', include: 'licenses' });
    const data = await json(`https://api.jamendo.com/v3.0/tracks/?${params}`);
    if (data.headers?.status !== 'success' || Number(data.headers?.code) !== 0) throw error('Jamendo не вернул доступный каталог.', 503);
    const matches = (Array.isArray(data.results) ? data.results : []).filter(item => exactAudioMatch(title, artist, item.name, item.artist_name) && /^\d+$/.test(String(item.id)) && fullAudioUrl(item.audio) && Number.isFinite(item.duration) && item.duration > 0);
    const accounts = new Set(matches.map(item => String(item.artist_id || '')).filter(Boolean));
    if (!matches.length || accounts.size !== 1) throw error('Точного полного трека в Jamendo не найдено.');
    const match = matches[0];
    return attribution('Jamendo', track, match.name, match.artist_name, fullAudioUrl(match.audio), `https://www.jamendo.com/track/${match.id}`, match.duration);
  }
  async function resolve(track) {
    const key = `${normalize(track.artist)}\0${normalize(track.name || track.title)}`;
    const saved = cache.get(key); if (saved?.expires > Date.now()) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      // Parallel bounded lookups: a missing secondary catalogue never delays the
      // primary by another full timeout. Credentials are never returned to clients.
      const results = await Promise.allSettled([audius(track), ...(clientId ? [jamendo(track)] : [])]);
      const value = results.find(result => result.status === 'fulfilled')?.value || null;
      if (cache.size >= 1000) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + (value ? ttlMs : negativeTtlMs) });
      return value;
    })().finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  }
  return { audius, jamendo, resolve, sources: () => [
    { id: 'audius', name: 'Audius', audioKind: 'full', configured: true, requiresKey: false, externalUrl: 'https://audius.co' },
    { id: 'jamendo', name: 'Jamendo', audioKind: 'full', configured: !!clientId, requiresKey: true, externalUrl: 'https://www.jamendo.com' },
  ] };
}
