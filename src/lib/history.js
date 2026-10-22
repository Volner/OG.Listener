import { unzipSync } from 'fflate';

const normalized = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export const normalizeSearchText = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
function matchesSearch(value, query) {
  const haystack = normalizeSearchText(value);
  const compact = haystack.replace(/\s/g, '');
  return normalizeSearchText(query).split(' ').filter(Boolean).every(part => haystack.includes(part) || compact.includes(part));
}
const text = (value) => typeof value === 'string' ? value.trim() : '';
const asIso = (seconds) => new Date(seconds * 1000).toISOString();
const nameCollator = new Intl.Collator();
const byListening = (a, b) => b.plays - a.plays || b.msPlayed - a.msPlayed || nameCollator.compare(a.name, b.name);

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const input = value.trim();
  // The basic Spotify export has UTC dates without an explicit timezone.
  const withZone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input)
    ? `${input.replace(' ', 'T')}Z` : input;
  return Date.parse(withZone);
}

function growthTimestamp(value) {
  const input = text(value);
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(input)?.[1];
  if (!day) return NaN;
  const dayTime = Date.parse(`${day}T00:00:00Z`);
  // Date.parse rolls dates such as February 31 into March; a calendar date must round-trip.
  if (!Number.isFinite(dayTime) || new Date(dayTime).toISOString().slice(0, 10) !== day) return NaN;
  return input === day ? dayTime : timestamp(input);
}

function documentRows(document) {
  if (Array.isArray(document)) return document;
  const data = document?.data ?? document?.records ?? document?.history;
  return Array.isArray(data) ? data : [];
}

/** Normalize official extended or basic Spotify exports without retaining private fields. */
export function normalizeHistoryDocuments(documents, source = 'Spotify import') {
  const tracks = [];
  const events = [];
  const trackIndices = new Map();
  const seen = new Set();
  let rawEventCount = 0;
  let duplicatesRemoved = 0;
  let excludedCount = 0;

  for (const document of documents) {
    for (const row of documentRows(document)) {
      rawEventCount += 1;
      const name = text(row?.master_metadata_track_name ?? row?.trackName);
      const artist = text(row?.master_metadata_album_artist_name ?? row?.artistName);
      const uri = text(row?.spotify_track_uri);
      const milliseconds = Number(row?.ms_played ?? row?.msPlayed);
      const time = timestamp(row?.ts ?? row?.endTime);
      const podcast = row?.spotify_episode_uri || row?.episode_name || row?.audiobook_uri || row?.audiobook_title;
      if (!name || !artist || podcast || !Number.isFinite(time) || !Number.isFinite(milliseconds) || milliseconds < 0) {
        excludedCount += 1;
        continue;
      }
      const msPlayed = Math.round(milliseconds);
      const seconds = Math.floor(time / 1000);
      const match = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri);
      const id = match?.[1] ?? `local:${normalized(artist)}::${normalized(name)}`;
      // These fields distinguish simultaneous events on different devices. They are never stored.
      const fingerprint = JSON.stringify([seconds, uri || id, msPlayed, row.platform ?? '', row.reason_start ?? '', row.reason_end ?? '']);
      if (seen.has(fingerprint)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(fingerprint);
      let index = trackIndices.get(id);
      const album = text(row?.master_metadata_album_album_name ?? row?.albumName);
      if (index === undefined) {
        index = tracks.length;
        trackIndices.set(id, index);
        tracks.push({ id, name, artist, album, uri: match ? uri : '', firstPlayed: asIso(seconds) });
      } else {
        const track = tracks[index];
        if (seconds < Date.parse(track.firstPlayed) / 1000) track.firstPlayed = asIso(seconds);
        if (!track.album && album) track.album = album;
      }
      const skipped = row?.skipped === true || row?.skipped === 1 || row?.skipped === 'true';
      events.push([index, seconds, msPlayed, skipped ? 1 : 0]);
    }
  }
  events.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const audibleTracks = new Set();
  for (const [index, seconds, msPlayed] of events) {
    if (msPlayed > 0 && !audibleTracks.has(index)) {
      tracks[index].firstPlayed = asIso(seconds);
      audibleTracks.add(index);
    }
  }
  return {
    version: 1, source, importedAt: new Date().toISOString(), tracks, events,
    fileCount: documents.length, rawEventCount, duplicatesRemoved, excludedCount,
  };
}

