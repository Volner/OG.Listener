const ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const list = value => Array.isArray(value) ? value : value ? [value] : [];

// Last.fm tags are community annotations, including moods, countries and personal
// labels. Keep those as tags; only these recognized musical styles enter genres.
const GENRES = new Map();
for (const name of [
  'Acid House', 'Acid Jazz', 'Acoustic', 'Afrobeat', 'Afrobeats', 'Alternative',
  'Alternative Hip-Hop', 'Alternative Metal', 'Alternative R&B', 'Alternative Rock',
  'Ambient', 'Americana', 'Art Pop', 'Art Rock', 'Atmospheric Black Metal',
  'Avant-Garde', 'Bachata', 'Baroque', 'Bedroom Pop', 'Big Beat', 'Black Metal',
  'Bluegrass', 'Blues', 'Blues Rock', 'Bossa Nova', 'Breakbeat', 'Breakcore',
  'Britpop', 'Chamber Pop', 'Chillout', 'Chillwave', 'Classical', 'Cloud Rap',
  'Comedy', 'Contemporary Classical', 'Country', 'Country Rock', 'Crunk',
  'Dance', 'Dance Pop', 'Dancehall', 'Dark Ambient', 'Darkwave', 'Death Metal',
  'Deathcore', 'Deep House', 'Disco', 'Doom Metal', 'Downtempo', 'Dream Pop',
  'Drill', 'Drone', 'Drum and Bass', 'Dub', 'Dub Techno', 'Dubstep', 'EBM',
  'Electro', 'Electro House', 'Electro Swing', 'Electroclash', 'Electronic',
  'Electronica', 'Electropop', 'Emo', 'Emo Rap', 'Experimental', 'Folk',
  'Folk Metal', 'Folk Rock', 'Funk', 'Funk Metal', 'Future Bass', 'Future Garage',
  'Garage Rock', 'Glam Metal', 'Glam Rock', 'Glitch', 'Gospel', 'Gothic Metal',
  'Gothic Rock', 'Grime', 'Grindcore', 'Groove Metal', 'Grunge', 'Hard Rock',
  'Hardcore', 'Hardcore Punk', 'Hardstyle', 'Heavy Metal', 'Hip-Hop', 'House',
  'Hyperpop', 'IDM', 'Indie', 'Indie Folk', 'Indie Pop', 'Indie Rock',
  'Industrial', 'Industrial Metal', 'Industrial Rock', 'J-Pop', 'J-Rock', 'Jazz',
  'Jazz Fusion', 'Jazz Rap', 'K-Pop', 'Latin', 'Latin Pop', 'Lo-Fi',
  'Math Rock', 'Melodic Death Metal', 'Melodic Hardcore', 'Metal', 'Metalcore',
  'Minimal', 'Minimal Techno', 'Neo-Soul', 'Neoclassical', 'New Age', 'New Wave',
  'Noise', 'Noise Pop', 'Noise Rock', 'Nu Metal', 'Opera', 'Orchestral',
  'Phonk', 'Pop', 'Pop Punk', 'Pop Rap', 'Pop Rock', 'Post-Hardcore',
  'Post-Metal', 'Post-Punk', 'Post-Rock', 'Power Metal', 'Power Pop',
  'Progressive House', 'Progressive Metal', 'Progressive Rock', 'Psychedelic',
  'Psychedelic Pop', 'Psychedelic Rock', 'Psytrance', 'Punk', 'Punk Rock',
  'R&B', 'Ragga', 'Ragtime', 'Rap', 'Reggae', 'Reggaeton', 'Rock',
  'Rock and Roll', 'Rockabilly', 'Salsa', 'Shoegaze', 'Singer-Songwriter',
  'Ska', 'Slowcore', 'Smooth Jazz', 'Soul', 'Soul Jazz', 'Southern Rock',
  'Space Rock', 'Speed Metal', 'Stoner Metal', 'Stoner Rock', 'Surf Rock',
  'Swing', 'Symphonic Metal', 'Synth-Pop', 'Synthwave', 'Tech House',
  'Techno', 'Thrash Metal', 'Trance', 'Trap', 'Trip-Hop', 'UK Garage',
  'Vaporwave', 'Witch House', 'World',
]) GENRES.set(normalize(name), name);
for (const [alias, name] of [
  ['hiphop', 'Hip-Hop'], ['hip hop', 'Hip-Hop'], ['rnb', 'R&B'], ['r and b', 'R&B'],
  ['rhythm and blues', 'R&B'], ['synthpop', 'Synth-Pop'], ['postpunk', 'Post-Punk'],
  ['dnb', 'Drum and Bass'], ['drum n bass', 'Drum and Bass'], ['drum bass', 'Drum and Bass'],
  ['lofi', 'Lo-Fi'], ['nu-metal', 'Nu Metal'], ['alt rock', 'Alternative Rock'],
  ['russian rap', 'Rap'], ['русский рэп', 'Rap'], ['трэп', 'Trap'], ['хип хоп', 'Hip-Hop'],
]) GENRES.set(normalize(alias), name);

