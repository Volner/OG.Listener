import assert from 'node:assert/strict';
import test from 'node:test';
import { audienceSeries, audienceCoordinates, audienceGrowthRatio } from '../src/lib/audience-series.js';

const now = Date.parse('2026-10-21T12:00:00Z');
const point = (date, listeners, source = 'Kworb', extra = {}) => ({ artist: 'AC/DC', date, listeners, source, metric: 'monthly_listeners', ...extra });
const series = (records, options = {}) => audienceSeries(records, { artist: 'AC/DC', firstPlayed: '2020-01-01', ...options }, now);

test('series contains one provider and Spotify monthly-listener metric only', () => {
  const records = [
    point('2024-01-01', 100), point('2025-01-01', 200),
    point('2025-06-01', 500, 'Chartmetric'),
    point('2026-01-01', 900, 'Last.fm'),
    point('2026-01-01', 901, 'Kworb', { metric: 'followers' }),
    point('2026-01-01', 902, 'Kworb', { metric: 'streams' }),
  ];
  const result = series(records);
  assert.equal(result.source, 'Kworb');
  assert.deepEqual(result.points.map(item => item.listeners), [100, 200]);
  assert.equal(series(records, { growthSource: 'Chartmetric' }).source, 'Chartmetric');
  assert.equal(series(records, { source: 'missing' }).source, 'Kworb');
  assert.equal(series(records, { metric: 'followers' }).points.length, 0);
});

test('a first-heard marker before available history expands the domain without an invented baseline', () => {
  const result = series([point('2024-01-01', 100), point('2025-01-01', 200)]);
  assert.equal(result.firstTime, Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(result.domain[0], result.firstTime);
  assert.equal(result.baseline, undefined);
  assert.equal(result.current.listeners, 200);
  assert.deepEqual(result.points.map(item => item.date), ['2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z']);
  const layout = audienceCoordinates(result);
  assert.equal(layout.firstX, layout.plot.left);
  assert.ok(layout.points[0].x > layout.firstX);
});

test('duplicate observations are corrected, calendar/future/invalid values rejected, and zero kept', () => {
  const result = series([
    point('2024-01-01', 100), point('2024-01-01T00:00:00Z', 120),
    point('2025-01-01', 0), point('2024-02-31', 500),
    point('2027-01-01', 999), point('invalid', 200),
    point('2025-02-01', null), point('2025-02-01', ''), point('2025-02-01', false),
    point('2025-02-01', Infinity), point('2025-02-01', -1),
  ], { firstPlayed: '2024-06-01' });
  assert.deepEqual(result.points.map(item => item.listeners), [120, 0]);
  assert.equal(result.baseline.listeners, 120);
  assert.equal(result.current.listeners, 0);
  assert.equal(result.points[0].time, Date.parse('2024-01-01T00:00:00Z'));
});

test('artist matching ignores Unicode casing and spaces while preserving punctuation identity', () => {
  const records = [point('2024-01-01', 10, 'Kworb', { artist: '  ａｃ/ｄｃ  ' }), point('2025-01-01', 50, 'Kworb', { artist: 'ACDC' })];
  assert.equal(series(records).points.length, 1);
  assert.equal(series(records).points[0].listeners, 10);
});

test('fallback chooses the latest provider, then richer history without joining observations', () => {
  const records = [
    point('2023-01-01', 1, 'Older'), point('2024-01-01', 2, 'Older'),
    point('2025-01-01', 4, 'Newer'), point('2024-01-01', 3, 'Richer'), point('2025-01-01', 5, 'Richer'),
  ];
  const result = series(records);
  assert.equal(result.source, 'Richer');
  assert.deepEqual(result.points.map(item => item.listeners), [3, 5]);
});

test('a single observation stays a single observation with finite geometry and no manufactured line', () => {
  const result = series([point('2024-01-01', 0)], { firstPlayed: '2024-01-01' });
  const layout = audienceCoordinates(result);
  assert.equal(layout.points.length, 1);
  assert.ok(result.domain[0] < result.points[0].time && result.domain[1] > result.points[0].time);
  assert.equal(layout.points[0].x, layout.plot.left + layout.plot.width / 2);
  assert.equal(layout.points[0].y, layout.plot.top + layout.plot.height);
  assert.ok(Number.isFinite(layout.firstX));
  assert.deepEqual(layout.yDomain, [0, 1]);
});

test('empty data and an invalid first date produce safe domains without source or marker', () => {
  const result = series([], { firstPlayed: '2020-02-31' });
  const layout = audienceCoordinates(result);
  assert.equal(result.source, null);
  assert.equal(result.firstTime, null);
  assert.equal(result.current, undefined);
  assert.equal(layout.firstX, null);
  assert.deepEqual(layout.points, []);
  assert.ok(result.domain[0] < result.domain[1]);
});

test('growth ratio follows the chosen monthly series and permits a decline to zero', () => {
  const result = series([point('2024-01-01', 100), point('2025-01-01', 250)], { firstPlayed: '2024-01-10' });
  assert.equal(audienceGrowthRatio(result), 2.5);
  assert.equal(audienceGrowthRatio(series([point('2024-01-01', 100), point('2025-01-01', 0)], { firstPlayed: '2024-01-10' })), 0);
  assert.equal(audienceGrowthRatio({ ...result, metric: 'followers' }), null);
});

test('growth ratio rejects a stale Kworb baseline and unsupported first-heard positions', () => {
  const records = [point('2024-01-01', 100), point('2025-01-01', 250)];
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2024-02-02' })), null);
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2024-02-01' })), 2.5);
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2023-12-31' })), null);
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2025-01-02' })), null);
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2025-01-01' })), null);
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: 'invalid' })), null);
});

test('growth ratio does not divide by a zero baseline or use another provider baseline', () => {
  assert.equal(audienceGrowthRatio(series([point('2024-01-01', 0), point('2025-01-01', 100)], { firstPlayed: '2024-01-10' })), null);
  const records = [point('2024-01-01', 100, 'Other'), point('2025-01-01', 300)];
  assert.equal(audienceGrowthRatio(series(records, { firstPlayed: '2024-01-10' })), null);
});
