import assert from 'node:assert/strict';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { analyzeHistory, analyzeItemHistory, normalizeHistoryDocuments, parseGrowthCsv, parseHistoryFiles } from '../src/lib/history.js';

function event(id, name, artist, ts, ms = 180000, extra = {}) {
  return {
    ts, ms_played: ms, master_metadata_track_name: name,
    master_metadata_album_artist_name: artist, master_metadata_album_album_name: 'Album',
    spotify_track_uri: `spotify:track:${id}`, platform: 'desktop',
    reason_start: 'trackdone', reason_end: 'trackdone', skipped: false,
    ...extra,
  };
}

test('official normalization deduplicates overlapping exports and strips private fields', () => {
  const first = event('aaa', 'One', 'Artist', '2019-01-02T11:12:13Z', 180000, { ip_addr: 'private', conn_country: 'RU' });
  const otherDevice = { ...first, platform: 'mobile' };
  const podcast = { ts: '2020-01-01T00:00:00Z', episode_name: 'Podcast', spotify_episode_uri: 'spotify:episode:abc', ms_played: 10000 };
  const result = normalizeHistoryDocuments([{ name: 'first.json', data: [first, podcast] }, { name: 'overlap.json', data: [first, otherDevice] }], 'sample.zip');
  assert.equal(result.rawEventCount, 4);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.fileCount, 2);
  assert.equal(result.events.length, 2);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].id, 'aaa');
  assert.equal(result.tracks[0].firstPlayed, '2019-01-02T11:12:13.000Z');
  const serialized = JSON.stringify(result);
  for (const sensitive of ['ip_addr', 'private', 'conn_country', 'platform', 'reason_start', 'reason_end']) {
    assert.ok(!serialized.includes(sensitive));
  }
});

test('basic history uses UTC, retains short plays, and groups local track names', () => {
  const result = normalizeHistoryDocuments([[
    { endTime: '2024-12-31 23:59', artistName: 'Artist', trackName: 'One', msPlayed: 1000 },
    { endTime: '2025-01-01 00:00', artistName: 'Artist', trackName: 'One', msPlayed: 30000 },
    { endTime: '2025-01-01 00:01', artistName: 'Artist', trackName: 'One', msPlayed: 0 },
  ]]);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].uri, '');
  assert.equal(result.tracks[0].id, 'local:artist::one');
  assert.equal(result.tracks[0].firstPlayed, '2024-12-31T23:59:00.000Z');
  assert.equal(analyzeHistory(result).stats.plays, 1);
  assert.equal(analyzeHistory(result, { minMs: 0 }).stats.plays, 2);
  assert.equal(analyzeHistory(result, { year: 2024, minMs: 0 }).stats.msPlayed, 1000);
});

test('first-heard dates ignore zero-duration events but include audible short plays', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'Audible', 'Artist', '2019-01-01T00:00:00Z', 0),
    event('bbb', 'Never audible', 'Artist', '2018-01-01T00:00:00Z', 0),
    event('aaa', 'Audible', 'Artist', '2020-01-01T00:00:00Z', 1000),
    event('aaa', 'Audible', 'Artist', '2026-01-01T00:00:00Z', 60000),
  ]]);
  assert.equal(result.events.length, 4);
  assert.equal(result.tracks[0].firstPlayed, '2020-01-01T00:00:00.000Z');
  assert.equal(result.tracks[1].firstPlayed, '2018-01-01T00:00:00.000Z');
  assert.equal(analyzeHistory(result).items[0].firstPlayed, '2020-01-01T00:00:00.000Z');
  assert.equal(analyzeHistory(result, { entity: 'artists' }).items[0].firstPlayed, '2020-01-01T00:00:00.000Z');
  assert.equal(analyzeHistory(result, { minMs: 0 }).stats.plays, 2);
});

