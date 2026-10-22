/** Visible-track metadata queue. A track can have only one pending/in-flight task. */
export function createCatalogQueue({ resolve, getMetadata = () => ({}), onEntries = () => {}, onState = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  const inFlight = new Map();
  const failed = new Map();
  const attempted = new Map();
  let controller = new AbortController();
  let generation = 0;
  let timer;
  let pausedUntil = 0;
  let closed = false;
  const publish = () => {
    if (!closed) onState({ failures: [...failed.values()].map(task => ({ id: task.track.id, ...task.error })), pending: pending.size, inFlight: inFlight.size, retryAt: pausedUntil > now() ? pausedUntil : 0 });
  };
  function wake() {
    clearTimer(timer);
    timer = undefined;
    if (closed || !pending.size) return;
    if (pausedUntil > now()) {
      timer = setTimer(() => { timer = undefined; pump(); }, pausedUntil - now());
      return;
    }
    pump();
  }
  function failure(task, error) {
    const status = Number(error?.status) || 503;
    const attempts = (task.attempts || 0) + 1;
    const retryAfter = Number(error?.retryAfterSeconds) > 0 ? Number(error.retryAfterSeconds) * 1000 : Number(error?.retryAfter) > 0 ? Number(error.retryAfter) : 0;
    const delay = status === 429 ? Math.max(1000, retryAfter || Math.min(900000, 30000 * 2 ** Math.min(attempts - 1, 5))) : 0;
    const next = { ...task, attempts, error: { status, message: error?.error || error?.message || 'Источник не вернул сведения о треке.', retryAt: delay ? now() + delay : 0 } };
    failed.set(task.track.id, next);
    if (delay) {
      pausedUntil = Math.max(pausedUntil, next.error.retryAt);
      pending.set(task.track.id, next);
    }
  }
  async function run(batch, details) {
    const owner = generation;
    const signal = controller.signal;
    for (const task of batch) { pending.delete(task.track.id); inFlight.set(task.track.id, task); }
    publish();
    try {
      const result = await resolve(batch.map(task => task.track), { signal, apple: false, details });
      if (closed || signal.aborted || owner !== generation) return;
      const entries = result?.entries || {};
      const errors = new Map((result?.errors || []).map(error => [error.id, error]));
      const accepted = {};
      for (const task of batch) {
        const id = task.track.id;
        if (entries[id]) {
          accepted[id] = entries[id];
          failed.delete(id);
          if (!details) pending.set(id, { track: task.track, details: true, attempts: 0 });
        } else failure(task, errors.get(id));
      }
      if (Object.keys(accepted).length) onEntries(accepted);
    } catch (error) {
      if (closed || signal.aborted || owner !== generation) return;
      for (const task of batch) failure(task, error);
    } finally {
      if (!closed && owner === generation) {
        for (const task of batch) inFlight.delete(task.track.id);
        publish();
        wake();
      }
    }
  }
  function pump() {
    if (closed || pausedUntil > now()) { if (!closed) wake(); return; }
    const cover = [...pending.values()].filter(task => !task.details && !inFlight.has(task.track.id));
    const coverBatches = new Set([...inFlight.values()].filter(task => !task.details).map(task => task.batch));
    while (cover.length && coverBatches.size < 2) {
      const batchId = Symbol('catalog-batch');
      const batch = cover.splice(0, 6).map(task => ({ ...task, batch: batchId }));
      coverBatches.add(batchId);
      void run(batch, false);
    }
    if (cover.length || [...inFlight.values()].some(task => !task.details) || [...pending.values()].some(task => !task.details)) return;
    if ([...inFlight.values()].some(task => task.details)) return;
    const details = [...pending.values()].filter(task => !inFlight.has(task.track.id)).slice(0, 3);
    if (details.length) void run(details, true);
  }
  return {
    add(tracks) {
      if (closed) return;
      for (const track of tracks || []) {
        if (!track?.id || pending.has(track.id) || inFlight.has(track.id) || failed.has(track.id) || now() - (attempted.get(track.id) ?? -Infinity) < 300000) continue;
        attempted.set(track.id, now());
        pending.set(track.id, { track, details: /^https?:\/\//.test(getMetadata(track.id)?.artwork || ''), attempts: 0 });
      }
      publish();
      wake();
    },
    retry() {
      if (closed) return;
      for (const [id, task] of failed) if (!pending.has(id) && !inFlight.has(id)) pending.set(id, task);
      publish();
      wake();
    },
    reset() {
      generation++;
      controller.abort();
      controller = new AbortController();
      clearTimer(timer);
      timer = undefined;
      pausedUntil = 0;
      pending.clear(); inFlight.clear(); failed.clear(); attempted.clear();
      publish();
    },
    close() { closed = true; this.reset(); },
  };
}
