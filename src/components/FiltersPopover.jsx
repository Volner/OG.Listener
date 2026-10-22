import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, SlidersHorizontal } from 'lucide-react';
import { genreLabel } from '../ui.jsx';
import { useI18n } from '../lib/i18n-react.jsx';
import DateRangeCalendar from './DateRangeCalendar.jsx';
import PlayCountRange from './PlayCountRange.jsx';
import './filters-popover.css';

export const emptyFilters={genre:'all',dateFrom:'',dateTo:'',minPlays:'',maxPlays:'',minMs:1};
export function countFilters(filters){return Object.entries(filters).filter(([key,value])=>key==='genre'?value!=='all':key==='minMs'?Number(value)!==1:value!=='').length;}

export default function FiltersPopover({value,genres=[],genreCoverage,dateBounds={},playCountMax=1,onChange,onClose}) {
  const {t,locale}=useI18n();
  const numberFormat=useMemo(()=>new Intl.NumberFormat(locale),[locale]);
  const [draft,setDraft]=useState(()=>({...emptyFilters,...value}));
  const genreOptions=[...new Set([...genres,...(!['all','unknown'].includes(draft.genre)?[draft.genre]:[])])];
  const [error,setError]=useState('');
  const surface=useRef(null);
  useEffect(()=>{
    const before=document.activeElement;
    surface.current.querySelector('select,input,button')?.focus();
    const key=e=>{if(e.key==='Escape'){e.preventDefault();onClose();}};
    const outside=e=>{if(!surface.current?.contains(e.target)&&!e.target.closest('[data-filter-trigger]'))onClose();};
    document.addEventListener('keydown',key);document.addEventListener('pointerdown',outside);
    return()=>{document.removeEventListener('keydown',key);document.removeEventListener('pointerdown',outside);if(before?.isConnected)before.focus();};
  },[onClose]);
  function change(key,value){setDraft(previous=>({...previous,[key]:value}));setError('');}
  function apply(e){e.preventDefault();if(draft.dateFrom&&draft.dateTo&&draft.dateFrom>draft.dateTo){setError('date-order');return;}if(draft.minPlays!==''&&draft.maxPlays!==''&&Number(draft.minPlays)>Number(draft.maxPlays)){setError('play-order');return;}onChange(draft);onClose();}
  return <div className="filters-popover library-filters" role="dialog" aria-label={t('Фильтры библиотеки')} ref={surface}>
    <div className="popover-heading"><h2><SlidersHorizontal size={17}/>{t('Фильтры')}</h2><button className="icon-button" aria-label={t('Закрыть фильтры')} onClick={onClose}><X size={18}/></button></div>
    <form onSubmit={apply}>
      <div className="filters-columns">
      <fieldset className="filter-period"><legend>{t('Период прослушиваний')}</legend><DateRangeCalendar value={{from:draft.dateFrom,to:draft.dateTo}} minDate={dateBounds.min} maxDate={dateBounds.max} onChange={({from,to})=>setDraft(previous=>({...previous,dateFrom:from,dateTo:to}))}/></fieldset>
      <div className="filter-options">
      <div>
      <label className="field"><span>{t('Жанр')}</span><select aria-label={t('Жанр')} value={draft.genre} onChange={e=>change('genre',e.target.value)}><option value="all">{t('Все жанры')}</option>{genreOptions.map(genre=><option key={genre} value={genre}>{genreLabel(genre)}</option>)}<option value="unknown">{t('Жанр не определён')}</option></select></label>
      {genreCoverage&&<details className="genre-explanation"><summary>{t('Как определяются жанры · {known} из {total}',{known:numberFormat.format(genreCoverage.known),total:numberFormat.format(genreCoverage.total)})}</summary><p>{t('Жанры берутся из музыкальных каталогов: у альбома или исполнителя. Само звучание не анализируется. Сведения дополняются при просмотре карточек, поэтому фильтр пока охватывает только треки с известным жанром.')}</p><p>{t('Поджанры и синонимы не объединяются: Trap и Hip-Hop/Rap могут быть отдельными пунктами.')}</p></details>}
      </div>
      <label className="field"><span>{t('Считать прослушанным')}</span><select aria-label={t('Считать прослушанным')} value={draft.minMs} onChange={event=>change('minMs',Number(event.target.value))}><option value="1">{t('Любое ненулевое')}</option><option value="30000">{t('От 30 секунд')}</option><option value="60000">{t('От минуты')}</option></select><small className="field-help">{t('Первое знакомство определяется по всей истории.')}</small></label>
      <fieldset><legend>{t('Количество прослушиваний')}</legend><PlayCountRange min={draft.minPlays} max={draft.maxPlays} maximum={playCountMax} onChange={({min,max})=>setDraft(previous=>({...previous,minPlays:min,maxPlays:max}))}/></fieldset>
      </div>
      </div>
      {error&&<p className="inline-error" role="alert">{error==='date-order'?t('Начало периода должно быть не позже окончания.'):t('Минимум прослушиваний должен быть не больше максимума.')}</p>}
      <div className="filter-actions"><button type="button" className="text-button" onClick={()=>{setDraft({...emptyFilters});onChange({...emptyFilters});}}>{t('Сбросить')}</button><button className="button button-primary" type="submit">{t('Применить')}</button></div>
    </form>
  </div>;
}
