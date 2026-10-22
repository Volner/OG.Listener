import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFullAudioProviders, fullAudioUrl } from '../server/full-audio.js';
import { safeMetadata, createProviders } from '../server/providers.js';
import { createLocalApi } from '../server/local-api.js';

const TRACK = { id: '1111111111111111111111', name: 'Sinners', artist: 'RAC' };
const STREAM = 'https://api.audius.co/v1/tracks/7AlA9/stream?app_name=OG.Listener';
const PREVIEW = 'https://cdnt-preview.dzcdn.net/preview.mp3';
const candidate = (extra = {}) => ({ id: '7AlA9', title: 'Sinners', user: { id: 'abc12', name: 'RAC', handle: 'RAC', is_verified: true }, duration: 237, is_streamable: true, is_stream_gated: false, is_available: true, is_delete: false, is_unlisted: false, access: { stream: true }, stream_conditions: null, permalink: '/RAC/sinners', ...extra });

test('Audius resolves an exact open full stream with source and actual duration; it only requests JSON', async () => {
  const calls = [];
  const provider = createFullAudioProviders({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ data: [candidate({ title: 'Sinners (Live)' }), candidate({ user: { id: 'other', name: 'Cover Band', handle: 'cover' } }), candidate()] }); } });
  const result = await provider.audius({ name: 'SINNERS!', artist: 'rac' });
  assert.equal(result.audioUrl, STREAM); assert.equal(result.audioKind, 'full'); assert.equal(result.audioSource, 'Audius'); assert.equal(result.audioDurationMs, 237000); assert.equal(result.audioExternalUrl, 'https://audius.co/RAC/sinners');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.cache, 'no-store'); assert.ok(calls[0].url.startsWith('https://api.audius.co/v1/tracks/search?'));
});

test('Audius excludes gated, unavailable, private, deleted, access-blocked and wrong-version tracks', async () => {
  const excluded = [candidate({ is_stream_gated: true }), candidate({ is_available: false }), candidate({ is_unlisted: true }), candidate({ is_delete: true }), candidate({ is_streamable: false }), candidate({ access: { stream: false } }), candidate({ stream_conditions: { follow_user_id: 1 } }), candidate({ title: 'Sinners (Remix)' })];
  const provider = createFullAudioProviders({ fetchImpl: async () => Response.json({ data: excluded }) });
  await assert.rejects(provider.audius(TRACK), error => error.status === 404);
});

test('Audius refuses ambiguous artist accounts and prefers an exact verified artist over an impersonator', async () => {
  let entries = [candidate({ user: { id: 'one', name: 'RAC', handle: 'one' } }), candidate({ user: { id: 'two', name: 'RAC', handle: 'two' } })];
  const provider = createFullAudioProviders({ fetchImpl: async () => Response.json({ data: entries }) });
  await assert.rejects(provider.audius(TRACK), error => error.status === 404);
  entries = [...entries, candidate()]; assert.equal((await provider.audius(TRACK)).audioUrl, STREAM);
});

test('full stream allowlist rejects preview fields, insecure URLs, forged hosts, ports and unintended Audius endpoints', () => {
  for (const value of [PREVIEW, 'http://api.audius.co/v1/tracks/123/stream', 'https://api.audius.co.evil.test/v1/tracks/123/stream', 'https://user:pass@api.audius.co/v1/tracks/123/stream', 'https://api.audius.co:444/v1/tracks/123/stream', 'https://api.audius.co/v1/tracks/123/download', 'https://api.audius.co/v1/tracks/123/stream?preview=true', 'https://storage.jamendo.com.evil.test/?trackid=1&format=mp32', '/api/audio/123']) assert.equal(fullAudioUrl(value), null, value);
  assert.equal(fullAudioUrl(STREAM), STREAM);
  assert.equal(fullAudioUrl('https://prod-1.storage.jamendo.com/?trackid=1848357&format=mp32'), 'https://prod-1.storage.jamendo.com/?trackid=1848357&format=mp32');
  assert.equal(safeMetadata({ audioKind: 'full', audioUrl: PREVIEW }), null);
  assert.equal(safeMetadata({ previewUrl: PREVIEW, audioKind: 'full' }).audioKind, 'preview');
  const clean = safeMetadata({ audioUrl: STREAM, audioKind: 'full', audioSource: 'Audius', audioDurationMs: 237000, audioExternalUrl: 'https://audius.co/RAC/sinners' });
  assert.equal(clean.audioUrl, STREAM); assert.equal(clean.audioKind, 'full'); assert.equal(clean.audioDurationMs, 237000);
});

test('full lookups deduplicate concurrent requests, cache positive and negative results only in memory', async () => {
  let calls = 0, available = true;
  const provider = createFullAudioProviders({ ttlMs: 15, negativeTtlMs: 15, fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ data: available ? [candidate()] : [] }); } });
  const results = await Promise.all([provider.resolve(TRACK), provider.resolve(TRACK)]); assert.equal(calls, 1); assert.equal(results[0].audioUrl, STREAM);
  await provider.resolve(TRACK); assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 20)); available = false; assert.equal(await provider.resolve(TRACK), null); assert.equal(calls, 2);
  assert.equal(await provider.resolve(TRACK), null); assert.equal(calls, 2);
});

