import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeHistory } from './history.js';
import { readLocal, writeLocal } from './storage.js';
import { apiUrl } from './api-url.js';

const DAY=86400000;
const normalized=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
const waitForRetry=(signal,delay)=>new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,delay);signal.addEventListener('abort',finish,{once:true});});
export function audienceTarget(item){
  if(!item)return null;
  const name=item.id?.startsWith('artist:')?item.name:item.artist||item.name;
  return name&&Number.isFinite(Date.parse(item.firstPlayed))?{name,firstPlayed:item.firstPlayed,artistId:item.artistId||undefined}:null;
}
export const audienceKey=item=>`${normalized(item?.name||item?.artist)}|${item?.firstPlayed||''}`;
export function freshAudienceRecord(record,now=Date.now()){
  if(!record?.checkedAt)return false;
  const ttl=record.retryable?Math.max(30000,Number(record.retryAfterSeconds||60)*1000):DAY;
  return now-Number(record.checkedAt)<ttl;
}

export function audienceRequestTarget(target,record){
  // The server verifies these page/capture identities against its CDX index.
  // Keeping the cursor in IndexedDB lets a new server instance resume the work.
  const archiveChecked=Array.isArray(record?.archiveChecked)?[...new Set(record.archiveChecked.slice(0,6).filter(key=>typeof key==='string'&&/^[01]:\d{14}$/.test(key)))]:[];
  return {...target,...(archiveChecked.length?{archiveChecked}:{})};
}

/** Coverage responses are incremental; observations never come from a cursor. */
export function mergeAudienceCoverage(previous,coverage,target,snapshots=[]){
  const observations=new Map();
  const add=point=>{
    const time=Date.parse(point?.date),listeners=point?.listeners;
    if(!Number.isFinite(time)||time>Date.now()||!Number.isSafeInteger(listeners)||listeners<0)return;
    observations.set(time,{date:new Date(time).toISOString(),listeners});
  };
  for(const point of previous?.observations||[])add(point);
  const artistId=coverage?.artistId||target.artistId||null;
  for(const point of snapshots){
    if(normalized(point?.artist)!==normalized(target.name)||point.source!=='Kworb'||point.metric!=='monthly_listeners'||(artistId&&point.artistId&&point.artistId!==artistId))continue;
    add(point);
  }
  const points=[...observations].sort((a,b)=>a[0]-b[0]).map(([,point])=>point);
  const firstTime=Date.parse(target.firstPlayed);
  const baseline=points.findLast(point=>Date.parse(point.date)<=firstTime&&point.listeners>0);
  const hasBaseline=Boolean(baseline&&firstTime-Date.parse(baseline.date)<=31*DAY);
  const status=coverage?.status==='no_baseline'&&hasBaseline?'ready':coverage?.status;
  // CDX exposes at most 600 captures per each of two ranking pages. The larger
  // cap also bounds corrupted local records while retaining the true baseline.
  const kept=points.length<=2048?points:[...new Map([points[0],baseline,...points.slice(-2046)].filter(Boolean).map(point=>[point.date,point])).values()].sort((a,b)=>a.date.localeCompare(b.date));
  return {
    ...coverage,status,observations:kept,
    ...(points.length?{from:points[0].date,to:points.at(-1).date,count:points.length,hasBaseline,baselineDate:baseline?.date||null,baselineAgeDays:baseline?Math.round((firstTime-Date.parse(baseline.date))/DAY):null}:{}),
    ...(status==='ready'?{retryable:false,note:'Получены реальные наблюдения до первого прослушивания и позднее.'}:{}),
  };
}