test('year, duration, search, genres, totals and months reflect selected events', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'Artist A', '2019-01-01T00:00:00Z', 5000, { skipped: true }),
    event('aaa', 'One', 'Artist A', '2026-01-02T00:00:00Z', 30000),
    event('aaa', 'One', 'Artist A', '2026-02-03T00:00:00Z', 60000, { skipped: true }),
    event('bbb', 'Two', 'Artist B', '2026-02-05T00:00:00Z', 100000),
  ]]);
  const analysis = analyzeHistory(result, { year: 2026, query: 'ARTIST A', genre: 'R&B', metadata: { aaa: { genres: ['R&B'], artwork: 'cover.jpg' } } });
  assert.deepEqual(analysis.years, [2026, 2019]);
  assert.equal(analysis.stats.plays, 2);
  assert.equal(analysis.stats.msPlayed, 90000);
  assert.equal(analysis.stats.tracks, 1);
  assert.equal(analysis.stats.artists, 1);
  assert.equal(analysis.stats.skippedRate, 0.5);
  assert.equal(analysis.stats.firstPlayed, '2026-01-02T00:00:00.000Z');
  assert.equal(analysis.items[0].firstPlayed, '2019-01-01T00:00:00.000Z');
  assert.equal(analysis.items[0].artwork, 'cover.jpg');
  assert.deepEqual(analysis.months, [{ month: '2026-01', plays: 1, msPlayed: 30000 }, { month: '2026-02', plays: 1, msPlayed: 60000 }]);
  assert.equal(analyzeHistory(result, { query: 'missing' }).stats.firstPlayed, null);
});

test('artist grouping unions genres and uses lifetime artist discovery date', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'Artist', '2019-01-01T00:00:00Z'),
    event('bbb', 'Two', 'Artist', '2026-01-02T00:00:00Z'),
    event('bbb', 'Two', 'Artist', '2026-01-03T00:00:00Z'),
    event('aaa', 'One', 'Artist', '2026-01-04T00:00:00Z'),
  ]]);
  const { items, stats } = analyzeHistory(result, {
    year: 2026, entity: 'artists', metadata: {
      aaa: { genres: ['trap'], artwork: 'one.jpg' },
      bbb: { genres: ['r&b'], artwork: 'two.jpg', artistArtwork: 'artist.jpg', artistId: 'theartist' },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'artist:artist');
  assert.equal(items[0].firstPlayed, '2019-01-01T00:00:00.000Z');
  assert.equal(items[0].firstTrackName, 'One');
  assert.equal(items[0].firstTrackId, 'aaa');
  assert.equal(items[0].plays, 3);
  assert.equal(items[0].trackCount, 2);
  assert.equal(items[0].artwork, 'artist.jpg');
  assert.equal(items[0].spotifyUrl, 'https://open.spotify.com/artist/theartist');
  assert.deepEqual(items[0].genres, ['r&b', 'trap']);
  assert.equal(stats.tracks, 2);
});

test('artist first track comes from the entire audible archive regardless of year, duration, search and genre', () => {
  const result = normalizeHistoryDocuments([[
    event('silent', 'Silent', 'Artist', '2018-01-01T00:00:00Z', 0),
    event('later', 'Current favorite', 'Artist', '2026-01-01T00:00:00Z'),
    event('first', 'First ever', 'Artist', '2019-01-01T00:00:00Z', 1000),
  ]]);
  const analysis = analyzeHistory(result, {
    entity: 'artists', year: 2026, minMs: 30000, query: 'Current favorite', genre: 'trap',
    metadata: { later: { genres: ['trap'] }, first: { genres: ['piano'] } },
  });
  assert.equal(analysis.items.length, 1);
  assert.equal(analysis.items[0].topTrack, 'Current favorite');
  assert.equal(analysis.items[0].firstTrackId, 'first');
  assert.deepEqual(analysis.items[0].firstTrack, {
    id: 'first', name: 'First ever', artist: 'Artist', album: 'Album',
    uri: 'spotify:track:first', firstPlayed: '2019-01-01T00:00:00.000Z',
  });
});

