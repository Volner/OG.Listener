import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSeek, fadeEnvelope, mediaTime, remoteMediaUrl, selectMediaSource } from '../src/lib/player.js';

test('audio fades start and finish at silence with a continuous volume envelope, including short clips', () => {
  for (const duration of [0.5, 2, 30, 240]) {
    assert.equal(fadeEnvelope(0, duration), 0);
    assert.equal(fadeEnvelope(duration, duration), 0);
    let previous = 0;
    for (let step = 0; step <= 1000; step++) {
      const value = fadeEnvelope(duration * step / 1000, duration);
      assert.ok(value >= 0 && value <= 1);
      assert.ok(Math.abs(value - previous) < 0.31, 'envelope has no abrupt volume step');
      previous = value;
    }
  }
  assert.equal(fadeEnvelope(10, 30), 1);
  assert.ok(fadeEnvelope(0.6, 30) > 0 && fadeEnvelope(0.6, 30) < 1);
  assert.equal(fadeEnvelope(3, Infinity), 1, 'unknown media duration still fades in');
});

test('seeking uses the actual media duration and rejects non-finite bounds', () => {
  assert.equal(clampSeek(180, 30), 30, 'a thirty-second preview cannot seek to full track duration');
  assert.equal(clampSeek(-15, 30), 0);
  assert.equal(clampSeek(14.375, 30), 14.375);
  assert.equal(clampSeek(NaN, 30), 0);
  assert.equal(clampSeek(10, Infinity), 0);
  assert.equal(clampSeek(10, 0), 0);
});

test('player accepts remote media only and formats real preview times', () => {
  assert.equal(remoteMediaUrl('https://audio.example/preview.m4a?token=123'), 'https://audio.example/preview.m4a?token=123');
  for (const value of ['/api/audio/cache.mp3', 'blob:https://example.com/id', 'file:///track.mp3', 'http://localhost:5173/audio.mp3', 'http://127.0.0.1/media.mp3', 'http://[::1]/media.mp3', 'https://user:secret@example.com/track']) assert.equal(remoteMediaUrl(value), '');
  assert.equal(mediaTime(30.8), '0:30');
  assert.equal(mediaTime(361.2), '6:01');
  assert.equal(mediaTime(NaN), '—:—');
});

test('verified full streams win over previews and failed full streams retain preview attribution', () => {
  const full = 'https://api.audius.co/v1/tracks/verified/stream?app_name=OG.Listener';
  const preview = 'https://cdns-preview.dzcdn.net/stream/preview.mp3';
  const metadata = {
    audioUrl: full, audioKind: 'full', audioSource: 'Audius', audioExternalUrl: 'https://audius.co/artist/track',
    previewUrl: preview, previewSource: 'Deezer', previewExternalUrl: 'https://www.deezer.com/track/123',
  };
  assert.deepEqual(selectMediaSource(metadata), {
    url: full, kind: 'full', provider: 'Audius', externalUrl: 'https://audius.co/artist/track',
  });
  assert.deepEqual(selectMediaSource(metadata, new Set([full])), {
    url: preview, kind: 'preview', provider: 'Deezer', externalUrl: 'https://www.deezer.com/track/123',
  });
  assert.equal(selectMediaSource(metadata, new Set([full, preview])), null);
  assert.equal(selectMediaSource({ ...metadata, audioUrl: '/api/audio/local-file.mp3' }).url, preview);
  assert.equal(selectMediaSource({ audioUrl: full, durationMs: 300000 }).kind, 'preview', 'neither URL nor advertised duration establishes a verified full recording');
});