/** One shared automatic queue. Closing a card or the coverage window never cancels it. */
export default function useAudienceHistory(dataset,onSnapshots){
  const targets=useMemo(()=>dataset?analyzeHistory(dataset,{entity:'artists',minMs:1}).items.map(audienceTarget).filter(Boolean).sort((a,b)=>a.firstPlayed.localeCompare(b.firstPlayed)):[],[dataset]);
  const current=useRef(null),listener=useRef(onSnapshots),backlog=useRef([]);
  listener.current=onSnapshots;
  const [state,setState]=useState({records:{},running:false,queued:0,checked:0,total:0,error:'',retryAt:0});

  const request=useCallback((items,{priority=false,force=false}={})=>{
    const session=current.current;
    if(!session?.ready){backlog.current.push({items,priority,force});return;}
    const added=[];
    for(const item of items||[]){
      const target=audienceTarget(item);if(!target)continue;
      const key=audienceKey(target);session.targets.set(key,target);
      const betterIdentity=target.artistId&&target.artistId!==session.records[key]?.artistId;
      if(session.queued.has(key)||(!force&&freshAudienceRecord(session.records[key])&&!betterIdentity))continue;
      if(session.records[key]&&(force||betterIdentity))session.records[key]={...session.records[key],archiveChecked:[],...(betterIdentity&&session.records[key].artistId?{observations:[]}: {})};
      session.queued.add(key);added.push(target);
    }
    priority?session.queue.unshift(...added):session.queue.push(...added);
    session.publish();void session.pump();
    if(!session.running&&!session.queue.length)session.retryLater?.();
  },[]);

  useEffect(()=>{
    if(!dataset){setState({records:{},running:false,queued:0,checked:0,total:0,error:'',retryAt:0});return;}
    const session={ready:false,queue:[],queued:new Set(),targets:new Map(),records:{},running:false,error:'',retryAt:0,attempts:new Map(),abort:new AbortController(),retryTimer:null,persistTimer:null};
    current.current=session;
    session.publish=()=>{
      if(session.abort.signal.aborted)return;
      const keys=[...session.targets.keys()];
      setState({records:Object.fromEntries(keys.filter(key=>session.records[key]).map(key=>[key,session.records[key]])),running:session.running,queued:session.queued.size,checked:keys.filter(key=>session.records[key]&&!session.queued.has(key)).length,total:keys.length,error:session.error,retryAt:session.retryAt});
    };
    session.persist=()=>{
      clearTimeout(session.persistTimer);
      session.persistTimer=setTimeout(()=>{
        // Structured observations only. No artwork/audio bytes or source archives.
        const records=Object.fromEntries(Object.entries(session.records).filter(([,record])=>Date.now()-record.checkedAt<DAY));
        void writeLocal('audience-coverage',records).catch(()=>{});
      },250);
    };
    session.retryLater=()=>{
      if(session.abort.signal.aborted)return;
      clearTimeout(session.retryTimer);session.retryTimer=null;
      const retryable=Object.values(session.records).filter(record=>record.retryable&&session.targets.has(record.key));
      if(!retryable.length)return;
      const next=Math.min(...retryable.map(record=>record.checkedAt+Math.max(30000,Number(record.retryAfterSeconds||60)*1000)));
      session.retryAt=next;session.publish();
      session.retryTimer=setTimeout(()=>{
        session.retryTimer=null;session.retryAt=0;
        request(retryable.map(record=>({name:record.artist,firstPlayed:record.firstPlayed,artistId:record.artistId})),{priority:true});
      },Math.max(1000,next-Date.now()));
    };
    session.pump=async()=>{
      if(session.running||!session.ready||session.abort.signal.aborted||!session.queue.length)return;
      session.running=true;session.publish();
      try{
        while(session.queue.length&&!session.abort.signal.aborted){
          const batch=session.queue.splice(0,20);
          const controller=new AbortController();
          const abort=()=>controller.abort();session.abort.signal.addEventListener('abort',abort,{once:true});
          const timeout=setTimeout(()=>controller.abort(),60000);
          try{
            const response=await fetch(apiUrl('/api/audience/resolve'),{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({provider:'kworb',artists:batch.map(target=>audienceRequestTarget(target,session.records[audienceKey(target)]))})});
            const result=await response.json();if(!response.ok)throw Error(result.error||'Источник истории временно недоступен.');
            if(session.abort.signal.aborted)break;
            session.error='';
            if(result.snapshots?.length)listener.current?.(result.snapshots);
            for(const target of batch){
              const key=audienceKey(target);
              const received=(result.coverage||[]).find(record=>normalized(record.artist)===normalized(target.name)&&(!record.firstPlayed||Date.parse(record.firstPlayed)===Date.parse(target.firstPlayed)));
              const coverage=received?mergeAudienceCoverage(session.records[key],received,target,result.snapshots):null;
              const failure=(result.errors||[]).find(record=>normalized(record.artist)===normalized(target.name));
              session.records[key]={...session.records[key],...coverage,key,artist:target.name,firstPlayed:target.firstPlayed,artistId:coverage?.artistId||target.artistId||session.records[key]?.artistId||null,status:coverage?.status||(coverage?.hasBaseline?'ready':coverage?'no_baseline':'unavailable'),retryable:coverage?.retryable??!coverage,retryAfterSeconds:Math.max(Number(coverage?.retryAfterSeconds||60),Math.min(900,30*2**Math.min(session.attempts.get(key)||0,5))),note:coverage?.note||failure?.error||(!coverage?'Источник пока не вернул историю.':'История проверена.'),checkedAt:Date.now()};
              session.attempts.set(key,(session.attempts.get(key)||0)+1);
              session.queued.delete(key);
            }
            if(result.summary?.providerUnavailable||result.summary?.rateLimited||(result.coverage?.length&&result.coverage.every(record=>record.status==='unavailable'))){
              session.error='Источник истории временно недоступен. Повторим проверку автоматически.';
              session.retryAt=Date.now()+60000;session.publish();session.persist();
              await waitForRetry(session.abort.signal,60000);session.retryAt=0;
            }
          }catch(error){
            if(session.abort.signal.aborted)break;
            session.error=error.name==='AbortError'?'Проверка источника заняла слишком много времени. Повторим автоматически.':error.message;
            for(const target of batch){const key=audienceKey(target);session.records[key]={...session.records[key],key,artist:target.name,firstPlayed:target.firstPlayed,artistId:target.artistId||session.records[key]?.artistId||null,status:'unavailable',retryable:true,retryAfterSeconds:Math.min(900,60*2**Math.min(session.attempts.get(key)||0,4)),note:session.error,checkedAt:Date.now()};session.attempts.set(key,(session.attempts.get(key)||0)+1);session.queued.delete(key);}
            // Pause the remaining queue on a failed endpoint, rather than firing hundreds of failed requests.
            session.retryAt=Date.now()+60000;session.publish();
            await waitForRetry(session.abort.signal,60000);
            session.retryAt=0;
          }finally{clearTimeout(timeout);session.abort.signal.removeEventListener('abort',abort);}
          session.publish();session.persist();
        }
      }finally{session.running=false;session.publish();session.retryLater();}
    };
    void readLocal('audience-coverage').catch(()=>({})).then(saved=>{
      if(session.abort.signal.aborted)return;
      session.records=Object.fromEntries(Object.entries(saved||{}).filter(([,record])=>Date.now()-Number(record.checkedAt||0)<DAY));
      session.ready=true;request(targets);
      for(const pending of backlog.current.splice(0))request(pending.items,pending);
    });
    return()=>{session.abort.abort();clearTimeout(session.retryTimer);clearTimeout(session.persistTimer);if(current.current===session)current.current=null;};
  },[dataset,targets,request]);

  const getCoverage=useCallback(item=>state.records[audienceKey(audienceTarget(item))]||null,[state.records]);
  return {...state,libraryTargets:targets,request,getCoverage};
}