/** Read JSON files or a ZIP directly in the browser; audio and private export fields stay local. */
export async function parseHistoryFiles(files) {
  const selected = Array.from(files ?? []);
  if (!selected.length) throw new Error('Выберите ZIP-архив или JSON-файлы истории Spotify.');
  const documents = [];
  const decoder = new TextDecoder('utf-8');
  const append = (name, bytes) => {
    try {
      documents.push({ name, data: JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, '')) });
    } catch {
      throw new Error(`Не удалось прочитать JSON: ${name}`);
    }
  };
  for (const file of selected) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      let archive;
      try {
        archive = unzipSync(bytes, { filter: (entry) => /\.json$/i.test(entry.name) && !entry.name.startsWith('__MACOSX/') });
      } catch {
        throw new Error(`Не удалось открыть ZIP-архив: ${file.name}`);
      }
      for (const [name, contents] of Object.entries(archive)) append(name, contents);
    } else if (/\.json$/i.test(file.name)) {
      append(file.name, bytes);
    }
  }
  if (!documents.length) throw new Error('В выбранных файлах нет JSON-истории Spotify.');
  const dataset = normalizeHistoryDocuments(documents, selected.map((file) => file.name).join(', '));
  if (!dataset.events.length) throw new Error('Не найдены музыкальные прослушивания. Нужны StreamingHistory или Streaming_History_Audio JSON.');
  return dataset;
}

function csvRows(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  // Also accept Excel's semicolon-separated files without changing quoted artist names.
  const firstLine = String(input).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const source = String(input).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === separator && !quoted) {
      row.push(field.trim()); field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('В CSV не закрыта кавычка.');
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** Historical snapshots are user-supplied evidence, never inferred from a current audience. */
export function parseGrowthCsv(input) {
  const rows = csvRows(input);
  if (!rows.length) throw new Error('CSV пуст.');
  const headers = rows.shift().map(normalized);
  for (const required of ['artist', 'date', 'listeners']) {
    if (!headers.includes(required)) throw new Error(`В CSV нужен столбец ${required}.`);
  }
  const now = Date.now();
  return rows.map((values, index) => {
    const row = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
    const time = growthTimestamp(row.date);
    const listeners = Number(row.listeners.replace(/\s/g, ''));
    if (!row.artist || !row.listeners || !Number.isFinite(time) || !Number.isFinite(listeners) || listeners < 0) {
      throw new Error(`Некорректные данные в строке ${index + 2}: проверьте artist, date и listeners.`);
    }
    if (time > now) throw new Error(`Дата в строке ${index + 2} находится в будущем. Укажите дату уже сделанного снимка аудитории.`);
    return {
      artist: row.artist, date: new Date(time).toISOString(), listeners,
      source: row.source || 'CSV', metric: normalized(row.metric || 'monthly_listeners').replace(/[ -]+/g, '_'),
    };
  });
}

const EMPTY_METADATA = Object.freeze({});
const EMPTY_GROWTH = Object.freeze([]);
const UNKNOWN_GROWTH = Object.freeze({ growthScore: null, baseline: null, current: null, growthSource: null, growthMetric: null, baselineDate: null, currentDate: null });
const datasetCaches = new WeakMap();
const growthCaches = new WeakMap();

function growthIndex(records) {
  let cached = growthCaches.get(records);
  if (cached) return cached;
  const artists = new Map();
  const now = Date.now();
  for (const record of records) {
    const artist = normalized(record.artist);
    const time = growthTimestamp(record.date);
    const listeners = Number(record.listeners);
    if (!artist || !Number.isFinite(time) || time > now || !Number.isFinite(listeners) || listeners < 0) continue;
    const metric = normalized(record.metric || 'monthly_listeners').replace(/[ -]+/g, '_');
    const source = text(record.source) || 'CSV';
    const key = `${metric}\u0000${normalized(source)}`;
    if (!artists.has(artist)) artists.set(artist, new Map());
    const groups = artists.get(artist);
    if (!groups.has(key)) groups.set(key, new Map());
    // Last row wins for corrected snapshots from the same source, metric and date.
    groups.get(key).set(time, { time, listeners, metric, source });
  }
  for (const [artist, groups] of artists) {
    artists.set(artist, [...groups.values()].map((snapshots) => [...snapshots.values()].sort((a, b) => a.time - b.time)));
  }
  cached = { artists, results: new Map() };
  growthCaches.set(records, cached);
  return cached;
}

function audienceGrowth(artistKey, firstPlayed, records) {
  if (!records.length) return UNKNOWN_GROWTH;
  const index = growthIndex(records);
  const groups = index.artists.get(artistKey);
  if (!groups) return UNKNOWN_GROWTH;
  const key = `${artistKey}\u0000${firstPlayed}`;
  if (index.results.has(key)) return index.results.get(key);
  const firstTime = Date.parse(firstPlayed);
  const candidates = [];
  for (const snapshots of groups) {
    const current = snapshots.at(-1);
    if (!current || current.time <= firstTime) continue;
    // A binary search prevents a future snapshot becoming the first-heard baseline.
    let low = 0;
    let high = snapshots.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (snapshots[middle].time <= firstTime) low = middle + 1;
      else high = middle;
    }
    const baseline = snapshots[low - 1];
    if (baseline && normalized(baseline.source) === 'kworb' && firstTime - baseline.time > 31 * 86400000) continue;
    if (baseline?.listeners > 0) candidates.push({ baseline, current });
  }
  candidates.sort((a, b) => Number(b.current.metric === 'monthly_listeners') - Number(a.current.metric === 'monthly_listeners') || b.current.time - a.current.time || b.baseline.time - a.baseline.time);
  let result = UNKNOWN_GROWTH;
  if (candidates.length) {
    const { baseline, current } = candidates[0];
    result = {
      growthScore: current.listeners / baseline.listeners,
      baseline: baseline.listeners, current: current.listeners,
      growthSource: current.source, growthMetric: current.metric,
      baselineDate: new Date(baseline.time).toISOString(), currentDate: new Date(current.time).toISOString(),
    };
  }
  index.results.set(key, result);
  return result;
}

