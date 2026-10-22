// Observed Spotify monthly listeners. Shared tables, not an archive crawl for
// every artist. No interpolation, media downloads or disk persistence.
const PAGES = ['https://kworb.net/spotify/listeners.html', 'https://kworb.net/spotify/listeners2.html'];
const DAY = 86400000;
const normalized = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
const error = (message, status = 502, code = 'provider_unavailable') => Object.assign(new Error(message), { status, code });

// A continuation contains only identities of the two shared ranking pages and
// observed archive captures, never a URL or a listener value. Each artist needs
// at most three captures per page (baseline, first later and latest later).
export function normalizeArchiveChecked(value) {
  if (!Array.isArray(value)) return [];
  const result = new Set(), counts = [0, 0];
  for (const key of value.slice(0, 6)) {
    if (typeof key !== 'string' || !/^[01]:\d{14}$/.test(key) || !Number.isFinite(timestampDate(key.slice(2))) || result.has(key)) continue;
    const page = Number(key[0]);
    if (counts[page]++ < 3) result.add(key);
  }
  return [...result];
}

function decodeHtml(value) {
  return String(value).replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => { const n = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

export function parseKworbListeners(html) {
  if (!/Spotify[^<]*Top Artists by Monthly Listeners/i.test(html)) throw error('Страница Kworb не содержит месячных слушателей.', 502, 'invalid_provider_data');
  const entries = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    const artistCell = cells.findIndex(cell => /artist\/[A-Za-z0-9]{22}(?:_songs)?\.html/.test(cell));
    if (artistCell < 0) continue;
    const anchor = /<a\b[^>]*href=["'][^"']*artist\/([A-Za-z0-9]{22})(?:_songs)?\.html[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(cells[artistCell]);
    const raw = cells[artistCell + 1]?.replace(/<[^>]*>/g, '').trim();
    if (!anchor || !/^\d[\d,\s]*$/.test(raw || '')) continue;
    const listeners = Number(raw.replace(/[,\s]/g, ''));
    if (!Number.isSafeInteger(listeners) || listeners < 0) continue;
    entries.push({ artistId: anchor[1], name: decodeHtml(anchor[2].replace(/<[^>]*>/g, '')).trim(), listeners });
  }
  if (!entries.length) throw error('Не удалось прочитать таблицу месячных слушателей Kworb.', 502, 'invalid_provider_data');
  return entries;
}

const timestampDate = stamp => /^\d{14}$/.test(stamp) ? Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`) : NaN;

async function parallelMap(values, workers, operation) {
  let cursor = 0;
  const results = new Array(values.length);
  await Promise.all(Array.from({ length: Math.min(workers, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = { value: await operation(values[index]) }; }
      catch (failure) { results[index] = { failure }; }
    }
  }));
  return results;
}

export function createKworbClient({ fetchImpl = globalThis.fetch, requestIntervalMs = 550, cacheTtlMs = 6 * 3600000, timeoutMs = 8000, batchTimeoutMs = 40000, maxArchiveRequests = 12 } = {}) {
  const cache = new Map(), pending = new Map(), failures = new Map();
  let nextAt = 0, unavailableUntil = 0;
  async function load(key, operation) {
    const saved = cache.get(key); if (saved?.expires > Date.now()) return saved.value;
    const failed = failures.get(key); if (failed?.expires > Date.now()) throw failed.failure;
    if (pending.has(key)) return pending.get(key);
    const work = operation().then(value => {
      // Cache table payloads, not a duplicate 10,000-artist result collection.
      if (cache.size >= 160) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + cacheTtlMs }); failures.delete(key); return value;
    }).catch(failure => {
      if (failures.size >= 160) failures.delete(failures.keys().next().value);
      failures.set(key, { failure, expires: Date.now() + (failure.status === 429 ? 60000 : 30000) }); throw failure;
    }).finally(() => pending.delete(key));
    pending.set(key, work); return work;
  }
  async function request(url, deadline) {
    if (Date.now() < unavailableUntil) throw error('Источник временно ограничил запросы. Повторная проверка будет доступна через минуту.', 429, 'provider_rate_limit');
    const at = Math.max(Date.now(), nextAt);
    if (at >= deadline) throw error('Проверка архивных страниц продолжится следующей группой.', 503, 'batch_deferred');
    nextAt = at + requestIntervalMs;
    if (at > Date.now()) await new Promise(resolve => setTimeout(resolve, at - Date.now()));
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now()))), cache: 'no-store', headers: { 'User-Agent': 'OG.Listener/1.0 (local personal listening-history analytics)' } }); }
    catch { throw error('Kworb или Internet Archive не ответил вовремя. Автоматическая проверка может повториться позднее.'); }
    if (!response.ok) {
      if (response.status === 429) { unavailableUntil = Date.now() + 60000; throw error('Источник временно ограничил запросы. Повторная проверка будет доступна через минуту.', 429, 'provider_rate_limit'); }
      throw error(`Источник истории вернул HTTP ${response.status}.`, response.status === 404 ? 404 : 502);
    }
    return response;
  }
  async function table(page, stamp, deadline) {
    return load(`${page}:${stamp || 'current'}`, async () => {
      const url = stamp ? `https://web.archive.org/web/${stamp}id_/${page}` : page;
      const response = await request(url, deadline);
      const html = await response.text(); if (html.length > 4 * 1024 * 1024) throw error('Таблица источника слишком большая.');
      let observedAt;
      if (stamp) {
        const actualStamp = /\/web\/(\d{14})(?:id_)?\//.exec(response.url || '')?.[1];
        const memento = Date.parse(response.headers?.get('memento-datetime'));
        observedAt = Number.isFinite(memento) ? memento : timestampDate(actualStamp || '');
      } else observedAt = Date.parse(response.headers?.get('last-modified'));
      if (!Number.isFinite(observedAt) || observedAt > Date.now()) throw error('Источник не указал достоверную дату наблюдения.', 502, 'missing_snapshot_date');
      const entries = parseKworbListeners(html);
      return { entries, byId: new Map(entries.map(entry => [entry.artistId, entry])), date: new Date(observedAt).toISOString(), sourceUrl: response.url || url, archived: Boolean(stamp) };
    });
  }
  async function index(page, deadline) {
    return load(`index:${page}`, async () => {
      const params = new URLSearchParams({ url: page, output: 'json', fl: 'timestamp,original', filter: 'statuscode:200', collapse: 'timestamp:6', limit: '600' });
      const response = await request(`https://web.archive.org/cdx/search/cdx?${params}`, deadline);
      let rows; try { rows = await response.json(); } catch { throw error('Internet Archive вернул некорректный индекс.'); }
      if (!Array.isArray(rows)) throw error('Internet Archive не вернул индекс снимков.');
      return rows.slice(1).filter(row => Array.isArray(row) && Number.isFinite(timestampDate(row[0])) && timestampDate(row[0]) <= Date.now()).map(row => row[0]).sort();
    });
  }
  function coverageFor(state, firstTime) {
    const snapshots = [...state.points.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const baseline = snapshots.filter(point => Date.parse(point.date) <= firstTime && point.listeners > 0).at(-1);
    const hasBaseline = Boolean(baseline && firstTime - Date.parse(baseline.date) <= 31 * DAY);
    const unavailable = state.warnings.length > 0;
    const status = state.deferred ? 'deferred' : unavailable ? 'unavailable' : hasBaseline ? 'ready' : !state.id ? 'not_tracked' : 'no_baseline';
    const notes = {
      ready: 'Получены реальные наблюдения до первого прослушивания и позднее.',
      deferred: 'Часть архивных дат ещё не проверена. Они будут проверены следующей группой.',
      unavailable: 'Источник временно недоступен. Данные не заменяются оценками.',
      not_tracked: 'Исполнитель не найден в текущих рейтингах Kworb. Это не доказывает отсутствие более ранних данных, но бесплатный источник не даёт полного каталога истории.',
      no_baseline: 'Нет подтверждённого снимка за 31 день до первого прослушивания. Доступные более поздние наблюдения сохранены.',
    };
    return { snapshots, coverage: {
      artist: state.artist.name, artistId: state.id || null, source: 'Kworb', metric: 'monthly_listeners',
      firstPlayed: state.artist.firstPlayed, from: snapshots[0]?.date || null, to: snapshots.at(-1)?.date || null,
      count: snapshots.length, hasBaseline, baselineDate: baseline?.date || null,
      baselineAgeDays: baseline ? Math.round((firstTime - Date.parse(baseline.date)) / DAY) : null,
      sparse: true, status, retryable: ['unavailable', 'deferred'].includes(status),
      errorCode: state.failureCodes.has('provider_rate_limit') ? 'provider_rate_limit' : [...state.failureCodes][0] || null,
      retryAfterSeconds: unavailable ? 60 : 0, warnings: [...new Set(state.warnings)], note: notes[status],
      archiveChecked: state.id ? [...state.checked].sort() : [],
    } };
  }
  async function artistHistories(artists, { signal } = {}) {
    signal?.throwIfAborted();
    const deadline = Date.now() + batchTimeoutMs;
    const current = await parallelMap(PAGES, 2, page => table(page, undefined, deadline));
    signal?.throwIfAborted();
    const states = artists.map(artist => ({ artist, id: undefined, points: new Map(), warnings: [], failureCodes: new Set(), deferred: false, checked: new Set(normalizeArchiveChecked(artist.archiveChecked)) }));
    const errors = [];
    const add = (state, data) => {
      const entry = data.byId.get(state.id); if (!entry) return;
      state.points.set(data.date, { artist: state.artist.name, artistId: entry.artistId, date: data.date, listeners: entry.listeners, source: 'Kworb', metric: 'monthly_listeners', sourceUrl: data.sourceUrl, archived: data.archived });
    };
    const byName = new Map(), allIds = new Set();
    current.forEach(result => result.value?.entries.forEach(entry => {
      allIds.add(entry.artistId);
      const key = normalized(entry.name); if (!byName.has(key)) byName.set(key, new Set()); byName.get(key).add(entry.artistId);
    }));
    for (const state of states) {
      const matches = state.artist.artistId ? [state.artist.artistId] : [...(byName.get(normalized(state.artist.name)) || [])];
      if (matches.length > 1) {
        state.ambiguous = true;
        errors.push({ artist: state.artist.name, firstPlayed: state.artist.firstPlayed, code: 'ambiguous_artist', error: 'В Kworb несколько исполнителей с таким именем. Нужен однозначный Spotify artist ID.' });
      } else if (allIds.has(matches[0])) state.id = matches[0];
      for (const result of current) {
        if (result.value && state.id) add(state, result.value);
        else if (result.failure) { state.warnings.push(result.failure.message); state.failureCodes.add(result.failure.code || 'provider_unavailable'); }
      }
    }
    // An artist absent from the shared current index must not trigger its own
    // archive scan; that would turn a 10,000-artist import into days of crawling.
    const tracked = states.filter(state => state.id && !state.ambiguous);
    let archiveRequests = 0;
    if (tracked.length) {
      const indices = await parallelMap(PAGES, 2, page => index(page, deadline));
      signal?.throwIfAborted();
      const jobs = new Map();
      const schedule = (page, pageIndex, stamp, state, priority, relevant) => {
        if (!stamp) return;
        const captureKey = `${pageIndex}:${stamp}`;
        relevant.add(captureKey);
        // A submitted capture is trusted only for skipping work, and only after
        // this request's real CDX index selected it for this artist and date.
        // It cannot supply observations or establish a baseline.
        if (state.checked.has(captureKey)) return;
        const key = `${page}:${stamp}`;
        if (!jobs.has(key)) jobs.set(key, { page, stamp, captureKey, states: new Set(), priority });
        const job = jobs.get(key); job.states.add(state); job.priority = Math.max(job.priority, priority);
      };
      indices.forEach((result, pageIndex) => {
        if (result.failure) { tracked.forEach(state => { state.warnings.push(result.failure.message); state.failureCodes.add(result.failure.code || 'provider_unavailable'); }); return; }
        const captures = result.value;
        for (const state of tracked) {
          const relevant = new Set();
          const firstTime = Date.parse(state.artist.firstPlayed);
          const baseline = captures.filter(stamp => timestampDate(stamp) <= firstTime).at(-1);
          if (baseline && firstTime - timestampDate(baseline) <= 31 * DAY) schedule(PAGES[pageIndex], pageIndex, baseline, state, 3, relevant);
          const later = captures.filter(stamp => timestampDate(stamp) > firstTime);
          schedule(PAGES[pageIndex], pageIndex, later.at(-1), state, 2, relevant);
          schedule(PAGES[pageIndex], pageIndex, later[0], state, 1, relevant);
          // Changed indexes invalidate stale captures; an unavailable index does
          // not erase the other request's progress. All retained keys are bounded.
          for (const key of state.checked) if (key[0] === String(pageIndex) && !relevant.has(key)) state.checked.delete(key);
        }
      });
      const ordered = [...jobs.values()].sort((a, b) => b.priority - a.priority || b.states.size - a.states.size || a.stamp.localeCompare(b.stamp));
      const selected = [];
      for (const job of ordered) {
        const key = `${job.page}:${job.stamp}`;
        const cached = cache.get(key)?.expires > Date.now() || pending.has(key) || failures.get(key)?.expires > Date.now();
        if (!cached && archiveRequests >= maxArchiveRequests) { job.states.forEach(state => { state.deferred = true; }); continue; }
        if (!cached) archiveRequests++;
        selected.push(job);
      }
      const loaded = await parallelMap(selected, 3, async job => {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw error('Истёк срок проверки этой группы архивных страниц.', 503, 'batch_deferred');
        return table(job.page, job.stamp, deadline);
      });
      loaded.forEach((result, position) => {
        const job = selected[position];
        if (result.value) {
          tracked.forEach(state => add(state, result.value));
          for (const state of job.states) state.checked.add(job.captureKey);
        }
        else for (const state of job.states) {
          state.warnings.push(result.failure.message);
          state.failureCodes.add(result.failure.code || 'provider_unavailable');
          if (result.failure.code === 'batch_deferred') state.deferred = true;
        }
      });
    }
    signal?.throwIfAborted();
    const results = states.map(state => {
      const result = coverageFor(state, Date.parse(state.artist.firstPlayed));
      if (state.ambiguous) Object.assign(result.coverage, { status: 'ambiguous', retryable: false, note: 'Имя соответствует нескольким исполнителям. Автоматическое сопоставление остановлено.' });
      return result;
    });
    return {
      snapshots: results.flatMap(result => result.snapshots), coverage: results.map(result => result.coverage), errors,
      summary: {
        requested: artists.length, tracked: tracked.length,
        withBaseline: results.filter(result => result.coverage.hasBaseline).length, archiveRequests, automatic: true,
        providerUnavailable: current.every(result => result.failure),
        rateLimited: states.some(state => state.failureCodes.has('provider_rate_limit')),
      },
    };
  }
  async function artistHistory(artist) {
    const result = await artistHistories([artist]);
    if (result.errors.length) throw error(result.errors[0].error, 409, result.errors[0].code);
    return { snapshots: result.snapshots, coverage: result.coverage[0] };
  }
  return { artistHistory, artistHistories };
}
