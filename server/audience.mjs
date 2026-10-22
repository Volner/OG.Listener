import { createKworbClient, normalizeArchiveChecked } from './kworb.mjs';
import { readJsonBody } from './request-body.js';
// Documented Chartmetric API, checked 2026-10-20:
// https://apidocs.chartmetric.com/reference/tag/artist/get/api/artist/id/stat/source
// https://apidocs.chartmetric.com/reference/tag/search/get/api/search
const API = 'https://api.chartmetric.com';
const DOCUMENTATION = 'https://apidocs.chartmetric.com/reference/tag/artist/get/api/artist/id/stat/source';
const DAY = 86400000;
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

class AudienceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function bodyJson(req) {
  try { return await readJsonBody(req, { maxBytes: 262144 }); }
  catch (error) {
    if (error.status === 413) throw new AudienceError(413, 'payload_too_large', 'Слишком большой запрос. Разделите исполнителей на меньшие группы.');
    throw new AudienceError(error.status || 400, error.code || 'invalid_json', error.message || 'Нужен корректный JSON.');
  }
}

function providerError(status) {
  if (status === 401) return new AudienceError(401, 'provider_auth', 'Chartmetric отклонил ключ. Проверьте CHARTMETRIC_REFRESH_TOKEN в локальном .env.');
  if (status === 403) return new AudienceError(403, 'provider_plan', 'Тариф Chartmetric не разрешает этот запрос. Нужен доступ к API и истории слушателей.');
  if (status === 429) return new AudienceError(429, 'provider_rate_limit', 'Достигнут лимит Chartmetric. Повторите загрузку позднее.');
  if (status === 404) return new AudienceError(404, 'artist_not_found', 'У Chartmetric нет данных об этом исполнителе.');
  return new AudienceError(502, 'provider_unavailable', 'Не удалось получить данные Chartmetric. Повторите запрос позднее.');
}

/** Never substitute followers, popularity, or interpolated points for observed listeners. */
export function normalizeChartmetricListeners(payload, artist) {
  if (!Array.isArray(payload?.obj?.listeners)) {
    throw new AudienceError(502, 'invalid_provider_data', 'Chartmetric не вернул временной ряд monthly listeners.');
  }
  const points = new Map();
  for (const point of payload.obj.listeners) {
    if (point?.interpolated === true || point?.interpolated === 'true' || point?.value == null || point.value === '') continue;
    const time = Date.parse(point.timestp);
    const listeners = Number(point.value);
    if (!Number.isFinite(time) || time > Date.now() || !Number.isSafeInteger(listeners) || listeners < 0) continue;
    points.set(time, { artist, date: new Date(time).toISOString(), listeners, source: 'Chartmetric', metric: 'monthly_listeners' });
  }
  return [...points].sort((a, b) => a[0] - b[0]).map(([, snapshot]) => snapshot);
}