function datasetIndex(dataset) {
  let index = datasetCaches.get(dataset);
  if (index) return index;
  const artistKeys = [];
  const searchTexts = [];
  const artistFirsts = new Map();
  const artistFirstTracks = new Map();
  const trackIndices = new Map();
  dataset.tracks.forEach((track, position) => {
    const artistKey = normalized(track.artist);
    artistKeys.push(artistKey);
    searchTexts.push(normalizeSearchText(`${track.name} ${track.artist} ${track.album}`));
    trackIndices.set(track.id, position);
  });
  const monthCodes = new Uint32Array(dataset.events.length);
  const audibleFirsts = new Float64Array(dataset.tracks.length).fill(Infinity);
  const years = new Set();
  dataset.events.forEach((event, position) => {
    const date = new Date(event[1] * 1000);
    const year = date.getUTCFullYear();
    monthCodes[position] = year * 12 + date.getUTCMonth();
    years.add(year);
    if (event[2] > 0 && event[1] < audibleFirsts[event[0]]) audibleFirsts[event[0]] = event[1];
  });
  const firstPlayed = dataset.tracks.map((track, position) => {
    if (!Number.isFinite(audibleFirsts[position])) return track.firstPlayed;
    const first = asIso(audibleFirsts[position]);
    const previous = artistFirsts.get(artistKeys[position]);
    if (!previous || first < previous) {
      artistFirsts.set(artistKeys[position], first);
      artistFirstTracks.set(artistKeys[position], {
        id: track.id, name: track.name, artist: track.artist, album: track.album,
        uri: track.uri, firstPlayed: first,
      });
    }
    return first;
  });
  index = { artistKeys, searchTexts, artistFirsts, artistFirstTracks, firstPlayed, trackIndices, monthCodes, years: [...years].sort((a, b) => b - a), scopes: new Map(), contexts: new WeakMap() };
  datasetCaches.set(dataset, index);
  return index;
}

function emptyStats() {
  return { plays: 0, msPlayed: 0, tracks: 0, artists: 0, firstPlayed: null, lastPlayed: null, skipped: 0, skippedRate: 0 };
}

