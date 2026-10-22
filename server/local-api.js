import { createProviders, spotifyId, validTrackId, safeMetadata, artworkUrl, previewUrl, audioUrl, previewExpiration } from './providers.js';
import { createRequestLimiter } from './request-limits.js';
import { createCorsPolicy } from './cors.js';
import { readJsonBody } from './request-body.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function json(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
}
const readJson = req => readJsonBody(req);

/** Metadata only. Images/audio are remote URLs; no media is fetched or persisted here. */
export function createLocalApi({ root = process.cwd(), fetchImpl = fetch, env = {}, limits, trustProxy, clientIp, requestIntervalMs = 180, appleIntervalMs = 3100, deezerIntervalMs = 220, musicbrainzIntervalMs = 1050, lastfmIntervalMs = 350, metadataTtlMs = 30 * 60 * 1000, negativeTtlMs = 5 * 60 * 1000, providers: injectedProviders, audienceHandler, beforeReady } = {}) {
  const cors = createCorsPolicy(env);
  const providers = injectedProviders || createProviders({ fetchImpl, env, appleIntervalMs, deezerIntervalMs, musicbrainzIntervalMs, lastfmIntervalMs });
  const limiter = createRequestLimiter({ env, limits, trustProxy, clientIp });
  const catalog = new Map(), inFlight = new Map(), misses = new Map();
  let closed = false, nextNetworkAt = 0;
  const ready = Promise.resolve(beforeReady);
  const status = () => ({ ok: !closed, storage: 'memory', mediaFiles: 0 });
  function saved(id) {
    const entry = catalog.get(id);
    if (entry?.expires > Date.now()) return entry.value;
    if (entry) catalog.delete(id);
    return null;
  }
  function cache(id, metadata) {
    const clean = safeMetadata(metadata); if (!clean) return null;
    const previous = saved(id) || {};
    const next = { ...previous, ...clean, genres: clean.genres?.length ? clean.genres : previous.genres || [], artistGenres: clean.artistGenres?.length ? clean.artistGenres : previous.artistGenres || [] };
    // Genre/preview enrichment may finish after playback found a full recording.
    // Preserve that verified recording independently of the preview's format.
    if (previous.audioKind === 'full' && previous.audioUrl && clean.audioKind !== 'full') {
      for (const key of ['audioUrl', 'audioKind', 'audioSource', 'audioExternalUrl', 'audioDurationMs']) next[key] = previous[key];
    }
    if (next.audioUrl) next.audioKind = 'full';
    if (catalog.size >= 10000 && !catalog.has(id)) catalog.delete(catalog.keys().next().value);
    catalog.set(id, { value: next, expires: Math.min(Date.now() + metadataTtlMs, previewExpiration(next.previewUrl) - 60000, next.lastfmExpiresAt ?? Infinity) });
    return next;
  }
  async function pace() {
    if (closed) throw fail('Локальный API остановлен.', 503);
    const at = Math.max(Date.now(), nextNetworkAt); nextNetworkAt = at + requestIntervalMs;
    if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()));
    if (closed) throw fail('Локальный API остановлен.', 503);
  }
  function cleanTrack(track) {
    if (!track || !validTrackId(track.id)) return null;
    return { id: track.id, name: String(track.name || track.title || '').slice(0, 1000), artist: String(track.artist || '').slice(0, 1000), uri: typeof track.uri === 'string' ? track.uri.slice(0, 300) : undefined };
  }
  async function spotifyMetadata(track) {
    const key = `spotify:${track.id}`;
    const missed = misses.get(key); if (missed?.expires > Date.now()) throw fail(missed.message, missed.status);
    if (inFlight.has(key)) return inFlight.get(key);
    const operation = (async () => { await pace(); return providers.spotify(track); })().catch(error => {
      if (misses.size >= 10000) misses.delete(misses.keys().next().value);
      misses.set(key, { expires: Date.now() + (error.transient ? Math.min(negativeTtlMs, 30000) : negativeTtlMs), message: error.message, status: error.status || 503 });
      throw error;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, operation); return operation;
  }
  async function resolveTrack(track, { apple = false, details = true, full = false } = {}) {
    const id = track.id, key = `${id}:${apple}:${details}:${full}`;
    const previous = saved(id);
    if (previous && (!details || previous.detailsResolved) && (!apple || previous.audioResolved) && (!full || previous.fullResolved)) return previous;
    const miss = misses.get(key); if (miss?.expires > Date.now()) { if (previous) return previous; throw fail(miss.message, miss.status); }
    if (inFlight.has(key)) return inFlight.get(key);
    // A detail request can reuse an ongoing visible-cover lookup before enriching it.
    const pendingCover = (details && inFlight.get(`${id}:false:false:false`)) || (apple && inFlight.get(`${id}:false:true:false`));
    const operation = (async () => {
      if (pendingCover && !(full && !details)) await pendingCover.catch(() => {});
      let metadata = saved(id), lastError;
      // Full-stream search is an explicit playback action, never a visible-cover
      // background task. Run it beside metadata, and keep a verified preview.
      const fullLookup = full && !metadata?.fullResolved && track.name && track.artist && providers.fullAudio
        ? providers.fullAudio(track).catch(() => null) : Promise.resolve(null);
      const remember = value => { const cover = metadata?.artwork; const coverSource = metadata?.artworkSource; metadata = cache(id, { ...value, ...(cover ? { artwork: cover, artworkSource: coverSource } : {}) }); };
      if (!metadata?.artwork && spotifyId(track) && providers.spotify) {
        try { remember(await spotifyMetadata(track)); } catch (error) { lastError = error; }
      }
      if (((details && !metadata?.detailsResolved) || (apple && !metadata?.previewUrl)) && track.name && track.artist && providers.deezer) {
        try { await pace(); remember(await providers.deezer(track, { genres: details })); } catch (error) { lastError = error; }
      }
      if (apple && (!metadata?.previewUrl || (details && !metadata?.genres?.length)) && track.name && track.artist && providers.apple) {
        try { remember(await providers.apple(track)); } catch (error) { lastError = error; }
      }
      if (details && !metadata?.detailsResolved && track.name && track.artist && providers.lastfm) {
        try {
          const tags = await providers.lastfm(track);
          if (tags) remember({ ...tags, genres: [...new Set([...(metadata?.genres || []), ...(tags.genres || [])])], genreSources: [...new Set([...(metadata?.genreSources || []), metadata?.genreSource, tags.genreSource].filter(Boolean))], genreSource: metadata?.genreSource || tags.genreSource });
        } catch { /* Optional community tags never block covers or playback. */ }
      }
      if (details && !metadata?.genres?.length && track.artist && providers.artistGenres) {
        try { const tags = await providers.artistGenres(track.artist); if (tags.genres?.length) remember({ artistGenres: tags.genres, genres: tags.genres, genreSource: tags.source, source: metadata?.source || tags.source }); } catch { /* Unknown stays unknown. */ }
      }
      const fullMetadata = await fullLookup;
      if (fullMetadata) remember(fullMetadata);
      if (!metadata) {
        const error = lastError || fail('Точных метаданных этого трека нет в доступных каталогах.', 404);
        if (misses.size >= 10000) misses.delete(misses.keys().next().value);
        misses.set(key, { expires: Date.now() + (error.transient ? Math.min(negativeTtlMs, 30000) : negativeTtlMs), message: error.message, status: error.status || 503 }); throw error;
      }
      // Resolution markers live in process memory only, never provider metadata or storage.
      const complete = { ...metadata, detailsResolved: details || metadata.detailsResolved, audioResolved: apple || metadata.audioResolved, fullResolved: full || metadata.fullResolved };
      catalog.set(id, { value: complete, expires: Math.min(Date.now() + metadataTtlMs, previewExpiration(complete.previewUrl) - 60000, complete.lastfmExpiresAt ?? Infinity) });
      return complete;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, operation); return operation;
  }
  const publicMetadata = (id, metadata) => { const { detailsResolved, audioResolved, fullResolved, ...value } = metadata; return { id, ...value }; };

  async function route(req, res, next) {
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { return next(); }
    if (/^\/upload\/(archives|cache)(?:\/|$)/.test(url.pathname)) return json(res, 403, { error: 'Файлы архива недоступны по прямой ссылке.' });
    if (!url.pathname.startsWith('/api/')) return next();
    let release;
    try {
      if (cors(req, res)) return;
      await ready; if (closed) throw fail('Локальный API остановлен.', 503);
      release = await limiter.acquire(req, res);
      if (['/api/upload', '/api/catalog', '/api/catalog/jobs', '/api/catalog/pause', '/api/catalog/resume'].includes(url.pathname)) {
        // Do not read, retain, or persist legacy archive bodies.
        res.setHeader('Connection', 'close');
        return json(res, 410, { error: 'Маршрут удалён. Архив обрабатывается только в браузере.' });
      }
      if (audienceHandler && url.pathname.startsWith('/api/audience') && await audienceHandler(req, res, url)) return;
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
      if (req.method === 'GET' && url.pathname === '/api/catalog/providers') return json(res, 200, { sources: providers.metadataSources?.() || [], storage: 'memory', mediaFiles: 0 });
      if (req.method === 'GET' && url.pathname === '/api/audio/providers') return json(res, 200, { sources: [
        ...(providers.audioSources?.() || []),
        { id: 'deezer', name: 'Deezer', audioKind: 'preview', configured: !!providers.deezer, requiresKey: false, externalUrl: 'https://www.deezer.com' },
        { id: 'apple', name: 'Apple Music / iTunes', audioKind: 'preview', configured: !!providers.apple, requiresKey: false, externalUrl: 'https://music.apple.com' },
      ] });
      if (req.method === 'POST' && url.pathname === '/api/catalog/resolve') {
        const body = await readJson(req); if (!Array.isArray(body.tracks) || body.tracks.length < 1 || body.tracks.length > 100) throw fail('Передайте от 1 до 100 видимых треков.');
        const tracks = [...new Map(body.tracks.map(cleanTrack).filter(Boolean).map(track => [track.id, track])).values()];
        const entries = {}, errors = []; let position = 0;
        await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, async () => {
          while (position < tracks.length) {
            // Already-started lookups may be shared with another visitor. Let
            // those finish, but never schedule the abandoned batch's next track.
            if (req.aborted || res.destroyed || closed) break;
            const track = tracks[position++];
            try { entries[track.id] = publicMetadata(track.id, await resolveTrack(track, { apple: body.apple === true, details: body.details !== false })); }
            catch (error) { errors.push({ id: track.id, error: error.message, status: error.status || 503, ...(error.status === 429 ? { retryAfterSeconds: error.retryAfterSeconds || 15 } : {}) }); }
          }
        }));
        return json(res, 200, { entries, errors, storage: 'memory', mediaFiles: 0 });
      }
      if (req.method === 'GET' && url.pathname === '/api/tracks') return json(res, 200, { results: await providers.search((url.searchParams.get('query') || '').trim()), exactMatchRequired: true });
      const trackRoute = url.pathname.match(/^\/api\/tracks\/([^/]+)$/);
      if (req.method === 'GET' && trackRoute) {
        let id; try { id = decodeURIComponent(trackRoute[1]); } catch { throw fail('Некорректный ID трека.'); }
        if (!validTrackId(id)) throw fail('Нужен Spotify ID либо local: ID трека.');
        const track = cleanTrack({ id, name: url.searchParams.get('title'), artist: url.searchParams.get('artist') });
        return json(res, 200, publicMetadata(id, await resolveTrack(track, { apple: url.searchParams.get('apple') !== 'false', details: url.searchParams.get('details') !== 'false', full: url.searchParams.get('full') !== 'false' })));
      }
      const mediaRoute = url.pathname.match(/^\/api\/(audio|artwork)\/([^/]+)$/);
      if (['GET', 'HEAD'].includes(req.method) && mediaRoute) {
        let id; try { id = decodeURIComponent(mediaRoute[2]); } catch { throw fail('Некорректный ID трека.'); }
        if (!validTrackId(id)) throw fail('Некорректный ID трека.');
        const metadata = saved(id), remote = mediaRoute[1] === 'audio' ? audioUrl(metadata?.audioUrl) || previewUrl(metadata?.previewUrl) : artworkUrl(metadata?.artwork);
        if (!remote) throw fail(mediaRoute[1] === 'audio' ? 'Превью этого трека недоступно.' : 'Обложка не найдена.', 404);
        res.statusCode = 302; res.setHeader('Location', remote); res.setHeader('Cache-Control', 'no-store'); return res.end();
      }
      return json(res, 404, { error: 'Маршрут API не найден.' });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error.status === 429 && !error.retryAfterSeconds) error.retryAfterSeconds = 15;
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      if (error.status === 429) res.setHeader('Connection', 'close');
      return json(res, error.status || 503, { error: error.message || 'Поставщик временно недоступен.', ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
    } finally { release?.(); }
  }
  return { middleware: (req, res, next) => route(req, res, next), close: async () => { closed = true; limiter.close(); await ready; catalog.clear(); misses.clear(); }, ready, status, limiter, env };
}
