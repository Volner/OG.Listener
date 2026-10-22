import React, { useMemo, useRef, useState } from 'react';
import { number } from '../ui.jsx';
import { useI18n } from '../lib/i18n-react.jsx';

export default function ActivityChart({months=[]}) {
  const {t,locale}=useI18n();
  const plot=useRef(null);
  const [active,setActive]=useState(null);
  const timeline=useMemo(()=>{
    if(!months.length)return [];
    const lookup=new Map(months.map(month=>[month.month,month]));
    const cursor=new Date(`${months[0].month}-01T00:00:00Z`);
    const end=new Date(`${months.at(-1).month}-01T00:00:00Z`);
    const result=[];
    while(cursor<=end){const key=cursor.toISOString().slice(0,7);result.push(lookup.get(key)||{month:key,plays:0,msPlayed:0});cursor.setUTCMonth(cursor.getUTCMonth()+1);}
    return result;
  },[months]);
  const maximum=Math.max(...timeline.map(month=>month.plays),1);
  const index=active===null ? null : Math.min(active,timeline.length-1);
  const current=index===null ? null : timeline[index];
  const listeningTime=current ? current.msPlayed<3600000 ? t('{count} мин музыки',{count:number(current.msPlayed/60000)}) : t('{count} ч музыки',{count:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(current.msPlayed/3600000)}) : '';
  const monthTitle=key=>new Date(`${key}-01T00:00:00Z`).toLocaleDateString(locale,{month:'long',year:'numeric',timeZone:'UTC'});
  function point(e){const rect=plot.current.getBoundingClientRect();setActive(Math.max(0,Math.min(timeline.length-1,Math.floor((e.clientX-rect.left)/rect.width*timeline.length))));}
  function keyboard(e){if(!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key))return;e.preventDefault();if(e.key==='Escape'){setActive(null);return;}setActive(previous=>e.key==='Home'?0:e.key==='End'?timeline.length-1:Math.max(0,Math.min(timeline.length-1,(previous??timeline.length-1)+(e.key==='ArrowRight'?1:-1))));}
  return <div className="activity-chart">
    <div className="chart-y-axis"><span>{number(maximum)}</span><span>{number(maximum/2)}</span><span>0</span></div>
    <div className="chart-plot" ref={plot} role="group" tabIndex={0} aria-label={t('Прослушивания по месяцам. Стрелки влево и вправо выбирают месяц.')} onKeyDown={keyboard} onFocus={()=>setActive(previous=>previous??timeline.length-1)} onBlur={()=>setActive(null)} onPointerMove={point} onPointerDown={point} onPointerLeave={e=>{if(e.pointerType!=='touch')setActive(null);}}>
      <div className="chart-horizontal-lines" aria-hidden="true"><i/><i/><i/></div>
      <div className="chart-bars" style={{gap:timeline.length>60?'2px':'5px'}}>{timeline.map((month,i)=><div key={month.month} className={`chart-month ${index===i?'chart-month-active':''}`}><span className={`chart-bar ${i>=timeline.length-4?'recent':''}`} style={{height:`${month.plays?Math.max(month.plays/maximum*100,1):0}%`}}/></div>)}</div>
      {current&&<><span className="chart-crosshair" style={{left:`${(index+.5)/timeline.length*100}%`}}/><div className="chart-tooltip" role="status" style={{left:`clamp(8px, calc(${(index+.5)/timeline.length*100}% - 90px), calc(100% - 188px))`}}><strong>{monthTitle(current.month)}</strong><span><i/>{t('{count} прослушиваний',{count:number(current.plays)})}</span><small>{listeningTime}</small></div></>}
    </div>
    <div className="chart-labels"><span>{timeline[0]?.month.slice(0,4)}</span><span>{timeline[Math.floor(timeline.length/2)]?.month.slice(0,4)}</span><span>{timeline.at(-1)?.month.slice(0,4)}</span></div>
  </div>;
}
