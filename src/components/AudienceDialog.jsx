import React, { useEffect } from 'react';
import { LoaderCircle, Info, ArrowUpRight, RefreshCw, Check } from 'lucide-react';
import { Modal, date, number } from '../ui.jsx';
import { audienceStatusText } from '../lib/audience-status.js';
import { useI18n } from '../lib/i18n-react.jsx';
import { translateError } from '../lib/i18n.js';
import AudienceGrowthChart from './AudienceGrowthChart.jsx';

export default function AudienceDialog({artist,history,growth,onClose}){
  const {t}=useI18n();
  useEffect(()=>{if(artist)history.request([artist],{priority:true});},[artist?.name,artist?.firstPlayed,history.request]);
  const selected=artist?history.getCoverage(artist):null;
  const libraryRecords=history.libraryTargets.map(target=>history.getCoverage(target)).filter(Boolean);
  const records=artist?selected?[selected]:[]:libraryRecords.sort((a,b)=>(b.hasBaseline?1:0)-(a.hasBaseline?1:0)||(b.count||0)-(a.count||0));
  const found=libraryRecords.filter(record=>record.count>1).length;
  const unavailable=libraryRecords.filter(record=>record.status==='not_tracked').length;
  const pending=artist?!selected:history.running||history.queued>0;
  return <Modal title={artist?t('Слушатели {name}',{name:artist.name}):t('История слушателей')} onClose={onClose}>
    <div className="provider-card"><div><strong>Kworb + Internet Archive</strong><span>{t('Бесплатно')}</span></div><p>{t('История проверяется автоматически после загрузки архива. Вводить значения вручную не требуется.')}</p><a className="text-button" href="https://kworb.net/spotify/listeners.html" target="_blank" rel="noreferrer">{t('Открыть источник')}<ArrowUpRight size={14}/></a></div>
    <div className="audience-progress" role="status">{pending?<LoaderCircle className="spin" size={18}/>:<Check size={18}/>}<div><strong>{artist?(pending?t('Проверяем доступные снимки…'):audienceStatusText(selected)):t('Проверено {checked} из {total}',{checked:number(history.checked),total:number(history.total)})}</strong>{!artist&&<span>{t('История найдена: {found} · Нет в таблицах: {unavailable}',{found:number(found),unavailable:number(unavailable)})}</span>}{history.retryAt>0&&<span>{t('Источник ограничил запросы или недоступен. Проверка продолжится автоматически.')}</span>}</div></div>
    <p className="modal-intro">{t('Восстанавливаются только реальные архивные снимки. Для коэффициента нужен снимок до первого прослушивания, сделанный не более чем за 31 день до него. У части исполнителей таких данных в бесплатных источниках нет.')}</p>
    {history.error&&<div className="note" role="status"><Info size={18}/><span>{translateError(history.error)}</span></div>}
    {artist&&<AudienceGrowthChart records={growth} artist={artist.name} firstPlayed={artist.firstPlayed} source={artist.growthSource} coverage={selected}/>}
    {records.length>0&&<div className="audience-coverage">{records.slice(0,40).map(item=><div key={item.key}><strong>{item.artist}</strong>{item.count>0&&<span>{t('{from} — {to} · {count} снимков',{from:date(item.from),to:date(item.to),count:number(item.count)})}</span>}<small>{audienceStatusText(item)}</small></div>)}</div>}
    {artist&&selected?.retryable&&!pending&&<button className="text-button" onClick={()=>history.request([artist],{priority:true,force:true})}><RefreshCw size={15}/>{t('Повторить сейчас')}</button>}
  </Modal>;
}
