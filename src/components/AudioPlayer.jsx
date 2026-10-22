import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Pause, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import { clampSeek, fadeEnvelope, mediaTime, remoteMediaUrl, selectMediaSource } from '../lib/player.js';
import { useI18n } from '../lib/i18n-react.jsx';
import { apiUrl } from '../lib/api-url.js';
import './audio-player.css';

/** One player for every provider. Only remote media URLs reach the audio element. */
export default function AudioPlayer({ track, playRequest = 0, onClose, onError, onResolved, onOpenDetails }) {
  const { t } = useI18n();
  const trackKey = String(track?.id || track?.uri || `${track?.artist}:${track?.name}`);
  const audio = useRef(null);
  const latest = useRef({ track, onClose, onError, onResolved, onOpenDetails });
  latest.current = { track, onClose, onError, onResolved, onOpenDetails };
  const identity = useRef(trackKey);
  const controller = useRef(null);
  const failedUrls = useRef(new Set());
  const desiredPlay = useRef(true);
  const dragging = useRef(false);
  const seekTarget = useRef(0);
  const pauseFrame = useRef(0);
  const volumeRef = useRef(0.8);
  const previousRequest = useRef({ key: trackKey, value: playRequest });
  const [source, setSource] = useState('');
  const sourceRef = useRef('');
  const [media, setMedia] = useState(null);
  const [resolved, setResolved] = useState(null);
  const resolvedRef = useRef(null);
  const [status, setStatus] = useState('resolving');
  const [message, setMessage] = useState('Ищем полную версию…');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [seeking, setSeeking] = useState(false);

  function applyVolume() {
    const element = audio.current;
    if (!element || pauseFrame.current) return;
    try { element.volume = volumeRef.current * fadeEnvelope(element.currentTime, element.duration); } catch { /* Some mobile browsers manage hardware volume. */ }
  }

  function startPlayback() {
    const element = audio.current;
    desiredPlay.current = true;
    cancelAnimationFrame(pauseFrame.current);
    pauseFrame.current = 0;
    if (!element || !sourceRef.current) return;
    if (element.ended) element.currentTime = 0;
    applyVolume();
    const requestedKey = identity.current;
    const requestedSource = sourceRef.current;
    element.play()?.catch(error => {
      if (identity.current !== requestedKey || sourceRef.current !== requestedSource || error.name === 'AbortError') return;
      setPlaying(false);
      // Autoplay restrictions leave the same usable player and a direct play button.
      if (error.name === 'NotAllowedError') {
        desiredPlay.current = false;
        setMessage('Нажмите, чтобы слушать');
      }
    });
  }

  function pausePlayback(afterPause) {
    const element = audio.current;
    desiredPlay.current = false;
    cancelAnimationFrame(pauseFrame.current);
    pauseFrame.current = 0;
    if (!element || element.paused) { afterPause?.(); return; }
    const initial = element.volume;
    const started = performance.now();
    const key = identity.current;
    const fade = now => {
      if (key !== identity.current) return;
      const elapsed = Math.min(1, (now - started) / 150);
      try { element.volume = initial * (1 - elapsed); } catch { /* Hardware volume can be read-only. */ }
      if (elapsed < 1) pauseFrame.current = requestAnimationFrame(fade);
      else { pauseFrame.current = 0; element.pause(); afterPause?.(); }
    };
    pauseFrame.current = requestAnimationFrame(fade);
  }

  function togglePlayback() {
    if (!sourceRef.current) return;
    if (audio.current?.paused || !desiredPlay.current) startPlayback();
    else pausePlayback();
  }

  function setMediaSource(selected) {
    sourceRef.current = selected?.url || '';
    setSource(selected?.url || '');
    setMedia(selected);
    if (selected) {
      setStatus('loading');
      setMessage(selected.kind === 'full' ? 'Загружаем трек…' : 'Загружаем превью…');
    }
  }

  function availableSource(metadata) {
    return selectMediaSource(metadata, failedUrls.current)
      || selectMediaSource(latest.current.track, failedUrls.current);
  }

  function updateSessionPosition() {
    const element = audio.current;
    if (!('mediaSession' in navigator) || !element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState?.({
        duration: element.duration, position: clampSeek(element.currentTime, element.duration), playbackRate: element.playbackRate || 1,
      });
    } catch { /* Media Session support differs between browsers. */ }
  }

  function seekTo(position) {
    const element = audio.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    const value = clampSeek(position, element.duration);
    dragging.current = false;
    seekTarget.current = value;
    setSeeking(false);
    element.currentTime = value;
    setCurrentTime(value);
    applyVolume();
    updateSessionPosition();
  }

  async function resolveMedia() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const key = identity.current;
    const item = latest.current.track;
    setStatus('resolving');
    setMessage('Ищем полную версию…');
    const timer = setTimeout(() => request.abort(new DOMException('Аудиоисточники не ответили вовремя', 'TimeoutError')), 14000);
    try {
      const params = new URLSearchParams({ title: item.name || item.title || '', artist: item.artist || '', apple: 'true', full: 'true', details: 'false' });
      const response = await fetch(apiUrl(`/api/tracks/${encodeURIComponent(item.id || item.uri || key)}?${params}`), { signal: request.signal });
      const payload = await response.json().catch(() => ({}));
      if (request.signal.aborted || key !== identity.current) return;
      if (!response.ok) throw Error(payload.error?.message || (typeof payload.error === 'string' ? payload.error : '') || 'Не удалось проверить источники аудио');
      const metadata = payload?.metadata || payload || {};
      resolvedRef.current = metadata;
      setResolved(metadata);
      latest.current.onResolved?.(item.id, metadata);
      const selected = availableSource(metadata);
      setMediaSource(selected);
      if (!selected) {
        setStatus('unavailable');
        setMessage('Аудио недоступно у источников');
      }
    } catch (error) {
      if (key !== identity.current || request.signal.aborted && request.signal.reason?.name !== 'TimeoutError') return;
      const fallback = availableSource(resolvedRef.current || {});
      if (fallback) { setMediaSource(fallback); return; }
      setStatus('unavailable');
      setMessage('Не удалось загрузить аудио');
      latest.current.onError?.(error.message);
    } finally { clearTimeout(timer); }
  }

  useEffect(() => {
    identity.current = trackKey;
    failedUrls.current = new Set();
    desiredPlay.current = true;
    dragging.current = false;
    cancelAnimationFrame(pauseFrame.current);
    pauseFrame.current = 0;
    setSeeking(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setResolved(null);
    resolvedRef.current = null;
    const supplied = selectMediaSource(latest.current.track);
    // A cached preview still gets one full-version lookup before initial playback.
    setMediaSource(supplied?.kind === 'full' ? supplied : null);
    if (supplied?.kind !== 'full') resolveMedia();
    return () => controller.current?.abort();
  }, [trackKey]);

  // Same-track metadata updates never replace the selected source or start playback.

  useEffect(() => {
    const element = audio.current;
    // The identity effect can queue a new source in this same commit.
    if (source !== sourceRef.current) return;
    element.pause();
    setPlaying(false);
    if (!source) {
      element.removeAttribute('src');
      element.load();
      return;
    }
    element.src = source;
    element.volume = 0;
    element.load();
    if (desiredPlay.current) startPlayback();
  }, [trackKey, source]);

  useEffect(() => {
    const previous = previousRequest.current;
    previousRequest.current = { key: trackKey, value: playRequest };
    if (previous.key === trackKey && previous.value !== playRequest) togglePlayback();
  }, [playRequest, trackKey]);

  useEffect(() => {
    if (!playing) return;
    let frame;
    const tick = () => {
      const element = audio.current;
      if (!element) return;
      if (!dragging.current) setCurrentTime(element.currentTime || 0);
      applyVolume();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const actions = {
      play: () => startPlayback(),
      pause: () => pausePlayback(),
      stop: () => pausePlayback(() => seekTo(0)),
      seekbackward: action => seekTo((audio.current?.currentTime || 0) - (action.seekOffset || 10)),
      seekforward: action => seekTo((audio.current?.currentTime || 0) + (action.seekOffset || 10)),
      seekto: action => { if (Number.isFinite(action.seekTime)) seekTo(action.seekTime); },
    };
    for (const [action, handler] of Object.entries(actions)) {
      try { session.setActionHandler(action, handler); } catch { /* Ignore individual unsupported actions. */ }
    }
    return () => {
      for (const action of Object.keys(actions)) {
        try { session.setActionHandler(action, null); } catch { /* Browser may not support this action. */ }
      }
      try { session.metadata = null; session.playbackState = 'none'; session.setPositionState?.(); } catch { /* Optional API. */ }
    };
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* Optional API. */ }
    updateSessionPosition();
  }, [playing, duration, trackKey]);

  function commitSeek() {
    if (!dragging.current) return;
    dragging.current = false;
    setSeeking(false);
    const element = audio.current;
    if (!element || !Number.isFinite(element.duration)) return;
    seekTo(seekTarget.current);
  }

  useEffect(() => {
    const release = () => commitSeek();
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, []);

  useEffect(() => {
    // Capture the element while mounted; React clears refs before unmount cleanup.
    const element = audio.current;
    return () => {
      controller.current?.abort();
      cancelAnimationFrame(pauseFrame.current);
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, []);

  function seekChange(event) {
    const value = clampSeek(Number(event.target.value), duration);
    seekTarget.current = value;
    setCurrentTime(value);
    if (!dragging.current && audio.current) {
      seekTo(value);
    }
  }

  function seekKey(event) {
    const jumps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -10, PageUp: 10 };
    if (!duration || !['Home', 'End', ...Object.keys(jumps)].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? duration : currentTime + jumps[event.key];
    const value = clampSeek(target, duration);
    seekTarget.current = value;
    setCurrentTime(value);
    seekTo(value);
  }

  function onMediaError() {
    if (!sourceRef.current) return;
    failedUrls.current.add(sourceRef.current);
    sourceRef.current = '';
    setSource('');
    setPlaying(false);
    // Full-stream failures can use the independently matched preview immediately.
    const fallback = availableSource(resolvedRef.current || {});
    if (fallback) setMediaSource(fallback);
    else resolveMedia();
  }

  const details = { ...track, ...resolved };
  const artwork = remoteMediaUrl(details.artwork);
  const kind = t(media?.kind === 'full' ? 'Полный трек' : 'Превью');
  const provider = media?.provider || t('Аудиоисточник');
  const providerLabel = media?.kind !== 'full' && /apple music|itunes/i.test(provider) ? 'Preview provided courtesy of iTunes' : provider;
  const providerUrl = media?.externalUrl;
  const waiting = status === 'resolving' || status === 'loading';
  const unavailable = status === 'unavailable';
  const progress = duration ? Math.min(100, currentTime / duration * 100) : 0;

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.name || track.title || '', artist: track.artist || '', album: track.album || '',
        artwork: artwork ? [{ src: artwork }] : [],
      });
    } catch { /* The native player remains usable without platform metadata. */ }
  }, [trackKey, track.name, track.title, track.artist, track.album, artwork]);

  return <section className={`audio-player${seeking ? ' is-seeking' : ''}`} aria-label={t('Аудиоплеер')} data-audio-kind={media?.kind || 'pending'}>
    <audio ref={audio} preload="metadata"
      onLoadedMetadata={() => {
        const element = audio.current;
        const length = Number.isFinite(element.duration) ? element.duration : 0;
        setDuration(length);
        setStatus('ready');
        setMessage(media?.kind === 'full' ? 'Полный трек' : 'Превью');
        applyVolume();
        updateSessionPosition();
      }}
      onDurationChange={() => { const value = audio.current?.duration; if (Number.isFinite(value)) setDuration(value); }}
      onCanPlay={() => { setStatus('ready'); }}
      onPlaying={() => { setPlaying(true); setStatus('ready'); setMessage(media?.kind === 'full' ? 'Полный трек' : 'Превью'); }}
      onPause={() => setPlaying(false)}
      onTimeUpdate={() => { if ((!playing || document.hidden) && !dragging.current) setCurrentTime(audio.current?.currentTime || 0); applyVolume(); updateSessionPosition(); }}
      onSeeked={updateSessionPosition}
      onEnded={() => { desiredPlay.current = false; setPlaying(false); setCurrentTime(audio.current?.duration || 0); }}
      onError={onMediaError}/>
    <button className="audio-player-identity" onClick={() => latest.current.onOpenDetails?.(latest.current.track)} title={t('Открыть карточку трека')}>
      <span className="audio-player-cover"><span>{String(track.artist || track.name || '?').slice(0, 1)}</span>{artwork && <img key={artwork} src={artwork} alt="" onError={event => { event.currentTarget.style.display = 'none'; }}/>}</span>
      <span className="audio-player-title"><strong>{track.name || track.title}</strong><span>{track.artist}</span></span>
    </button>
    <button type="button" className="audio-player-toggle" aria-label={t(playing ? 'Пауза' : 'Воспроизвести')} disabled={!source || waiting} onClick={togglePlayback}>
      {waiting ? <LoaderCircle size={19} className="audio-player-spinner"/> : playing ? <Pause size={19} fill="currentColor"/> : <Play size={19} fill="currentColor"/>}
    </button>
    <div className="audio-player-timeline">
      {unavailable ? <div className="audio-player-unavailable" role="status"><span>{t(message)}</span><button type="button" onClick={() => { failedUrls.current.clear(); desiredPlay.current = true; resolveMedia(); }}><RotateCcw size={14}/> {t('Повторить')}</button></div> : <>
        <div className="audio-player-time"><span>{mediaTime(currentTime)}</span><span>{duration ? mediaTime(duration) : '—:—'}</span></div>
        <input className="audio-player-seek" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(currentTime, duration || 1)} disabled={!duration || !source}
          style={{ '--audio-progress': `${progress}%` }} aria-label={t('Позиция воспроизведения')} aria-valuetext={t('{current} из {duration}', { current: mediaTime(currentTime), duration: mediaTime(duration) })}
          onPointerDown={() => { if (duration) { dragging.current = true; seekTarget.current = currentTime; setSeeking(true); } }}
          onChange={seekChange} onKeyDown={seekKey} onPointerUp={commitSeek} onPointerCancel={commitSeek} onBlur={commitSeek}/>
        <div className="audio-player-source">{waiting ? <span role="status">{t(message)}</span> : <><span className="audio-player-kind">{kind}</span><span aria-hidden="true"> · </span>{providerUrl ? <a href={providerUrl} target="_blank" rel="noreferrer">{providerLabel} <ExternalLink size={10}/></a> : <span>{providerLabel}</span>}</>}</div>
      </>}
    </div>
    <div className="audio-player-volume"><button type="button" aria-label={t(volume ? 'Выключить звук' : 'Включить звук')} onClick={() => { const value = volume ? 0 : 0.8; volumeRef.current = value; setVolume(value); applyVolume(); }}>{volume ? <Volume2 size={18}/> : <VolumeX size={18}/>}</button><input type="range" min="0" max="1" step="0.01" value={volume} style={{ '--audio-progress': `${volume * 100}%` }} aria-label={t('Громкость')} onChange={event => { const value = Number(event.target.value); volumeRef.current = value; setVolume(value); applyVolume(); }}/></div>
    <button type="button" className="audio-player-close" aria-label={t('Закрыть плеер')} onClick={() => { controller.current?.abort(); pausePlayback(() => latest.current.onClose?.()); }}><X size={18}/></button>
  </section>;
}