test('unknown genre filtering preserves provider display names and metadata attribution', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'Artist A', '2026-01-01T00:00:00Z'),
    event('bbb', 'Two', 'Artist B', '2026-02-01T00:00:00Z'),
  ]]);
  const metadata = { aaa: { genres: ['Hip-Hop/Rap'], source: 'Apple Music / iTunes', artworkSource: 'Spotify oEmbed', externalUrl: 'https://music.apple.com/track', matchedTitle: 'One', matchedArtist: 'Artist A', matchConfidence: 1 } };
  const all = analyzeHistory(result, { metadata });
  assert.deepEqual(all.items[0].genres, ['Hip-Hop/Rap']);
  assert.equal(all.items[0].externalUrl, 'https://music.apple.com/track');
  assert.equal(all.items[0].artworkSource, 'Spotify oEmbed');
  const unknown = analyzeHistory(result, { genre: 'unknown', metadata });
  assert.equal(unknown.items[0].id, 'bbb');
  assert.equal(unknown.stats.plays, 1);
  assert.deepEqual(unknown.months, [{ month: '2026-02', plays: 1, msPlayed: 180000 }]);
  assert.equal(analyzeHistory(result, { genre: 'HIP-HOP/RAP', metadata }).items[0].id, 'aaa');
  assert.strictEqual(analyzeHistory(result, { metadata }), all);
});

test('growth baseline is latest historical snapshot, never the nearest future date', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'Artist', '2019-02-01T00:00:00Z'),
    event('bbb', 'Two', 'Unknown', '2019-02-01T00:00:00Z'),
  ]]);
  const growth = [
    { artist: 'Artist', date: '2018-01-01', listeners: 10, source: 'verified' },
    { artist: 'Artist', date: '2019-01-01', listeners: 13, source: 'verified' },
    { artist: 'Artist', date: '2019-02-02', listeners: 100, source: 'verified' },
    { artist: 'Artist', date: '2026-10-01', listeners: 2000000, source: 'verified' },
    { artist: 'Unknown', date: '2019-02-02', listeners: 30, source: 'verified' },
    { artist: 'Unknown', date: '2026-10-01', listeners: 300, source: 'verified' },
  ];
  const { items } = analyzeHistory(result, { growth });
  assert.equal(items[0].baseline, 13);
  assert.equal(items[0].current, 2000000);
  assert.equal(items[0].growthScore, 2000000 / 13);
  assert.equal(items[1].growthScore, null);
});

test('growth never combines different metrics or providers and requires later evidence', () => {
  const result = normalizeHistoryDocuments([[event('aaa', 'One', 'Artist', '2020-06-01T00:00:00Z')]]);
  for (const growth of [
    [{ artist: 'Artist', date: '2019-01-01', listeners: 13, metric: 'monthly_listeners' }, { artist: 'Artist', date: '2026-01-01', listeners: 2000000, metric: 'streams' }],
    [{ artist: 'Artist', date: '2019-01-01', listeners: 13, source: 'A' }, { artist: 'Artist', date: '2026-01-01', listeners: 2000000, source: 'B' }],
    [{ artist: 'Artist', date: '2019-01-01', listeners: 13 }, { artist: 'Artist', date: '2020-01-01', listeners: 2000000 }],
    [{ artist: 'Artist', date: '2019-01-01', listeners: 0 }, { artist: 'Artist', date: '2026-01-01', listeners: 2000000 }],
  ]) assert.equal(analyzeHistory(result, { growth }).items[0].growthScore, null);
});

test('duplicate growth snapshots use the last correction and calculate actual ratios', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'A', '2019-06-01T00:00:00Z'),
    event('bbb', 'Two', 'B', '2026-06-01T00:00:00Z'),
    event('ccc', 'Three', 'C', '2024-06-01T00:00:00Z'),
  ]]);
  const growth = parseGrowthCsv('artist,date,listeners,source\nA,2019-01-01,12,test\nA,2019-01-01,13,test\nA,2026-10-01,2000000,test\nB,2026-01-01,500000,test\nB,2026-10-01,530000,test\nC,2024-01-01,300,test\nC,2026-10-01,320,test');
  const ranked = analyzeHistory(result, { growth }).items.sort((a, b) => b.growthScore - a.growthScore);
  assert.deepEqual(ranked.map((item) => item.name), ['One', 'Three', 'Two']);
  assert.equal(ranked[0].baseline, 13);
});