function monthsArray(months) {
  return [...months].sort((a, b) => a[0] - b[0]).map(([code, counts]) => ({
    month: `${Math.floor(code / 12)}-${String(code % 12 + 1).padStart(2, '0')}`,
    plays: counts[0], msPlayed: counts[1],
  }));
}

function addMonth(months, code, plays, msPlayed) {
  const existing = months.get(code);
  if (existing) { existing[0] += plays; existing[1] += msPlayed; }
  else months.set(code, [plays, msPlayed]);
}

function scopedEvents(dataset, index, year, threshold, dateFrom = '', dateTo = '') {
  const key = `${year}|${threshold}|${dateFrom}|${dateTo}`;
  if (index.scopes.has(key)) return index.scopes.get(key);
  const from = dateFrom ? Date.parse(`${dateFrom}T00:00:00Z`) / 1000 : -Infinity;
  const until = dateTo ? Date.parse(`${dateTo}T00:00:00Z`) / 1000 + 86400 : Infinity;
  const start = Math.max(year === 'all' ? -Infinity : Date.UTC(Number(year), 0, 1) / 1000, Number.isFinite(from) ? from : -Infinity);
  const end = Math.min(year === 'all' ? Infinity : Date.UTC(Number(year) + 1, 0, 1) / 1000, Number.isFinite(until) ? until : Infinity);
  const tracks = new Map();
  const artists = new Set();
  const months = new Map();
  const stats = emptyStats();
  let first = Infinity;
  let last = -Infinity;
  dataset.events.forEach(([position, seconds, msPlayed, skipped], eventIndex) => {
    if (!dataset.tracks[position] || msPlayed <= 0 || msPlayed < threshold || !(seconds >= start && seconds < end)) return;
    let track = tracks.get(position);
    if (!track) {
      track = { plays: 0, msPlayed: 0, skipped: 0, first: seconds, last: seconds, months: new Map() };
      tracks.set(position, track);
    }
    track.plays += 1;
    track.msPlayed += msPlayed;
    track.skipped += skipped ? 1 : 0;
    track.first = Math.min(track.first, seconds);
    track.last = Math.max(track.last, seconds);
    const month = index.monthCodes[eventIndex];
    addMonth(track.months, month, 1, msPlayed);
    addMonth(months, month, 1, msPlayed);
    artists.add(index.artistKeys[position]);
    stats.plays += 1;
    stats.msPlayed += msPlayed;
    stats.skipped += skipped ? 1 : 0;
    first = Math.min(first, seconds);
    last = Math.max(last, seconds);
  });
  stats.tracks = tracks.size;
  stats.artists = artists.size;
  stats.skippedRate = stats.plays ? stats.skipped / stats.plays : 0;
  stats.firstPlayed = Number.isFinite(first) ? asIso(first) : null;
  stats.lastPlayed = Number.isFinite(last) ? asIso(last) : null;
  const scope = { key, tracks, stats, months: monthsArray(months) };
  // Bound cached aggregate memory while retaining the usual year and duration choices.
  if (index.scopes.size >= 12) index.scopes.delete(index.scopes.keys().next().value);
  index.scopes.set(key, scope);
  return scope;
}

