import { createFullAudioProviders, fullAudioUrl } from './full-audio.js';
import { createLastfmProvider } from './lastfm.js';

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const TTL = 30 * 60 * 1000;

export class ProviderError extends Error {
  constructor(message, { status = 503, retryAfter = 0, transient = false } = {}) {
    super(message); this.status = status; this.retryAfter = retryAfter; this.transient = transient;
  }
}

export function spotifyId(track) {
  for (const value of [track?.id, track?.uri, track?.spotifyUri, track?.spotify_track_uri]) {
    const match = typeof value === 'string' && value.match(/^(?:spotify:track:|https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/)?([A-Za-z0-9]{22})(?:\?[^\s]*)?$/);
    if (match) return match[1];
  }
  return null;
}

export function validTrackId(id) {
  return typeof id === 'string' && (SPOTIFY_ID.test(id) || (id.startsWith('local:') && id.length > 6 && id.length <= 2048 && !/[\u0000-\u001f]/.test(id)));
}

function trustedUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
  } catch { return null; }
}

export const artworkUrl = value => trustedUrl(value, ['scdn.co', 'spotifycdn.com', 'mzstatic.com', 'dzcdn.net']);
export const previewUrl = value => trustedUrl(value, ['mzstatic.com', 'scdn.co', 'spotifycdn.com', 'itunes.apple.com', 'dzcdn.net']);
export const audioUrl = fullAudioUrl;
export function previewExpiration(value) {
  try {
    const url = new URL(value);
    const expiry = /(?:^|~)exp=(\d+)/.exec(url.searchParams.get('hdnea') || '')?.[1];
    const millis = Number(expiry) * 1000;
    return Number.isFinite(millis) && millis > 0 ? millis : Infinity;
  } catch { return Infinity; }
}
const externalUrl = value => trustedUrl(value, ['open.spotify.com', 'music.apple.com', 'itunes.apple.com', 'deezer.com', 'audius.co', 'jamendo.com', 'jamen.do']);
export const normalizeText = (value = '') => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();

export function safeMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['source', 'previewSource', 'artworkSource', 'genreSource', 'genreScope', 'tagSource', 'matchedTitle', 'matchedArtist', 'audioSource']) if (typeof value[key] === 'string') result[key] = value[key].slice(0, 500);
  for (const key of ['artwork', 'artistArtwork']) { const url = artworkUrl(value[key]); if (url) result[key] = url; }
  const preview = previewUrl(value.previewUrl); if (preview) result.previewUrl = preview;
  const full = value.audioKind === 'full' && audioUrl(value.audioUrl); if (full) result.audioUrl = full;
  if (full || preview) result.audioKind = full ? 'full' : 'preview';
  const audioLink = externalUrl(value.audioExternalUrl); if (audioLink) result.audioExternalUrl = audioLink;
  if (full && Number.isFinite(value.audioDurationMs) && value.audioDurationMs > 0) result.audioDurationMs = value.audioDurationMs;
  const link = externalUrl(value.externalUrl); if (link) result.externalUrl = link;
  const previewLink = externalUrl(value.previewExternalUrl); if (previewLink) result.previewExternalUrl = previewLink;
  const lastfmLink = trustedUrl(value.lastfmUrl, ['last.fm']); if (lastfmLink) result.lastfmUrl = lastfmLink;
  if (typeof value.artistId === 'string' && SPOTIFY_ID.test(value.artistId)) result.artistId = value.artistId;
  for (const key of ['genres', 'artistGenres', 'tags', 'artistTags', 'genreSources']) if (Array.isArray(value[key])) result[key] = [...new Set(value[key].filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 120)))].slice(0, 40);
  if (Number.isFinite(value.durationMs) && value.durationMs >= 0) result.durationMs = value.durationMs;
  if (Number.isFinite(value.lastfmExpiresAt) && value.lastfmExpiresAt >= 0) result.lastfmExpiresAt = value.lastfmExpiresAt;
  if (Number.isFinite(value.matchConfidence)) result.matchConfidence = value.matchConfidence;
  return result.artwork || result.previewUrl || result.audioUrl || result.genres?.length || result.artistGenres?.length || result.tags?.length || result.artistTags?.length || result.lastfmUrl ? result : null;
}

