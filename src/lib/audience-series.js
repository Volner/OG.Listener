const DAY = 86_400_000;
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const metricName = (value) => normalize(value || 'monthly_listeners').replace(/[ -]+/g, '_');

// Date.parse accepts impossible dates such as February 31. Snapshot dates must
// represent a real calendar day before their time component is considered.
function calendarTime(value) {
  if (typeof value !== 'string') return NaN;
  const input = value.trim();
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(input)?.[1];
  if (!day) return NaN;
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return NaN;
  const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input)
    ? `${input.replace(' ', 'T')}Z` : input;
  return Date.parse(zoned);
}

/** Select one Spotify monthly-listener series without inventing observations. */
export function audienceSeries(records, options = {}, now = Date.now()) {
  const { artist, firstPlayed } = options;
  const artistKey = normalize(artist);
  const requestedSource = normalize(options.source || options.growthSource);
  const requestedMetric = metricName(options.metric || options.growthMetric);
  const parsedFirst = calendarTime(firstPlayed);
  const firstTime = Number.isFinite(parsedFirst) && parsedFirst <= now ? parsedFirst : null;
  const groups = new Map();

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || !artistKey || normalize(record.artist) !== artistKey) continue;
    const metric = metricName(record.metric);
    if (metric !== 'monthly_listeners' || requestedMetric !== 'monthly_listeners') continue;
    const source = typeof record.source === 'string' && record.source.trim() ? record.source.trim() : 'CSV';
    const sourceKey = normalize(source);
    // Last.fm listener counts describe another service and are not Spotify's
    // monthly audience, even if an imported row accidentally has that label.
    if (sourceKey.replace(/[.\s_-]/g, '') === 'lastfm') continue;
    const time = calendarTime(record.date);
    const value = record.listeners;
    if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) continue;
    const listeners = Number(value);
    if (!Number.isFinite(time) || time > now || !Number.isFinite(listeners) || listeners < 0) continue;
    if (!groups.has(sourceKey)) groups.set(sourceKey, new Map());
    // The last row is a correction to the same observation, never another point.
    groups.get(sourceKey).set(time, { ...record, time, date: new Date(time).toISOString(), listeners, source, metric });
  }

  const candidates = [...groups.entries()].map(([key, observations]) => ({
    key,
    points: [...observations.values()].sort((a, b) => a.time - b.time),
  }));
  candidates.sort((a, b) => (
    Number(b.key === requestedSource) - Number(a.key === requestedSource)
    || Number(b.key === 'kworb') - Number(a.key === 'kworb')
    || b.points.at(-1).time - a.points.at(-1).time
    || b.points.length - a.points.length
    || a.key.localeCompare(b.key)
  ));
  const points = candidates[0]?.points ?? [];
  const current = points.at(-1);
  const baseline = firstTime === null ? undefined : points.findLast(point => point.time <= firstTime);
  const observedTimes = points.map(point => point.time);
  if (firstTime !== null) observedTimes.push(firstTime);
  let start = observedTimes.length ? Math.min(...observedTimes) : now;
  let end = observedTimes.length ? Math.max(...observedTimes) : now;
  if (start === end) { start -= DAY; end += DAY; }

  return {
    points, source: current?.source ?? null, metric: 'monthly_listeners', firstTime,
    domain: [start, end], baseline, current,
  };
}

/** Compare real observations from the selected series at a supported baseline. */
export function audienceGrowthRatio(series) {
  const { baseline, current, firstTime } = series;
  if (series.metric !== 'monthly_listeners' || !Number.isFinite(firstTime)
    || !baseline || !current || baseline.listeners <= 0
    || baseline.time > firstTime || current.time <= firstTime) return null;
  if (normalize(series.source) === 'kworb' && firstTime - baseline.time > 31 * DAY) return null;
  const result = current.listeners / baseline.listeners;
  return Number.isFinite(result) ? result : null;
}

/** Chart geometry stays separate from observations; a lone point has no line. */
export function audienceCoordinates(series, { width = 640, height = 240, left = 54, right = 16, top = 22, bottom = 32 } = {}) {
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const [start, end] = series.domain;
  const maximum = Math.max(0, ...series.points.map(point => point.listeners));
  const yMaximum = maximum > 0 ? maximum * 1.08 : 1;
  const x = (time) => left + (time - start) / (end - start) * plotWidth;
  const y = (listeners) => top + (1 - listeners / yMaximum) * plotHeight;
  return {
    ...series,
    points: series.points.map(point => ({ ...point, x: x(point.time), y: y(point.listeners) })),
    plot: { left, right, top, bottom, width: plotWidth, height: plotHeight },
    yDomain: [0, yMaximum],
    firstX: series.firstTime === null ? null : x(series.firstTime),
    x, y,
  };
}