function contextFor(dataset, index, scope, metadata, growth) {
  let byGrowth = index.contexts.get(metadata);
  if (!byGrowth) { byGrowth = new WeakMap(); index.contexts.set(metadata, byGrowth); }
  let contexts = byGrowth.get(growth);
  if (!contexts) { contexts = new Map(); byGrowth.set(growth, contexts); }
  if (contexts.has(scope.key)) return contexts.get(scope.key);
  const items = [];
  const normalizedGenres = new Map();
  for (const [position, aggregate] of scope.tracks) {
    const track = dataset.tracks[position];
    const meta = metadata[track.id] ?? EMPTY_METADATA;
    const genres = meta.genres?.length ? [...new Map(meta.genres.map((genre) => [normalized(genre), text(genre)]).filter(([key]) => key)).values()] : EMPTY_GROWTH;
    if (genres.length) normalizedGenres.set(track.id, genres.map(normalized));
    const firstPlayed = index.firstPlayed[position];
    const audience = audienceGrowth(index.artistKeys[position], firstPlayed, growth);
    // Canonical history names always win over any provider's approximate catalog match.
    const item = {
      id: track.id, name: track.name, artist: track.artist, album: track.album,
      uri: track.uri, firstPlayed, genres,
      plays: aggregate.plays, msPlayed: aggregate.msPlayed, skipped: aggregate.skipped,
      artwork: meta.artwork || null, artistArtwork: meta.artistArtwork || null,
      previewUrl: meta.previewUrl || null,
      audioUrl: /^https:\/\//.test(meta.audioUrl||'') ? meta.audioUrl : null,
      audioKind: meta.audioKind || 'preview', audioSource: meta.audioSource || null,
      audioExternalUrl: meta.audioExternalUrl || null, audioDurationMs: Number(meta.audioDurationMs) || null,
      spotifyUrl: meta.spotifyUrl || (track.uri ? `https://open.spotify.com/track/${track.id}` : null),
      artistId: meta.artistId || null, durationMs: Number(meta.durationMs) || null,
      source: meta.source || null, artworkSource: meta.artworkSource || null,
      genreSource: meta.genreSource || (genres.length ? meta.source || null : null),
      externalUrl: meta.externalUrl || null, matchedTitle: meta.matchedTitle || null,
      matchedArtist: meta.matchedArtist || null, matchConfidence: meta.matchConfidence ?? null,
      growthScore: audience.growthScore, baseline: audience.baseline, current: audience.current,
      growthSource: audience.growthSource, growthMetric: audience.growthMetric,
      baselineDate: audience.baselineDate, currentDate: audience.currentDate,
    };
    items.push(item);
  }
  items.sort(byListening);
  const context = { items, normalizedGenres, results: new Map(), scope };
  if (contexts.size >= 12) contexts.delete(contexts.keys().next().value);
  contexts.set(scope.key, context);
  return context;
}

function filteredTotals(items, context, index) {
  const stats = emptyStats();
  const artists = new Set();
  const months = new Map();
  let first = Infinity;
  let last = -Infinity;
  for (const item of items) {
    const position = index.trackIndices.get(item.id);
    const aggregate = context.scope.tracks.get(position);
    stats.plays += item.plays;
    stats.msPlayed += item.msPlayed;
    stats.skipped += item.skipped;
    artists.add(index.artistKeys[position]);
    first = Math.min(first, aggregate.first);
    last = Math.max(last, aggregate.last);
    for (const [code, [plays, msPlayed]] of aggregate.months) addMonth(months, code, plays, msPlayed);
  }
  stats.tracks = items.length;
  stats.artists = artists.size;
  stats.skippedRate = stats.plays ? stats.skipped / stats.plays : 0;
  stats.firstPlayed = Number.isFinite(first) ? asIso(first) : null;
  stats.lastPlayed = Number.isFinite(last) ? asIso(last) : null;
  return { stats, months: monthsArray(months) };
}

function groupArtists(items, index, growth) {
  const grouped = new Map();
  for (const track of items) {
    const artistKey = index.artistKeys[index.trackIndices.get(track.id)];
    let artist = grouped.get(artistKey);
    if (!artist) {
      const firstPlayed = index.artistFirsts.get(artistKey);
      const firstTrack = index.artistFirstTracks.get(artistKey) ?? null;
      const audience = audienceGrowth(artistKey, firstPlayed, growth);
      artist = {
        id: `artist:${artistKey}`, name: track.artist, artist: track.artist, album: '',
        uri: track.artistId ? `spotify:artist:${track.artistId}` : '', firstPlayed,
        plays: 0, msPlayed: 0, skipped: 0, genres: [],
        artwork: track.artistArtwork || track.artwork, artistArtwork: track.artistArtwork,
        previewUrl: track.previewUrl,
        spotifyUrl: track.artistId ? `https://open.spotify.com/artist/${track.artistId}` : null,
        artistId: track.artistId, trackCount: 0, topTrack: track.name,
        topTrackId: track.id, topTrackUri: track.uri,
        firstTrack, firstTrackId: firstTrack?.id ?? null, firstTrackName: firstTrack?.name ?? null,
        source: track.source, artworkSource: track.artworkSource, externalUrl: track.externalUrl,
        genreSource: track.genreSource,
        growthScore: audience.growthScore, baseline: audience.baseline, current: audience.current,
        growthSource: audience.growthSource, growthMetric: audience.growthMetric,
        baselineDate: audience.baselineDate, currentDate: audience.currentDate,
      };
      grouped.set(artistKey, artist);
    }
    artist.plays += track.plays;
    artist.msPlayed += track.msPlayed;
    artist.skipped += track.skipped;
    artist.trackCount += 1;
    for (const genre of track.genres) if (!artist.genres.includes(genre)) artist.genres.push(genre);
    if (track.artistArtwork && !artist.artistArtwork) {
      artist.artwork = track.artistArtwork;
      artist.artistArtwork = track.artistArtwork;
    }
    if (!artist.artistId && track.artistId) {
      artist.artistId = track.artistId;
      artist.uri = `spotify:artist:${track.artistId}`;
      artist.spotifyUrl = `https://open.spotify.com/artist/${track.artistId}`;
    }
  }
  return [...grouped.values()].sort(byListening);
}

