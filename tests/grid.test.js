import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutMosaicRows } from '../src/lib/grid.js';

const entries = Array.from({ length: 36000 }, (_, index) => ({ item: { id: `track-${index}` }, value: Math.max(1, 12000 - index * 9), rank: index + 4 }));

test('cover rows preserve all 36,000 ranks and shared edges at every supported width', () => {
  for (const width of [288, 358, 608, 900, 1248, 1920]) {
    const rows = layoutMosaicRows(entries, width, entries[0].value);
    const minimum = width < 640 ? 128 : 176;
    assert.deepEqual(rows.flatMap(row => row.entries.map(entry => entry.item.id)), entries.map(entry => entry.item.id));
    for (const row of rows) {
      assert.ok(row.size >= minimum, `Readable covers at ${width}px`);
      assert.ok(Math.abs(row.columns * row.size + (row.columns - 1) * row.gap - width) < 0.001, 'Every row shares the container edges');
      assert.ok(row.entries.length <= row.columns);
    }
    assert.equal(rows.at(-1).size, rows.at(-2).size, 'The long tail stops shrinking');
  }
});

test('loading the next page leaves the preceding complete rows in place', () => {
  const rows = layoutMosaicRows(entries, 1248, entries[0].value);
  const firstPage = rows.filter(row => row.start < 60);
  const secondPage = rows.filter(row => row.start < 120);
  assert.deepEqual(secondPage.slice(0, firstPage.length), firstPage);
  const earlier = layoutMosaicRows(entries.slice(0, 70), 1248, entries[0].value);
  assert.deepEqual(rows.slice(0, earlier.length - 1), earlier.slice(0, -1));
});

test('cover size changes by weight while unknown audience stays neutral and readable', () => {
  const values = [10000, 5000, 1000, 100, 10, 1];
  const weighted = values.flatMap(value => Array.from({ length: 12 }, () => ({ value })));
  const rows = layoutMosaicRows(weighted, 1248, 10000);
  assert.ok(rows[0].size > rows.at(-1).size);
  assert.ok(rows.every((row, index) => index === 0 || row.size <= rows[index - 1].size));
  const unknown = layoutMosaicRows(Array.from({ length: 120 }, () => ({ value: null })), 1248, 0);
  assert.ok(unknown.every(row => row.size === unknown[0].size && row.size >= 176));
  assert.deepEqual(layoutMosaicRows([], 1248, 0), []);
});
