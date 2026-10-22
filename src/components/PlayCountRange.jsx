import React, { useRef } from 'react';
import { number } from '../ui.jsx';
import { useI18n } from '../lib/i18n-react.jsx';

export default function PlayCountRange({ min = '', max = '', maximum = 1, onChange }) {
  const {t}=useI18n();
  const limit = Math.max(1, Math.ceil(Number(maximum) || 1), Number(min) || 0, Number(max) || 0);
  const lower = Math.max(0, Math.min(limit, Number(min) || 0));
  const upper = max === '' ? limit : Math.max(lower, Math.min(limit, Number(max) || 0));
  const lowerInput = useRef(null), upperInput = useRef(null), dragging = useRef(null);
  function update(which, value) {
    const next = Math.max(0, Math.min(limit, Math.round(value)));
    if (which === 'min') onChange({ min: Math.min(next, upper) || '', max });
    else onChange({ min, max: Math.max(next, lower) === limit ? '' : Math.max(next, lower) });
  }
  function atPointer(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(limit, (event.clientX - bounds.left - 10) / Math.max(1, bounds.width - 20) * limit));
  }
  function pointerDown(event) {
    if (event.target.tagName === 'INPUT' && lower !== upper) return;
    event.preventDefault();
    if (lower === upper && event.target.tagName === 'INPUT') {
      dragging.current = 'overlap';
      (lower === limit ? lowerInput : upperInput).current?.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const value = atPointer(event);
    const which = Math.abs(value - lower) < Math.abs(value - upper) ? 'min' : value < lower ? 'min' : 'max';
    dragging.current = which;
    (which === 'min' ? lowerInput : upperInput).current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    update(which, value);
  }
  function pointerMove(event) {
    if (!dragging.current) return;
    const value = atPointer(event);
    if (dragging.current === 'overlap') {
      if (Math.round(value) === lower) return;
      dragging.current = value < lower ? 'min' : 'max';
      (dragging.current === 'min' ? lowerInput : upperInput).current?.focus();
    }
    update(dragging.current, value);
  }
  return <div className="play-count-range">
    <div className="play-count-range-values" aria-live="polite"><output htmlFor="play-count-min">{t('От')} <strong>{number(lower)}</strong></output><output htmlFor="play-count-max">{t('До')} <strong>{number(upper)}</strong></output></div>
    <div className="play-count-slider" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}>
      <div className="play-count-rail"><span style={{ left: `${lower / limit * 100}%`, right: `${100 - upper / limit * 100}%` }}/></div>
      <input ref={lowerInput} id="play-count-min" className="play-count-thumb play-count-thumb-min" type="range" min="0" max={limit} step="1" value={lower} aria-label={t('Минимум прослушиваний')} aria-valuemax={upper} aria-valuetext={number(lower)} onChange={event => update('min', Number(event.target.value))}/>
      <input ref={upperInput} id="play-count-max" className="play-count-thumb play-count-thumb-max" type="range" min="0" max={limit} step="1" value={upper} aria-label={t('Максимум прослушиваний')} aria-valuemin={lower} aria-valuetext={number(upper)} onChange={event => update('max', Number(event.target.value))}/>
    </div>
    <div className="play-count-range-scale" aria-hidden="true"><span>0</span><span>{number(limit)}</span></div>
  </div>;
}