test('CSV accepts quoted names, BOM, optional source and explicit comparable metrics', () => {
  const parsed = parseGrowthCsv('\uFEFFartist,date,listeners,source,metric\n"Earth, Wind & Fire",2019-01-01,13,"A, B",streams\n"A ""quoted"" artist",2026-01-01,100,,monthly listeners');
  assert.equal(parsed[0].artist, 'Earth, Wind & Fire');
  assert.equal(parsed[0].source, 'A, B');
  assert.equal(parsed[0].metric, 'streams');
  assert.equal(parsed[1].artist, 'A "quoted" artist');
  assert.equal(parsed[1].source, 'CSV');
  assert.equal(parsed[1].metric, 'monthly_listeners');
  assert.equal(parseGrowthCsv('artist;date;listeners\nArtist;2026-01-01;1 000')[0].listeners, 1000);
  assert.throws(() => parseGrowthCsv('artist,date\nA,2026-01-01'), /listeners/);
  assert.throws(() => parseGrowthCsv('artist,date,listeners\nA,invalid,123'), /строке 2/);
  assert.throws(() => parseGrowthCsv('artist,date,listeners\n"A,2026-01-01,123'), /кавычка/);
});

test('growth CSV rejects calendar rollover and future snapshots; analyzer ignores them', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.throws(() => parseGrowthCsv(`artist,date,listeners\nArtist,${future},1000`), /строке 2.*будущем/);
  assert.throws(() => parseGrowthCsv('artist,date,listeners\nArtist,2024-02-31,1000'), /строке 2/);
  assert.throws(() => parseGrowthCsv('artist,date,listeners\nArtist,2024-02-31T12:00:00Z,1000'), /строке 2/);
  assert.equal(parseGrowthCsv('artist,date,listeners\nArtist,2024-02-29,1000')[0].date, '2024-02-29T00:00:00.000Z');
  const result = normalizeHistoryDocuments([[event('aaa', 'One', 'Artist', '2024-06-01T00:00:00Z')]]);
  const growth = [
    { artist: 'Artist', date: '2024-01-01', listeners: 10 },
    { artist: 'Artist', date: '2024-02-31', listeners: 100 },
    { artist: 'Artist', date: '2025-01-01', listeners: 20 },
    { artist: 'Artist', date: future, listeners: 1000000 },
  ];
  const item = analyzeHistory(result, { growth }).items[0];
  assert.equal(item.baseline, 10);
  assert.equal(item.current, 20);
  assert.equal(item.growthScore, 2);
});

test('browser ZIP importer extracts JSON histories and ignores unrelated files', async () => {
  const rows = [event('aaa', 'One', 'Artist', '2026-01-01T00:00:00Z')];
  const bytes = zipSync({ 'history/Streaming_History_Audio.json': strToU8(JSON.stringify(rows)), 'readme.pdf': strToU8('pdf'), '__MACOSX/invalid.json': strToU8('invalid') });
  const dataset = await parseHistoryFiles([{ name: 'my_spotify_data.zip', arrayBuffer: async () => bytes.buffer }]);
  assert.equal(dataset.tracks[0].name, 'One');
  assert.equal(dataset.fileCount, 1);
  assert.equal(dataset.source, 'my_spotify_data.zip');
  await assert.rejects(parseHistoryFiles([{ name: 'broken.json', arrayBuffer: async () => strToU8('broken').buffer }]), /broken.json/);
  await assert.rejects(parseHistoryFiles([]), /ZIP/);
});

test('search ignores case, punctuation and accents while preserving artist totals', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'Back in Black', 'AC/DC', '2024-01-01T00:00:00Z'),
    event('bbb', 'Thunderstruck', 'AC/DC', '2024-01-02T00:00:00Z'),
    event('ccc', 'Звёзды!', 'СЕРЁГА-ПИРАТ', '2024-01-03T00:00:00Z'),
    event('ddd', 'Déjà Vu', 'Other', '2024-01-04T00:00:00Z'),
  ]]);
  assert.equal(analyzeHistory(result, { query: 'acdc' }).stats.plays, 2);
  assert.equal(analyzeHistory(result, { query: 'black, ac/dc!' }).items[0].id, 'aaa');
  assert.equal(analyzeHistory(result, { query: 'серега пират' }).items[0].id, 'ccc');
  assert.equal(analyzeHistory(result, { query: 'deja vu' }).items[0].id, 'ddd');
  const artists = analyzeHistory(result, { entity: 'artists', query: 'back in black' });
  assert.equal(artists.items[0].name, 'AC/DC');
  assert.equal(artists.items[0].plays, 2);
  assert.equal(artists.stats.tracks, 2);
});