export function createChartmetricClient({ env = process.env, fetchImpl = globalThis.fetch, requestIntervalMs = 1050 } = {}) {
  let token = null;
  let tokenExpires = 0;
  let lastRequest = 0;
  let queue = Promise.resolve();
  const cache = new Map();
  const pending = new Map();

  function pacedFetch(url, options) {
    const operation = queue.then(async () => {
      const delay = Math.max(0, lastRequest + requestIntervalMs - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      lastRequest = Date.now();
      try {
        return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(25000) });
      } catch {
        throw new AudienceError(502, 'provider_unavailable', 'Chartmetric недоступен или не ответил вовремя.');
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  async function readJson(response) {
    if (!response.ok) throw providerError(response.status);
    try { return await response.json(); }
    catch { throw new AudienceError(502, 'invalid_provider_data', 'Chartmetric вернул некорректный ответ.'); }
  }

  async function accessToken() {
    if (token && tokenExpires > Date.now()) return token;
    const refreshToken = String(env.CHARTMETRIC_REFRESH_TOKEN ?? '').trim();
    if (!refreshToken) throw new AudienceError(428, 'provider_not_configured', 'Добавьте CHARTMETRIC_REFRESH_TOKEN в локальный .env и перезапустите сервер. Chartmetric требует платный доступ к API.');
    const payload = await readJson(await pacedFetch(`${API}/api/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshtoken: refreshToken }),
    }));
    if (typeof payload.token !== 'string' || !payload.token) throw new AudienceError(502, 'invalid_provider_data', 'Chartmetric не выдал access token.');
    token = payload.token;
    tokenExpires = Date.now() + Math.max(0, (Number(payload.expires_in) || 3600) - 60) * 1000;
    return token;
  }

  async function request(path, params, retry = true) {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const currentToken = await accessToken();
    const response = await pacedFetch(url.href, { headers: { Authorization: `Bearer ${currentToken}` } });
    if (response.status === 401 && retry) {
      token = null;
      tokenExpires = 0;
      return request(path, params, false);
    }
    return readJson(response);
  }

  async function loadArtist(artist) {
    let id = artist.artistId;
    let isDomainId = Boolean(id);
    if (!id) {
      const result = await request('/api/search', { q: artist.name, type: 'artists', limit: 100, beta: false });
      const matches = (Array.isArray(result?.obj?.artists) ? result.obj.artists : []).filter((candidate) => normalize(candidate.name) === normalize(artist.name));
      if (!matches.length) throw new AudienceError(404, 'artist_not_found', 'Точное совпадение исполнителя не найдено в Chartmetric.');
      if (matches.length > 1) throw new AudienceError(409, 'ambiguous_artist', 'В Chartmetric несколько исполнителей с этим именем. Сначала загрузите метаданные с Spotify artist ID.');
      id = String(matches[0].id ?? '');
      if (!/^\d+$/.test(id)) throw new AudienceError(502, 'invalid_provider_data', 'Chartmetric не вернул ID исполнителя.');
      isDomainId = false;
    }
    // Ask for actual observed points, starting a month before first hearing so a
    // snapshot earlier than that play can be used. Never invent missing history.
    const since = new Date(Date.parse(artist.firstPlayed) - 31 * DAY).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const result = await request(`/api/artist/${encodeURIComponent(id)}/stat/spotify`, {
      field: 'listeners', since, until, isDomainId, interpolated: false,
    });
    if (artist.artistId && result?.obj?.link) {
      const returnedId = /^https:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(result.obj.link)?.[1];
      if (returnedId && returnedId !== artist.artistId) throw new AudienceError(409, 'artist_id_mismatch', 'Chartmetric вернул данные другого Spotify artist ID.');
    }
    const snapshots = normalizeChartmetricListeners(result, artist.name);
    const firstTime = Date.parse(artist.firstPlayed);
    return {
      snapshots,
      coverage: {
        artist: artist.name, source: 'Chartmetric', metric: 'monthly_listeners',
        from: snapshots[0]?.date ?? null, to: snapshots.at(-1)?.date ?? null,
        firstPlayed: artist.firstPlayed, count: snapshots.length,
        hasBaseline: snapshots.some((point) => Date.parse(point.date) <= firstTime && point.listeners > 0),
      },
    };
  }

  async function artistHistory(artist) {
    const key = JSON.stringify([normalize(artist.name), artist.artistId, artist.firstPlayed]);
    const saved = cache.get(key);
    if (saved && saved.expires > Date.now()) return saved.value;
    if (pending.has(key)) return pending.get(key);
    const operation = loadArtist(artist).then((value) => {
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + 6 * 60 * 60 * 1000 });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return { artistHistory };
}

/** Local Connect/Vite middleware. Credentials remain on the Node server. */
export function createAudienceApi({ env = process.env, fetchImpl = globalThis.fetch, requestIntervalMs } = {}) {
  const client = createChartmetricClient({ env, fetchImpl, requestIntervalMs });
  const kworb = createKworbClient({ fetchImpl, requestIntervalMs });
  return async function handleAudience(req, res, inputUrl) {
    const url = inputUrl instanceof URL ? inputUrl : new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/audience/')) return false;
    try {
      if (url.pathname === '/api/audience/providers' && req.method === 'GET') {
        json(res, 200, {
          providers: [{
            id: 'kworb', name: 'Kworb + Internet Archive', configured: true,
            paid: false, metric: 'monthly_listeners', documentation: 'https://kworb.net/spotify/listeners.html',
            automatic: true, batchSize: 100, maxBatchMs: 40000,
            coverageNote: 'Бесплатные наблюдения Kworb и сохранённые страницы Internet Archive. Даты разреженные; не все исполнители и годы доступны. Отсутствующие данные не оцениваются.',
          }, {
            id: 'chartmetric', name: 'Chartmetric', configured: Boolean(String(env.CHARTMETRIC_REFRESH_TOKEN ?? '').trim()),
            paid: true, envKey: 'CHARTMETRIC_REFRESH_TOKEN', metric: 'monthly_listeners', documentation: DOCUMENTATION,
            pricingUrl: 'https://chartmetric.com/plans/api',
            coverageNote: 'Глубина истории зависит от исполнителя и тарифа. Показываем только реально полученные точки; наличие данных за 2019 год не гарантируется.',
          }],
        });
        return true;
      }
      if (!['/api/audience/import', '/api/audience/resolve'].includes(url.pathname)) {
        json(res, 404, { error: 'Маршрут истории аудитории не найден.', code: 'not_found' });
        return true;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'Используйте POST.', code: 'method_not_allowed' });
        return true;
      }
      const body = await bodyJson(req);
      const provider = body.provider || 'kworb';
      if (!['kworb', 'chartmetric'].includes(provider)) throw new AudienceError(400, 'invalid_provider', 'Поддерживаются провайдеры kworb и chartmetric.');
      const maximum = url.pathname === '/api/audience/resolve' ? 100 : 20;
      if (!Array.isArray(body.artists) || !body.artists.length || body.artists.length > maximum) throw new AudienceError(400, 'invalid_artists', `Нужен список из 1–${maximum} исполнителей.`);
      const artists = body.artists.map((value) => {
        const name = typeof value?.name === 'string' ? value.name.trim() : '';
        const firstTime = Date.parse(value?.firstPlayed);
        const artistId = String(value?.artistId ?? value?.spotifyArtistId ?? '').trim();
        if (!name || name.length > 1000 || !Number.isFinite(firstTime) || firstTime > Date.now() || (artistId && !/^[A-Za-z0-9]{22}$/.test(artistId))) throw new AudienceError(400, 'invalid_artist', 'Укажите имя, первую дату прослушивания и корректный Spotify artist ID (если он известен).');
        return { name, firstPlayed: new Date(firstTime).toISOString(), artistId, ...(provider === 'kworb' ? { archiveChecked: normalizeArchiveChecked(value.archiveChecked) } : {}) };
      });
      if (provider === 'chartmetric' && !String(env.CHARTMETRIC_REFRESH_TOKEN ?? '').trim()) throw new AudienceError(428, 'provider_not_configured', 'Добавьте CHARTMETRIC_REFRESH_TOKEN в локальный .env и перезапустите сервер. Бесплатный источник Kworb доступен без ключа.');
      if (provider === 'kworb') {
        // Resolve the artist batch against shared ranking/archive tables. Do not
        // issue an independent crawl for each of the user's thousands of names.
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once?.('close', onClose);
        let result;
        try { result = await kworb.artistHistories(artists, { signal: controller.signal }); }
        finally { res.off?.('close', onClose); }
        if (controller.signal.aborted) return true;
        json(res, 200, { provider, ...result });
        return true;
      }
      const snapshots = [];
      const coverage = [];
      const errors = [];
      for (const artist of artists) {
        try {
          const result = await (provider === 'kworb' ? kworb : client).artistHistory(artist);
          snapshots.push(...result.snapshots);
          coverage.push(result.coverage);
        } catch (error) {
          errors.push({ artist: artist.name, code: error.code || 'provider_error', error: error.message });
          if ([401, 403, 429].includes(error.status)) break;
        }
      }
      json(res, 200, { provider, snapshots, coverage, errors });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      json(res, error.status || 500, { error: error instanceof AudienceError ? error.message : 'Не удалось загрузить историю аудитории.', code: error.code || 'audience_error' });
    }
    return true;
  };
}
