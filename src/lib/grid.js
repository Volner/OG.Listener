/**
 * Lay out the complete ranking before paginating it. Each row uses one cover
 * size, so appending a page never repacks covers that are already on screen.
 * The square-root scale represents plays by area, with a readable size floor.
 */
export function layoutMosaicRows(entries, width, maximum) {
  if (!entries.length || !Number.isFinite(width) || width <= 0) return [];
  const compact = width < 640;
  const gap = compact ? 8 : 12;
  const minimumSize = Math.min(width, compact ? 128 : 176);
  const maximumSize = Math.min(width, compact ? 240 : 310);
  const maximumColumns = Math.max(1, Math.floor((width + gap) / (minimumSize + gap)));
  const minimumColumns = Math.min(maximumColumns, Math.max(1, Math.ceil((width + gap) / (maximumSize + gap))));
  const scale = Number.isFinite(maximum) && maximum > 0
    ? maximum
    : entries.reduce((largest, entry) => Math.max(largest, Number(entry.value) || 0), 0);
  const rows = [];
  for (let start = 0; start < entries.length;) {
    const value = Number(entries[start].value);
    const desiredSize = Number.isFinite(value) && value > 0 && scale > 0
      ? Math.max(minimumSize, maximumSize * Math.sqrt(value / scale))
      : minimumSize;
    const columns = Math.max(minimumColumns, Math.min(maximumColumns, Math.round((width + gap) / (desiredSize + gap))));
    const size = (width - gap * (columns - 1)) / columns;
    const rowEntries = entries.slice(start, start + columns);
    rows.push({ start, columns, gap, size, entries: rowEntries });
    start += rowEntries.length;
  }
  return rows;
}
