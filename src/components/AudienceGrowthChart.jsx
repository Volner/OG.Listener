import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { date, number, ratio } from '../ui.jsx';
import { audienceSeries, audienceCoordinates, audienceGrowthRatio } from '../lib/audience-series.js';
import { audienceStatusText } from '../lib/audience-status.js';
import { useI18n } from '../lib/i18n-react.jsx';
import './audience-growth-chart.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function AudienceGrowthChart({ records = [], artist, firstPlayed, source, coverage }) {
  const { t, locale } = useI18n();
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }), [locale]);
  const axisDate = value => new Date(value).toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const container = useRef(null);
  const hitbox = useRef(null);
  const [width, setWidth] = useState(600);
  const [activeIndex, setActiveIndex] = useState(null);
  const uid = useId().replace(/[^a-z0-9_-]/gi, '');
  const lineId = `audience-line-${uid}`;
  const areaId = `audience-area-${uid}`;
  const titleId = `audience-title-${uid}`;
  const descriptionId = `audience-description-${uid}`;
  const tooltipId = `audience-tooltip-${uid}`;
  const height = width < 400 ? 230 : 260;
  const series = useMemo(() => audienceSeries(records, { artist, firstPlayed, growthSource: source }), [records, artist, firstPlayed, source]);
  const growthScore = audienceGrowthRatio(series);
  const sourceUrl = /^https?:\/\//.test(series.current?.sourceUrl || '') ? series.current.sourceUrl : null;
  const chart = useMemo(() => audienceCoordinates(series, {
    width, height, left: width < 400 ? 46 : 54, right: 14, top: 58, bottom: 32,
  }), [series, width, height]);
  const { points, plot } = chart;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const active = activeIndex === null ? null : points[activeIndex];
  const line = points.length > 1 ? points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ') : '';
  const area = line ? `${line} L${points.at(-1).x},${bottom} L${points[0].x},${bottom} Z` : '';
  const yTicks = [0, chart.yDomain[1] / 2, chart.yDomain[1]];
  const xTicks = width < 400 ? [series.domain[0], series.domain[1]] : [series.domain[0], (series.domain[0] + series.domain[1]) / 2, series.domain[1]];
  const firstLabelLeft = chart.firstX === null ? 0 : clamp(chart.firstX, plot.left, Math.max(plot.left, width - 146));
  const tooltipWidth = Math.min(188, width - 12);
  const tooltipLeft = active ? clamp(active.x - tooltipWidth / 2, 6, width - tooltipWidth - 6) : 6;
  const tooltipTop = active ? clamp(active.y - 86, 48, height - 114) : 48;

  useLayoutEffect(() => {
    const measure = () => {
      const next = container.current?.getBoundingClientRect().width;
      if (next > 0) setWidth(previous => Math.abs(previous - next) > 0.5 ? next : previous);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setActiveIndex(null), [series]);

  function selectAtPointer(event) {
    if (!points.length) return;
    const bounds = container.current.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    let nearest = 0;
    for (let index = 1; index < points.length; index++) {
      if (Math.abs(points[index].x - pointerX) < Math.abs(points[nearest].x - pointerX)) nearest = index;
    }
    setActiveIndex(nearest);
  }

  function handleKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex(null);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex(previous => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return points.length - 1;
      return clamp((previous ?? points.length - 1) + (event.key === 'ArrowRight' ? 1 : -1), 0, points.length - 1);
    });
  }

  return <section className="audience-growth-chart" aria-labelledby={titleId}>
    <div className="audience-chart-heading"><h3 id={titleId}>{t('Рост аудитории')}</h3>{growthScore != null && Number.isFinite(growthScore) && <strong className="audience-growth-ratio"><TrendingUp size={16}/>{ratio(growthScore)}×</strong>}</div>
    <div className="audience-chart-canvas" ref={container}>
      {points.length > 0 ? <>
        <svg className="audience-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
          <desc id={descriptionId}>{t('{artist}. {count} архивных снимков. От {from} до {to}.',{artist,count:number(points.length),from:date(points[0].date),to:date(points.at(-1).date)})}{series.firstTime !== null ? ` ${t('Первое прослушивание: {date}.',{date:date(firstPlayed)})}` : ''}</desc>
          <defs>
            <linearGradient id={lineId} gradientUnits="userSpaceOnUse" x1={plot.left} y1="0" x2={right} y2="0"><stop offset="0%" stopColor="#9181c7"/><stop offset="100%" stopColor="#dfcaff"/></linearGradient>
            <linearGradient id={areaId} gradientUnits="userSpaceOnUse" x1="0" y1={plot.top} x2="0" y2={bottom}><stop offset="0%" stopColor="#b7a8ed" stopOpacity=".32"/><stop offset="100%" stopColor="#b7a8ed" stopOpacity=".015"/></linearGradient>
          </defs>
          {yTicks.map(value => <g key={value} className="audience-chart-axis"><line x1={plot.left} x2={right} y1={chart.y(value)} y2={chart.y(value)}/><text x={plot.left - 9} y={chart.y(value) + 3.5} textAnchor="end">{compact.format(value)}</text></g>)}
          {xTicks.map((time, index) => <text key={time} className="audience-chart-date" x={chart.x(time)} y={height - 10} textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}>{axisDate(time)}</text>)}
          {area && <path className="audience-series-area" d={area} fill={`url(#${areaId})`}/>}
          {line && <path className="audience-series-line" d={line} fill="none" stroke={`url(#${lineId})`}/>}
          {chart.firstX !== null && <g className="audience-first-indicator"><line className="audience-first-marker" data-date={firstPlayed} x1={chart.firstX} x2={chart.firstX} y1={plot.top - 6} y2={bottom}/><circle cx={chart.firstX} cy={plot.top - 6} r="3"/></g>}
          {points.map(point => <circle className="audience-observation" key={point.time} data-date={point.date} cx={point.x} cy={point.y} r={points.length === 1 ? 4 : 3}/>) }
          {active && <g className="audience-active-point"><line x1={active.x} x2={active.x} y1={plot.top} y2={bottom}/><circle cx={active.x} cy={active.y} r="5"/></g>}
        </svg>
        {chart.firstX !== null && <div className="audience-first-label" style={{ left: firstLabelLeft }}><span>{t('Первое прослушивание')}</span><time dateTime={new Date(series.firstTime).toISOString()}>{date(firstPlayed)}</time></div>}
        <div className="audience-chart-hitbox" ref={hitbox} style={{ left: plot.left - 6, right: plot.right - 6, top: plot.top - 6, bottom: plot.bottom - 6 }} tabIndex={0} role="group" aria-label={t('График аудитории {artist}. Стрелки влево и вправо выбирают снимок; Home и End — первый и последний.',{artist})} aria-describedby={active ? tooltipId : undefined} onPointerMove={selectAtPointer} onPointerDown={selectAtPointer} onPointerLeave={event => { if (event.pointerType !== 'touch' && document.activeElement !== hitbox.current) setActiveIndex(null); }} onFocus={() => setActiveIndex(previous => previous ?? points.length - 1)} onBlur={() => setActiveIndex(null)} onKeyDown={handleKey}/>
        {active && <div id={tooltipId} className="audience-chart-tooltip" role="status" aria-live="polite" style={{ left: tooltipLeft, top: tooltipTop, width: tooltipWidth }}><time dateTime={active.date}>{date(active.date)}</time><strong>{number(active.listeners)} <span>{t('слушателей')}</span></strong><small>{active.source} · {t('архивный снимок')}</small></div>}
      </> : <div className="audience-chart-empty"><TrendingUp size={24} strokeWidth={1.4}/><p>{audienceStatusText(coverage)}</p></div>}
    </div>
    {points.length > 0 && (points.length === 1 || sourceUrl) && <div className="audience-chart-caption">{points.length === 1 && <span><i/>{t('Пока доступен один снимок.')}</span>}{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">{t('Источник ↗')}</a>}</div>}
    {points.length > 0 && growthScore == null && <p className="audience-chart-note">{audienceStatusText(coverage)}</p>}
  </section>;
}