test('date and play-count filters use inclusive UTC dates and grouped artist counts', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'One', 'Artist', '2023-12-31T23:59:59Z'),
    event('aaa', 'One', 'Artist', '2024-01-01T00:00:00Z'),
    event('aaa', 'One', 'Artist', '2024-01-31T23:59:59Z'),
    event('bbb', 'Two', 'Artist', '2024-01-20T00:00:00Z'),
    event('bbb', 'Two', 'Artist', '2024-02-01T00:00:00Z'),
    event('ccc', 'Three', 'Other', '2024-01-21T00:00:00Z'),
  ]]);
  const scope = { dateFrom:'2024-01-01',dateTo:'2024-01-31' };
  const tracks = analyzeHistory(result, { ...scope,minPlays:2,maxPlays:2 });
  assert.deepEqual(tracks.items.map(item=>item.id), ['aaa']);
  assert.equal(tracks.stats.plays, 2);
  assert.equal(tracks.stats.firstPlayed, '2024-01-01T00:00:00.000Z');
  assert.equal(tracks.stats.lastPlayed, '2024-01-31T23:59:59.000Z');
  const artists = analyzeHistory(result, { ...scope,entity:'artists',minPlays:3,maxPlays:3 });
  assert.equal(artists.items[0].name, 'Artist');
  assert.equal(artists.items[0].plays, 3);
  assert.equal(artists.stats.tracks, 2);
  assert.equal(artists.stats.plays, 3);
});

test('track and artist card timelines include all audible events outside library filters', () => {
  const result = normalizeHistoryDocuments([[
    event('aaa', 'First', 'Artist', '2019-01-01T00:00:00Z', 1000),
    event('aaa', 'First', 'Artist', '2024-02-01T00:00:00Z'),
    event('bbb', 'Second', 'Artist', '2026-03-01T00:00:00Z'),
    event('ccc', 'Other', 'Other Artist', '2026-03-01T00:00:00Z'),
  ]]);
  const filtered = analyzeHistory(result, { entity:'artists',dateFrom:'2026-01-01',query:'artist' }).items.find(item=>item.name==='Artist');
  assert.equal(filtered.plays, 1);
  const artist = analyzeItemHistory(result, filtered);
  assert.equal(artist.stats.plays, 3);
  assert.deepEqual(artist.months.map(month=>month.month), ['2019-01','2024-02','2026-03']);
  const track = analyzeItemHistory(result, { id:'aaa' });
  assert.equal(track.stats.plays, 2);
  assert.deepEqual(track.months.map(month=>month.month), ['2019-01','2024-02']);
});

test('sparse Kworb snapshots cannot become a stale first-listen baseline', () => {
  const result = normalizeHistoryDocuments([[event('aaa','One','Artist','2024-03-15T00:00:00Z')]]);
  const current = { artist:'Artist',date:'2026-01-01',listeners:2000,source:'Kworb',metric:'monthly_listeners' };
  const stale = { ...current,date:'2024-01-01',listeners:100 };
  assert.equal(analyzeHistory(result,{growth:[stale,current]}).items[0].growthScore,null);
  const recent = { ...stale,date:'2024-03-01' };
  assert.equal(analyzeHistory(result,{growth:[recent,current]}).items[0].growthScore,20);
});

test('full audio metadata survives history aggregation while local audio paths are rejected', () => {
  const result = normalizeHistoryDocuments([[event('aaa','Original name','Artist','2024-01-01T00:00:00Z')]]);
  const audio = { audioUrl:'https://api.audius.co/v1/tracks/abc/stream',audioKind:'full',audioSource:'Audius',audioExternalUrl:'https://audius.co/artist/original',audioDurationMs:210000,previewUrl:'https://cdnt-preview.dzcdn.net/preview.mp3',name:'Wrong catalog title' };
  const track = analyzeHistory(result,{metadata:{aaa:audio}}).items[0];
  assert.equal(track.name,'Original name');
  assert.equal(track.audioUrl,audio.audioUrl);
  assert.equal(track.audioKind,'full');
  assert.equal(track.audioDurationMs,210000);
  assert.equal(track.audioSource,'Audius');
  assert.equal(track.previewUrl,audio.previewUrl);
  assert.equal(analyzeHistory(result,{metadata:{aaa:{...audio,audioUrl:'/api/audio/aaa'}}}).items[0].audioUrl,null);
});
