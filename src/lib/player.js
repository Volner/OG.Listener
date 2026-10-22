/** Keep the volume envelope independent of media events, whose timing is irregular. */
export function fadeEnvelope(position, duration, fadeIn = 1.2, fadeOut = 1.2) {
  const time = Math.max(0, Number(position) || 0);
  const smooth = (value) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const start = fadeIn > 0 ? smooth(time / fadeIn) : 1;
  const end = Number.isFinite(duration) && duration > 0 && fadeOut > 0
    ? smooth((duration - time) / fadeOut) : 1;
  return Math.min(start, end);
}

export function clampSeek(position, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(duration, Number(position) || 0));
}

/** A media URL must stay remote: blob, local cache and API proxy paths are excluded. */
export function remoteMediaUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    if (/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(url.hostname)) return '';
    return url.href;
  } catch { return ''; }
}

/** Provider flags identify full recordings; a duration or a URL alone never proves that. */
export function selectMediaSource(metadata = {}, excludedUrls = new Set()) {
  const full = metadata.audioKind === 'full';
  const audio = {
    url: remoteMediaUrl(metadata.audioUrl),
    kind: full ? 'full' : 'preview',
    provider: full ? metadata.audioSource || metadata.source : metadata.previewSource || metadata.audioSource || metadata.source,
    externalUrl: remoteMediaUrl(full ? metadata.audioExternalUrl || metadata.externalUrl : metadata.previewExternalUrl || metadata.audioExternalUrl || metadata.externalUrl),
  };
  const preview = {
    url: remoteMediaUrl(metadata.previewUrl), kind: 'preview',
    provider: metadata.previewSource || metadata.source,
    externalUrl: remoteMediaUrl(metadata.previewExternalUrl || metadata.externalUrl),
  };
  return [audio, preview].find(candidate => candidate.url && !excludedUrls.has(candidate.url)) || null;
}

export function mediaTime(value) {
  if (!Number.isFinite(value) || value < 0) return '—:—';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