export async function providerJson(url, fetchImpl = fetch, { timeoutMs = 12000, headers = {} } = {}) {
  let response;
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', ...headers } }); }
  catch { throw new ProviderError('Поставщик метаданных временно недоступен.', { transient: true }); }
  if (!response.ok) {
    const header = response.headers?.get('retry-after'); const seconds = Number(header);
    const retryAfter = header ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()) : 0;
    throw new ProviderError(`Поставщик вернул HTTP ${response.status}.`, { status: response.status === 404 ? 404 : 503, transient: response.status === 429 || response.status >= 500, retryAfter: Math.min(3600000, retryAfter || 0) });
  }
  try { return await response.json(); } catch { throw new ProviderError('Поставщик вернул некорректный JSON.', { transient: true }); }
}

// Small, expiring in-memory metadata cache. Neither media nor metadata is written to disk.
function memoryLookup(ttl = TTL, max = 1000) {
  const cache = new Map(), pending = new Map();
  return async (key, load) => {
    const saved = cache.get(key); if (saved?.expires > Date.now()) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const operation = load().then(value => { if (cache.size >= max) cache.delete(cache.keys().next().value); cache.set(key, { value, expires: Math.min(Date.now() + ttl, previewExpiration(value?.previewUrl) - 60000) }); return value; }).finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  };
}

function pacer(interval) {
  let next = 0;
  return async () => { const at = Math.max(Date.now(), next); next = at + interval; const delay = at - Date.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay)); };
}