/** Inputs are immutable. First-heard dates always refer to the full imported archive. */
export function analyzeHistory(dataset, { year = 'all', minMs = 30000, query = '', entity = 'tracks', genre = 'all', metadata = EMPTY_METADATA, growth = EMPTY_GROWTH, dateFrom = '', dateTo = '', minPlays = 0, maxPlays = null, trackId = null, artistName = null } = {}) {
  const index = datasetIndex(dataset);
  const scope = scopedEvents(dataset, index, String(year), Math.max(0, Number(minMs) || 0), dateFrom, dateTo);
  const context = contextFor(dataset, index, scope, metadata, growth);
  const needle = normalizeSearchText(query);
  const selectedGenre = normalized(genre);
  const minimum = Math.max(0, Number(minPlays) || 0);
  const maximum = maxPlays === '' || maxPlays == null ? Infinity : Math.max(0, Number(maxPlays));
  const key = JSON.stringify([entity, needle, selectedGenre, minimum, maximum, trackId, artistName]);
  if (context.results.has(key)) return context.results.get(key);
  const unfiltered = !needle && selectedGenre === 'all' && !minimum && maximum === Infinity && !trackId && !artistName;
  let tracks = context.items;
  let totals = { stats: scope.stats, months: scope.months };
  if (!unfiltered) {
    tracks = tracks.filter((item) => {
      const position = index.trackIndices.get(item.id);
      if (trackId && item.id !== trackId) return false;
      if (artistName && normalized(item.artist) !== normalized(artistName)) return false;
      if (needle && entity !== 'artists' && !matchesSearch(index.searchTexts[position], needle)) return false;
      const genres = context.normalizedGenres.get(item.id) ?? EMPTY_GROWTH;
      return selectedGenre === 'all' || (selectedGenre === 'unknown' ? !genres.length || genres.includes('unknown') : genres.includes(selectedGenre));
    });
  }
  let items;
  if (entity === 'artists') {
    const matchingArtists = needle ? new Set(tracks.filter(item => matchesSearch(index.searchTexts[index.trackIndices.get(item.id)], needle)).map(item => normalized(item.artist))) : null;
    items = groupArtists(tracks, index, growth).filter(item => (!needle || matchingArtists.has(normalized(item.name))) && item.plays >= minimum && item.plays <= maximum);
    if (!unfiltered) { const artists = new Set(items.map(item => normalized(item.name))); tracks = tracks.filter(item => artists.has(normalized(item.artist))); }
  } else {
    items = tracks.filter(item => item.plays >= minimum && item.plays <= maximum);
    tracks = items;
  }
  if (!unfiltered) totals = filteredTotals(tracks, context, index);
  const result = { items, ...totals, years: index.years };
  // Search results can contain thousands of references; keep a short recent-query cache.
  if (context.results.size >= 16) context.results.delete(context.results.keys().next().value);
  context.results.set(key, result);
  return result;
}

/** A card's chart includes the complete track/artist timeline, independently of library filters. */
export function analyzeItemHistory(dataset, item, { metadata = EMPTY_METADATA, minMs = 1 } = {}) {
  return analyzeHistory(dataset, { entity:'tracks', minMs, metadata, ...(item.id?.startsWith('artist:') ? { artistName:item.name } : { trackId:item.id }) });
}