export function lastfmGenreTags(tags) {
  return [...new Set(tags.map(tag => GENRES.get(normalize(tag))).filter(Boolean))];
}

function failure(message, { status = 503, transient = false, retryAfter = 0 } = {}) {
  return Object.assign(new Error(message), { status, transient, retryAfter });
}
function catalogUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && ['www.last.fm', 'last.fm'].includes(url.hostname) && !url.username && !url.password && !url.port && url.pathname.startsWith('/music/')
      ? `https://${url.host}${url.pathname}` : null;
  } catch { return null; }
}
function tagsOf(value) {
  return [...new Set(list(value?.tag).map(tag => String(tag?.name || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 30);
}

/** Metadata only: no audio, images, user login, scrobbling or filesystem writes. */
export function createLastfmProvider({ fetchImpl = fetch, apiKey = '', intervalMs = 350, timeoutMs = 9000, ttlMs = 6 * 3600000, negativeTtlMs = 5 * 60000, maxEntries = 3000 } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const cache = new Map(), pending = new Map();
  let nextRequestAt = 0, blockedUntil = 0;
  const source = () => ({ id: 'lastfm', name: 'Last.fm', configured: !!key, requiresKey: true, capabilities: ['tags', 'genres'], externalUrl: 'https://www.last.fm/api' });
  function save(cacheKey, value, expires, error = false) {
    if (expires <= Date.now()) return;
    if (cache.size >= maxEntries && !cache.has(cacheKey)) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value, expires, error });
  }
  async function request(method, params) {
    if (!key) throw failure('Last.fm не настроен: нужен серверный LASTFM_API_KEY.', { status: 503 });
    if (blockedUntil > Date.now()) throw failure('Last.fm временно приостановлен после ограничения запросов.', { transient: true, retryAfter: blockedUntil - Date.now() });
    const at = Math.max(Date.now(), nextRequestAt); nextRequestAt = at + intervalMs;
    if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()));
    if (blockedUntil > Date.now()) throw failure('Last.fm временно приостановлен после ограничения запросов.', { transient: true, retryAfter: blockedUntil - Date.now() });
    const query = new URLSearchParams({ method, api_key: key, format: 'json', autocorrect: '0', ...params });
    let response;
    try { response = await fetchImpl(`${ENDPOINT}?${query}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } }); }
    catch { throw failure('Last.fm временно недоступен.', { transient: true }); }
    const retryHeader = response.headers?.get('retry-after');
    const retryMs = retryHeader ? (Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now()) : 60000;
    const retryAfter = Math.min(3600000, Math.max(1000, retryMs || 60000));
    if (response.status === 429) {
      blockedUntil = Date.now() + retryAfter;
      throw failure('Last.fm ограничил частоту запросов.', { transient: true, retryAfter });
    }
    if (!response.ok) throw failure(`Last.fm вернул HTTP ${response.status}.`, { status: response.status === 404 ? 404 : 503, transient: response.status >= 500 });
    let data;
    try { data = await response.json(); } catch { throw failure('Last.fm вернул некорректный JSON.', { transient: true }); }
    if (data.error) {
      const code = Number(data.error);
      if ([10, 26].includes(code)) blockedUntil = Date.now() + 3600000;
      if (code === 29) blockedUntil = Date.now() + retryAfter;
      throw failure(code === 29 ? 'Last.fm ограничил частоту запросов.' : [10, 26].includes(code) ? 'Last.fm API key недействителен или приостановлен.' : 'Метаданные Last.fm недоступны.', { status: [6, 7].includes(code) ? 404 : 503, transient: [8, 11, 16, 29].includes(code), retryAfter: code === 29 ? retryAfter : 0 });
    }
    const directive = response.headers?.get('cache-control') || '';
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(directive)?.[1];
    const expires = /(?:^|,)\s*(?:no-store|no-cache)(?:\s|,|$)/i.test(directive) ? Date.now() : Date.now() + (maxAge ? Math.min(ttlMs, Number(maxAge) * 1000) : ttlMs);
    return { data, expires };
  }
  async function lookup(cacheKey, load) {
    const previous = cache.get(cacheKey);
    if (previous?.expires > Date.now()) { if (previous.error) throw previous.value; return previous.value; }
    if (previous) cache.delete(cacheKey);
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const operation = load().then(({ value, expires }) => { save(cacheKey, value, expires); return value; }).catch(error => {
      if (error.status === 404) save(cacheKey, error, Date.now() + negativeTtlMs, true);
      throw error;
    }).finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, operation); return operation;
  }
  async function artistInfo(name) {
    return lookup(`artist:${normalize(name)}`, async () => {
      const { data, expires } = await request('artist.getInfo', { artist: name });
      if (!normalize(data.artist?.name) || normalize(data.artist.name) !== normalize(name)) throw failure('Точный исполнитель в Last.fm не найден.', { status: 404 });
      const tags = tagsOf(data.artist.tags);
      return { value: { tags, genres: lastfmGenreTags(tags), url: catalogUrl(data.artist.url), expires }, expires };
    });
  }
  return {
    source,
    async resolve(track) {
      if (!key) return null;
      const title = String(track?.name || track?.title || '').trim(), artist = String(track?.artist || '').trim();
      if (!title || !artist) throw failure('Для Last.fm нужны название трека и исполнитель.', { status: 400 });
      return lookup(`track:${normalize(artist)}\0${normalize(title)}`, async () => {
        const { data, expires } = await request('track.getInfo', { track: title, artist });
        const item = data.track;
        if (!normalize(item?.name) || normalize(item.name) !== normalize(title) || normalize(item.artist?.name) !== normalize(artist)) throw failure('Точное совпадение трека в Last.fm не найдено.', { status: 404 });
        const tags = tagsOf(item.toptags), genres = lastfmGenreTags(tags);
        let combinedExpires = expires;
        const value = { tags, tagSource: 'Last.fm community tags', lastfmUrl: catalogUrl(item.url), matchedTitle: item.name, matchedArtist: item.artist.name };
        if (genres.length) Object.assign(value, { genres, genreSource: 'Last.fm track genre tags', genreScope: 'track' });
        else {
          // Artist tags are a fallback, explicitly marked, and shared by all tracks.
          try {
            const artistData = await artistInfo(artist);
            combinedExpires = Math.min(combinedExpires, artistData.expires);
            value.artistTags = artistData.tags;
            if (artistData.genres.length) Object.assign(value, { genres: artistData.genres, artistGenres: artistData.genres, genreSource: 'Last.fm artist genre tags', genreScope: 'artist' });
          } catch { /* An unavailable artist never hides a verified track. */ }
        }
        // Also cap the merged catalog entry, so it cannot outlive this source's
        // cache directives after passing through the application's metadata cache.
        value.lastfmExpiresAt = combinedExpires;
        return { value, expires: combinedExpires };
      });
    },
  };
}
