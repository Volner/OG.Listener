import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Music2, Play } from 'lucide-react';
import { layoutMosaicRows } from '../lib/grid.js';
import { useI18n } from '../lib/i18n-react.jsx';
import './mosaic.css';

const BATCH_SIZE = 60;
const EMPTY_ITEMS = [];
const EMPTY_IDS = [];

function usePanelWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = nextWidth => {
      if (nextWidth > 0) setWidth(previous => Math.abs(previous - nextWidth) < 0.1 ? previous : nextWidth);
    };
    measure(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function remoteArtwork(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function Artwork({ item, rank }) {
  const { t } = useI18n();
  const source = remoteArtwork(item.artwork);
  const [failedSource, setFailedSource] = useState(null);
  if (source && failedSource !== source) {
    return <img className="mosaic-artwork" src={source} alt="" loading={rank < 8 ? 'eager' : 'lazy'} decoding="async" onError={() => setFailedSource(source)} />;
  }
  const initials = (item.artist || item.name || t('Музыка')).split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return (
    <div className="mosaic-fallback" aria-hidden="true">
      <Music2 size={32} strokeWidth={1.3} />
      <span>{initials}</span>
    </div>
  );
}

export default function Mosaic({
  items = EMPTY_ITEMS, mode = 'plays', onSelect, onPlay, onImportGrowth, entity = 'tracks',
  excludeIds = EMPTY_IDS, rankOffset = 0, onVisibleItems,
}) {
  const { t, locale } = useI18n();
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const ratio = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }), [locale]);
  const panel = useRef(null);
  const sentinel = useRef(null);
  const width = usePanelWidth(panel);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const growth = mode === 'growth';
  const entries = useMemo(() => {
    const excluded = new Set(excludeIds);
    const seen = new Set();
    return items
      .filter(item => {
        const key = item.id || `${item.artist || ''}\u0000${item.name}`;
        if (excluded.has(item.id) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item, index) => {
        const rawValue = growth ? item.growthScore : item.plays;
        const value = rawValue == null ? null : Number(rawValue);
        return { item, index, value: Number.isFinite(value) && value >= 0 ? value : null };
      })
      .sort((left, right) => (right.value ?? -1) - (left.value ?? -1) || Number(right.item.plays || 0) - Number(left.item.plays || 0) || left.index - right.index)
      .map((entry, index) => ({ ...entry, rank: rankOffset + index + 1 }));
  }, [items, growth, excludeIds, rankOffset]);

  // URL, genre and audience updates must not collapse an already loaded library.
  const selectionKey = useMemo(() => `${mode}:${entity}:${entries.map(entry => entry.item.id || `${entry.item.artist}\u0000${entry.item.name}`).sort().join('\u0001')}`, [mode, entity, entries]);
  useEffect(() => setVisibleCount(BATCH_SIZE), [selectionKey]);
  const maximum = entries[0]?.value || 0;
  const rows = useMemo(() => layoutMosaicRows(entries, width, maximum), [entries, width, maximum]);
  // Finish a row at each page boundary, so the next page cannot resize that row.
  const visibleRows = useMemo(() => rows.filter(row => row.start < visibleCount), [rows, visibleCount]);
  const shown = visibleRows.reduce((count, row) => count + row.entries.length, 0);
  const hasMore = shown < entries.length;
  const visibleItems = useMemo(() => visibleRows.flatMap(row => row.entries.map(entry => entry.item)), [visibleRows]);
  const visibleKey = visibleItems.map(item => item.id || `${item.artist}\u0000${item.name}`).join('\u0001');
  const visibleRef = useRef(visibleItems);
  const onVisibleRef = useRef(onVisibleItems);
  visibleRef.current = visibleItems;
  onVisibleRef.current = onVisibleItems;

  useEffect(() => {
    if (!hasMore || !sentinel.current || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisibleCount(count => Math.min(count + BATCH_SIZE, entries.length));
    }, { rootMargin: '600px 0px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasMore, shown, entries.length]);

  // Only changed displayed IDs queue metadata, never the arrival of metadata.
  useEffect(() => {
    if (visibleRef.current.length) onVisibleRef.current?.(visibleRef.current);
  }, [visibleKey]);

  return (
    <div ref={panel} className={`listening-mosaic${entries.length ? '' : ' listening-mosaic-is-empty'}`} aria-label={growth ? t('Карта ранних открытий') : t('Карта прослушиваний')}>
      {!entries.length && (
        <div className="mosaic-empty">
          <ChartNoAxesCombined size={30} strokeWidth={1.3} aria-hidden="true" />
          <h3>{t('Ничего не найдено')}</h3>
          <p>{t('Измените фильтры или поисковый запрос.')}</p>
        </div>
      )}
      {growth && entries.length > 0 && !entries.some(entry => entry.value !== null) && (
        <div className="mosaic-growth-notice">
          <div><strong>{t('Исторических снимков пока нет')}</strong><p>{t('Источники проверяются автоматически. Если подходящего снимка нет, коэффициент остаётся неизвестным.')}</p></div>
          {onImportGrowth && <button className="mosaic-import-growth" type="button" onClick={onImportGrowth}><ChartNoAxesCombined size={15} /> {t('Покрытие источников')}</button>}
        </div>
      )}
      {visibleRows.map(row => (
        <div className="mosaic-row" key={row.entries[0].item.id || row.start} style={{ '--mosaic-columns': row.columns, '--mosaic-gap': `${row.gap}px`, '--mosaic-row-height': `${row.size}px` }}>
          {row.entries.map(({ item, rank, value }) => {
            const known = value !== null;
            const metric = growth ? known ? `${ratio.format(value)}×` : t('Нет данных') : number.format(value || 0);
            const artist = entity === 'artists' ? '' : item.artist;
            const title = `${item.name}${artist ? ` — ${artist}` : ''}`;
            const description = `${title}, ${growth ? known ? t('рост аудитории {metric}', { metric }) : t('нет данных об аудитории') : t('{count} прослушиваний', { count: metric })}`;
            return (
              <article key={item.id || `${item.name}-${rank}`} className={`mosaic-tile${row.size >= 240 ? ' mosaic-tile-large' : ''}`}>
                <Artwork item={item} rank={rank} />
                <button className="mosaic-select" type="button" aria-label={t('Место {rank}. Подробнее: {description}', { rank: number.format(rank), description })} title={description} onClick={() => onSelect?.(item)} />
                <span className="mosaic-rank" aria-hidden="true">#{number.format(rank)}</span>
                <div className="mosaic-label">
                  <h3>{item.name}</h3>
                  <div className="mosaic-details">
                    {artist && <p>{artist}</p>}
                    <span className="mosaic-metric">{growth && known && <ArrowUpRight size={14} />}<strong>{metric}</strong><span>{growth ? known ? t('рост аудитории') : '' : t('прослушиваний', { count: value || 0 })}</span></span>
                  </div>
                </div>
                {entity === 'tracks' && onPlay && (
                  <button className="mosaic-play" type="button" aria-label={t('Слушать: {name}', { name: title })} onClick={() => onPlay(item)}><Play size={18} fill="currentColor" strokeWidth={1.5} /></button>
                )}
              </article>
            );
          })}
        </div>
      ))}
      {hasMore && (
        <div className="mosaic-load-more" ref={sentinel}>
          <span aria-live="polite">{t('Показано {shown} из {total}', { shown: number.format(shown), total: number.format(entries.length) })}</span>
          <button type="button" onClick={() => setVisibleCount(count => Math.min(count + BATCH_SIZE, entries.length))}>{t('Показать ещё')}</button>
        </div>
      )}
    </div>
  );
}