export function createProviders({ fetchImpl = fetch, env = {}, appleIntervalMs = 3100, deezerIntervalMs = 220, musicbrainzIntervalMs = 1050, lastfmIntervalMs = 350, timeoutMs = 12000, beforeAppleRequest = async () => {} } = {}) {
  const appleLookup = memoryLookup(), deezerLookup = memoryLookup(), albumLookup = memoryLookup(), artistLookup = memoryLookup(6 * 3600000, 500);
  const applePace = pacer(appleIntervalMs), deezerPace = pacer(deezerIntervalMs), mbPace = pacer(musicbrainzIntervalMs);
  const fullAudio = createFullAudioProviders({ fetchImpl, env, timeoutMs: Math.min(timeoutMs, 4500) });
  const lastfm = createLastfmProvider({ fetchImpl, apiKey: env.LASTFM_API_KEY, intervalMs: lastfmIntervalMs, timeoutMs: Math.min(timeoutMs, 9000) });
  async function appleSearch(term, limit) {
    await applePace(); await beforeAppleRequest();
    const params = new URLSearchParams({ term, entity: 'song', media: 'music', country: 'US', limit: String(limit) });
    return providerJson(`https://itunes.apple.com/search?${params}`, fetchImpl, { timeoutMs });
  }
  function appleMetadata(match) {
    return safeMetadata({ artwork: match.artworkUrl100 || match.artworkUrl60, previewUrl: match.previewUrl, previewSource: 'Apple Music / iTunes', previewExternalUrl: match.trackViewUrl, genres: match.primaryGenreName ? [match.primaryGenreName] : [], genreSource: 'Apple Music / iTunes', durationMs: match.trackTimeMillis, source: 'Apple Music / iTunes', artworkSource: 'Apple Music / iTunes', matchedTitle: match.trackName, matchedArtist: match.artistName, externalUrl: match.trackViewUrl, matchConfidence: 1 });
  }
  function requiredNames(track) {
    const title = String(track.name || track.title || '').trim(), artist = String(track.artist || '').trim();
    if (!title || !artist) throw new ProviderError('Для точного поиска нужны название трека и исполнитель.', { status: 400 });
    return { title, artist, key: `${normalizeText(artist)}\0${normalizeText(title)}` };
  }
  return {
    fullAudio: fullAudio.resolve,
    audioSources: fullAudio.sources,
    lastfm: lastfm.resolve,
    metadataSources: () => [
      { id: 'spotify', name: 'Spotify oEmbed', configured: true, requiresKey: false, capabilities: ['artwork'] },
      { id: 'deezer', name: 'Deezer', configured: true, requiresKey: false, capabilities: ['artwork', 'genres'] },
      { id: 'musicbrainz', name: 'MusicBrainz', configured: true, requiresKey: false, capabilities: ['artist-genres'] },
      lastfm.source(),
    ],
    async spotify(track) {
      const id = spotifyId(track); if (!id) throw new ProviderError('В архиве нет Spotify ID этого трека.', { status: 404 });
      const externalUrl = `https://open.spotify.com/track/${id}`;
      const data = await providerJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(externalUrl)}`, fetchImpl, { timeoutMs });
      const artwork = artworkUrl(data.thumbnail_url); if (!artwork) throw new ProviderError('Spotify не вернул обложку.', { status: 404 });
      return { artwork, artworkSource: 'Spotify oEmbed', source: 'Spotify oEmbed', matchedTitle: data.title || track.name || '', matchedArtist: track.artist || '', externalUrl, matchConfidence: 1 };
    },
    async apple(track) {
      const { title, artist, key } = requiredNames(track);
      return appleLookup(key, async () => {
        const data = await appleSearch(`${artist} ${title}`, 25);
        const match = data.results?.find(item => item.kind === 'song' && normalizeText(item.trackName) === normalizeText(title) && normalizeText(item.artistName) === normalizeText(artist));
        const metadata = match && appleMetadata(match);
        if (!metadata) throw new ProviderError('Точное совпадение в Apple Music не найдено.', { status: 404 });
        return metadata;
      });
    },
    async deezer(track, { genres: includeGenres = true } = {}) {
      const { title, artist, key } = requiredNames(track);
      return deezerLookup(`${key}:${includeGenres}`, async () => {
        await deezerPace();
        const params = new URLSearchParams({ q: `${artist} ${title}`, limit: '25' });
        const data = await providerJson(`https://api.deezer.com/search?${params}`, fetchImpl, { timeoutMs });
        // Match the full title: never substitute a live/remixed/cover version.
        const match = data.data?.find(item => normalizeText(item.title) === normalizeText(title) && normalizeText(item.artist?.name) === normalizeText(artist));
        if (!match) throw new ProviderError('Точное совпадение в Deezer не найдено.', { status: 404 });
        let genres = [];
        if (includeGenres && Number.isSafeInteger(match.album?.id) && match.album.id > 0) {
          try {
            genres = await albumLookup(String(match.album.id), async () => {
              await deezerPace(); const album = await providerJson(`https://api.deezer.com/album/${match.album.id}`, fetchImpl, { timeoutMs });
              if (album.id !== match.album.id) return [];
              return (album.genres?.data || []).filter(item => item.id > 0 && typeof item.name === 'string').map(item => item.name);
            });
          } catch { /* A missing genre never hides an otherwise verified track. */ }
        }
        return safeMetadata({ artwork: match.album?.cover_xl || match.album?.cover_big, artistArtwork: match.artist?.picture_xl || match.artist?.picture_big, previewUrl: match.preview, previewSource: 'Deezer', previewExternalUrl: match.link, genres, genreSource: 'Deezer album', durationMs: match.duration * 1000, source: 'Deezer', artworkSource: 'Deezer', matchedTitle: match.title, matchedArtist: match.artist.name, externalUrl: match.link, matchConfidence: 1 });
      });
    },
    async artistGenres(artist) {
      return artistLookup(normalizeText(artist), async () => {
        await mbPace();
        const escaped = String(artist).replace(/["\\]/g, '\\$&');
        const params = new URLSearchParams({ query: `artist:"${escaped}"`, fmt: 'json', limit: '10' });
        const data = await providerJson(`https://musicbrainz.org/ws/2/artist/?${params}`, fetchImpl, { timeoutMs, headers: { 'User-Agent': 'OG.Listener/1.0 (local personal listening-history analytics)' } });
        const matches = (data.artists || []).filter(item => normalizeText(item.name) === normalizeText(artist));
        if (matches.length !== 1) return { genres: [], source: 'MusicBrainz' };
        // MusicBrainz tags include countries/labels as well as genres. Fetch only its curated genre namespace.
        await mbPace();
        const detail = await providerJson(`https://musicbrainz.org/ws/2/artist/${matches[0].id}?inc=genres&fmt=json`, fetchImpl, { timeoutMs, headers: { 'User-Agent': 'OG.Listener/1.0 (local personal listening-history analytics)' } });
        const genres = (detail.genres || []).filter(item => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 12).map(item => item.name);
        return { genres, source: 'MusicBrainz artist genres' };
      });
    },
    async search(query) {
      if (!query || query.length > 300) throw new ProviderError('Укажите запрос длиной до 300 символов.', { status: 400 });
      const data = await appleSearch(query, 15);
      return (data.results || []).filter(item => item.kind === 'song').map(item => ({ id: `apple:${item.trackId}`, name: item.trackName, artist: item.artistName, album: item.collectionName, ...appleMetadata(item) }));
    },
  };
}
