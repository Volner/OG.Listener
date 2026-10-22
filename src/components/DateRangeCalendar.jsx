import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '../lib/i18n-react.jsx';
import {
  calendarBounds, calendarDate, calendarKeyDate, calendarMonth, calendarMonthAvailable,
  calendarMonthDays, clampCalendarDate, parseCalendarDate, selectCalendarRange, shiftCalendarMonth,
} from '../lib/date-range.js';
import './date-range-calendar.css';

const navigationKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export default function DateRangeCalendar({ value = { from: '', to: '' }, onChange, minDate, maxDate }) {
  const {t,locale}=useI18n();
  const {months,weekdays,weekdayNames,fullDate,shortDate,monthHeading}=useMemo(()=>{
    const title=value=>value.charAt(0).toLocaleUpperCase(locale)+value.slice(1);
    const monthFormat=new Intl.DateTimeFormat(locale,{month:'long',timeZone:'UTC'});
    const weekdayFormat=new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'});
    const weekdayNameFormat=new Intl.DateTimeFormat(locale,{weekday:'long',timeZone:'UTC'});
    return {
      months:Array.from({length:12},(_,month)=>title(monthFormat.format(new Date(Date.UTC(2020,month,1))))),
      weekdays:Array.from({length:7},(_,day)=>title(weekdayFormat.format(new Date(Date.UTC(2020,0,6+day))))),
      weekdayNames:Array.from({length:7},(_,day)=>title(weekdayNameFormat.format(new Date(Date.UTC(2020,0,6+day))))),
      fullDate:new Intl.DateTimeFormat(locale,{day:'numeric',month:'long',year:'numeric',weekday:'long',timeZone:'UTC'}),
      shortDate:new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}),
      monthHeading:new Intl.DateTimeFormat(locale,{month:'long',year:'numeric',timeZone:'UTC'}),
    };
  },[locale]);
  const grid = useRef(null);
  const instructionId = useId();
  const { min, max } = useMemo(() => calendarBounds(minDate, maxDate), [minDate, maxDate]);
  const today = calendarDate(new Date());
  const from = parseCalendarDate(value.from) ? value.from : '';
  const to = parseCalendarDate(value.to) ? value.to : '';
  const initial = clampCalendarDate(from || to || today, min, max);
  const [visibleMonth, setVisibleMonth] = useState(() => calendarMonth(initial));
  const [focusedDay, setFocusedDay] = useState(initial);
  const [hoverDay, setHoverDay] = useState('');
  const choosingEnd = Boolean(from && !to);
  const selectedStart = from && to ? (from < to ? from : to) : from;
  const selectedEnd = from && to ? (from > to ? from : to) : to;
  const preview = choosingEnd && hoverDay ? selectCalendarRange({ from, to: '' }, hoverDay) : null;
  const days = useMemo(() => calendarMonthDays(visibleMonth), [visibleMonth]);
  const year = Number(visibleMonth.slice(0, 4));
  const monthIndex = Number(visibleMonth.slice(5, 7)) - 1;
  const firstYear = min ? Number(min.slice(0, 4)) : Math.min(2006, year);
  const lastYear = max ? Number(max.slice(0, 4)) : Math.max(new Date().getUTCFullYear(), year);
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  const previous = shiftCalendarMonth(visibleMonth, -1);
  const next = shiftCalendarMonth(visibleMonth, 1);
  const tabDay = days.includes(focusedDay) && clampCalendarDate(focusedDay, min, max) === focusedDay ? focusedDay : days.find(day => day && clampCalendarDate(day, min, max) === day && calendarMonth(day) === visibleMonth);

  useEffect(() => {
    const candidate = clampCalendarDate(focusedDay, min, max);
    if (candidate && candidate !== focusedDay) setFocusedDay(candidate);
    if (!calendarMonthAvailable(visibleMonth, min, max) && candidate) setVisibleMonth(calendarMonth(candidate));
  }, [min, max, focusedDay, visibleMonth]);

  function showMonth(candidate) {
    if (!candidate || !calendarMonthAvailable(candidate, min, max)) return;
    const difference = (Number(candidate.slice(0, 4)) - year) * 12 + Number(candidate.slice(5, 7)) - monthIndex - 1;
    const nextFocus = clampCalendarDate(shiftCalendarMonth(focusedDay, difference), min, max);
    setVisibleMonth(calendarMonth(candidate));
    setFocusedDay(nextFocus || clampCalendarDate(candidate, min, max));
    setHoverDay('');
  }

  function focusDate(day) {
    const target = clampCalendarDate(day, min, max);
    if (!target) return;
    setFocusedDay(target);
    setVisibleMonth(calendarMonth(target));
    requestAnimationFrame(() => grid.current?.querySelector(`[data-date="${target}"]`)?.focus());
  }

  function chooseDate(day) {
    onChange?.(selectCalendarRange({ from, to }, day));
    setHoverDay('');
    focusDate(day);
  }

  function onDayKey(event, day) {
    if (!navigationKeys.has(event.key)) return;
    event.preventDefault();
    focusDate(calendarKeyDate(day, event.key));
  }

  const instruction = choosingEnd ? t('Теперь выберите конец периода') : from && to ? t('Выберите дату для нового периода') : t('Выберите начало периода');

  return <section className="date-range-calendar" aria-label={t('Календарь периода прослушиваний')}>
    <div className="date-range-calendar-summary" aria-live="polite">
      <span><small>{t('С')}</small><strong>{from ? shortDate.format(parseCalendarDate(from)) : t('Начало')}</strong></span>
      <span className="date-range-calendar-separator" aria-hidden="true">—</span>
      <span><small>{t('По')}</small><strong>{to ? shortDate.format(parseCalendarDate(to)) : t('Конец')}</strong></span>
    </div>
    <div className="date-range-calendar-toolbar">
      <button type="button" className="date-range-calendar-nav" aria-label={t('Предыдущий месяц')} disabled={!calendarMonthAvailable(previous, min, max)} onClick={() => showMonth(previous)}><ChevronLeft size={17} aria-hidden="true"/></button>
      <div className="date-range-calendar-month-year">
        <select aria-label={t('Месяц')} value={monthIndex} onChange={event => showMonth(`${year}-${String(Number(event.target.value) + 1).padStart(2, '0')}-01`)}>{months.map((month, index) => <option key={month} value={index} disabled={!calendarMonthAvailable(`${year}-${String(index + 1).padStart(2, '0')}-01`, min, max)}>{month}</option>)}</select>
        <select aria-label={t('Год')} value={year} onChange={event => {
          const candidate = `${event.target.value}-${String(monthIndex + 1).padStart(2, '0')}-01`;
          showMonth(calendarMonth(clampCalendarDate(candidate, min, max)));
        }}>{years.map(option => <option key={option} value={option}>{option}</option>)}</select>
      </div>
      <button type="button" className="date-range-calendar-nav" aria-label={t('Следующий месяц')} disabled={!calendarMonthAvailable(next, min, max)} onClick={() => showMonth(next)}><ChevronRight size={17} aria-hidden="true"/></button>
    </div>
    <div ref={grid} className="date-range-calendar-grid" role="grid" aria-label={monthHeading.format(parseCalendarDate(visibleMonth))} aria-describedby={instructionId} onPointerLeave={() => setHoverDay('')}>
      <div className="date-range-calendar-weekdays" role="row">{weekdays.map((weekday, index) => <span role="columnheader" aria-label={weekdayNames[index]} key={weekday}>{weekday}</span>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div className="date-range-calendar-week" role="row" key={week}>{days.slice(week * 7, week * 7 + 7).map((day, index) => {
        const allowed = Boolean(day && clampCalendarDate(day, min, max) === day);
        const isStart = day === selectedStart;
        const isEnd = day === selectedEnd;
        const inRange = Boolean(selectedStart && selectedEnd && day >= selectedStart && day <= selectedEnd);
        const inPreview = Boolean(preview && day >= preview.from && day <= preview.to);
        const classes = [calendarMonth(day) !== visibleMonth && 'is-outside-month', day === today && 'is-today', isStart && 'is-range-start', isEnd && 'is-range-end', inRange && 'is-in-range', inPreview && 'is-preview'].filter(Boolean).join(' ');
        return <div role="gridcell" className={`date-range-calendar-cell ${classes}`} aria-selected={Boolean(isStart || isEnd || inRange)} key={day || `empty-${index}`}><button
          type="button" className="date-range-calendar-day" data-date={day} disabled={!allowed} tabIndex={allowed && day === tabDay ? 0 : -1}
          aria-label={day ? isStart&&isEnd?t('{date}, начало и конец периода',{date:fullDate.format(parseCalendarDate(day))}):isStart?t('{date}, начало периода',{date:fullDate.format(parseCalendarDate(day))}):isEnd?t('{date}, конец периода',{date:fullDate.format(parseCalendarDate(day))}):fullDate.format(parseCalendarDate(day)) : t('Недоступная дата')}
          aria-pressed={Boolean(isStart || isEnd || inRange)} aria-current={day === today ? 'date' : undefined}
          onFocus={() => setFocusedDay(day)} onKeyDown={event => onDayKey(event, day)} onClick={() => chooseDate(day)}
          onPointerEnter={event => { if (choosingEnd && allowed && event.pointerType !== 'touch') setHoverDay(day); }}
        ><span>{day ? Number(day.slice(-2)) : ''}</span></button></div>;
      })}</div>)}
    </div>
    <div className="date-range-calendar-footer"><p id={instructionId} aria-live="polite">{instruction}</p><button type="button" onClick={() => { onChange?.({ from: '', to: '' }); setHoverDay(''); }}>{t('Весь период')}</button></div>
  </section>;
}