test('Jamendo remains disabled without credentials and uses exact artist/title and stream URLs when configured', async () => {
  const disabled = createFullAudioProviders({ fetchImpl: async () => assert.fail('Disabled provider must not fetch') });
  assert.equal(disabled.sources().find(item => item.id === 'jamendo').configured, false);
  await assert.rejects(disabled.jamendo(TRACK), error => error.status === 503);
  let requested;
  const jamendoTrack = { id: '123', artist_id: '42', name: 'Sinners', artist_name: 'RAC', duration: 237, audio: 'https://prod-1.storage.jamendo.com/?trackid=123&format=mp32', audiodownload_allowed: false };
  const provider = createFullAudioProviders({ env: { JAMENDO_CLIENT_ID: 'test-client' }, fetchImpl: async url => { requested = new URL(url); return Response.json({ headers: { status: 'success', code: 0 }, results: [{ ...jamendoTrack, name: 'Sinners (Remix)' }, jamendoTrack] }); } });
  const result = await provider.jamendo(TRACK);
  assert.equal(provider.sources().find(item => item.id === 'jamendo').configured, true); assert.equal(requested.searchParams.get('client_id'), 'test-client'); assert.equal(requested.searchParams.get('audioformat'), 'mp32');
  assert.equal(result.audioKind, 'full'); assert.equal(result.audioSource, 'Jamendo'); assert.equal(result.audioExternalUrl, 'https://www.jamendo.com/track/123'); assert.equal(result.audioUrl, jamendoTrack.audio);
  assert.equal(JSON.stringify(result).includes('test-client'), false); assert.equal(Object.keys(result).some(key => /download/i.test(key)), false);
});

test('full provider failure preserves a verified preview, and playback-only Deezer lookup avoids album/genre requests', async () => {
  let albumCalls = 0;
  const providers = createProviders({ deezerIntervalMs: 0, fetchImpl: async url => {
    if (url.includes('/album/')) { albumCalls++; assert.fail('Playback must not wait for album genres'); }
    if (url.includes('api.audius.co')) return new Response('unavailable', { status: 503 });
    return Response.json({ data: [{ title: 'Sinners', artist: { name: 'RAC' }, preview: PREVIEW, duration: 237, album: { id: 42 } }] });
  } });
  assert.equal(await providers.fullAudio(TRACK), null); const preview = await providers.deezer(TRACK, { genres: false }); assert.equal(preview.previewUrl, PREVIEW); assert.equal(preview.audioKind, 'preview'); assert.equal(albumCalls, 0);
});

test('playback resolves full audio before the cached preview, exposes source status and only redirects media without disk writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-full-audio-')); let fullCalls = 0, genreCalls = 0;
  const api = createLocalApi({ root, requestIntervalMs: 0, providers: {
    spotify: async () => ({ artwork: 'https://i.scdn.co/image/cover' }),
    deezer: async () => ({ previewUrl: PREVIEW, previewSource: 'Deezer', genres: ['Electronic'] }),
    fullAudio: async () => { fullCalls++; return { audioUrl: STREAM, audioKind: 'full', audioSource: 'Audius', audioExternalUrl: 'https://audius.co/RAC/sinners', audioDurationMs: 237000 }; },
    artistGenres: async () => { genreCalls++; return { genres: [] }; },
    audioSources: () => [{ id: 'audius', name: 'Audius', audioKind: 'full', configured: true, requiresKey: false }, { id: 'jamendo', name: 'Jamendo', audioKind: 'full', configured: false, requiresKey: true }],
  } });
  const server = createServer((req, res) => api.middleware(req, res, () => { res.statusCode = 404; res.end(); })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = await fetch(`${base}/api/catalog/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks: [TRACK] }) }); assert.equal(post.status, 200); assert.equal(fullCalls, 0);
  const url = `${base}/api/tracks/${TRACK.id}?title=Sinners&artist=RAC&full=true&details=false`;
  const metadata = await (await fetch(url)).json(); assert.equal(metadata.audioUrl, STREAM); assert.equal(metadata.previewUrl, PREVIEW); assert.equal(metadata.audioKind, 'full'); assert.equal(metadata.fullResolved, undefined); assert.equal(genreCalls, 0);
  await fetch(url); assert.equal(fullCalls, 1);
  const redirect = await fetch(`${base}/api/audio/${TRACK.id}`, { redirect: 'manual' }); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), STREAM);
  const status = await (await fetch(`${base}/api/audio/providers`)).json(); assert.equal(status.sources.find(item => item.id === 'jamendo').configured, false);
  assert.deepEqual(await readdir(root), []);
});

test('slow genre enrichment neither blocks playback nor demotes an already verified full recording', async t => {
  let release, started;
  const gate=new Promise(resolve=>{release=resolve;});
  const hasStarted=new Promise(resolve=>{started=resolve;});
  const api=createLocalApi({requestIntervalMs:0,providers:{
    spotify:async()=>({artwork:'https://i.scdn.co/image/cover'}),
    deezer:async(track,{genres=true}={})=>{if(genres){started();await gate;}return {previewUrl:PREVIEW,previewSource:'Deezer',audioKind:'preview',...(genres?{genres:['Electronic']}:{})};},
    fullAudio:async()=>({audioUrl:STREAM,audioKind:'full',audioSource:'Audius',audioExternalUrl:'https://audius.co/RAC/sinners',audioDurationMs:237000}),
  }});
  const server=createServer((req,res)=>api.middleware(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release();await api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const batch=details=>fetch(`${base}/api/catalog/resolve`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tracks:[TRACK],details})});
  await batch(false);
  const enrichment=batch(true);await hasStarted;
  const playback=await (await fetch(`${base}/api/tracks/${TRACK.id}?title=Sinners&artist=RAC&full=true&details=false`,{signal:AbortSignal.timeout(1000)})).json();
  assert.equal(playback.audioKind,'full');assert.equal(playback.audioUrl,STREAM);
  release();
  const enriched=await (await enrichment).json();
  assert.equal(enriched.entries[TRACK.id].audioKind,'full');assert.equal(enriched.entries[TRACK.id].audioUrl,STREAM);
  assert.equal(enriched.entries[TRACK.id].audioSource,'Audius');assert.deepEqual(enriched.entries[TRACK.id].genres,['Electronic']);
});
