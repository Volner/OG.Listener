import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, ArrowLeft, ArrowRight, ArrowUpRight, Disc3, Download, FileArchive, Info, LoaderCircle, Mic2, Play, Search, SlidersHorizontal, Sparkles, Upload, X } from 'lucide-react';
import Mosaic from './components/Mosaic.jsx';
import ActivityChart from './components/ActivityChart.jsx';
import TrackDetails from './components/TrackDetails.jsx';
import AudioPlayer from './components/AudioPlayer.jsx';
import AudienceDialog from './components/AudienceDialog.jsx';
import FiltersPopover, {emptyFilters,countFilters} from './components/FiltersPopover.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';
import { analyzeHistory } from './lib/history.js';
import { resolveCatalogBatch } from './lib/api.js';
import { createCatalogQueue } from './lib/catalog-queue.js';
import { readLocal, writeLocal } from './lib/storage.js';
import useAudienceHistory from './lib/useAudienceHistory.js';
import { Artwork, DropZone, download, number } from './ui.jsx';
import { useI18n } from './lib/i18n-react.jsx';
import { translateError } from './lib/i18n.js';
import { readRoute, routeHref, routeChangeEvents } from './lib/routing.js';
import './app.css';

function mergeMetadata(previous={},next={}){
  const {artworkLocal,...clean}=next;
  const result={...previous,...clean,genres:[...new Set([...(previous.genres||[]),...(next.genres||[])])],previewUrl:next.previewUrl||previous.previewUrl||null};
  delete result.artworkLocal;
  result.audioUrl=/^https:\/\//.test(next.audioUrl||'')?next.audioUrl:/^https:\/\//.test(previous.audioUrl||'')?previous.audioUrl:null;
  if(result.audioUrl&&previous.audioKind==='full'&&next.audioKind!=='full'){for(const key of ['audioKind','audioSource','audioExternalUrl','audioDurationMs'])result[key]=previous[key];}
  return result;
}
function cleanCatalog(catalog={}){return Object.fromEntries(Object.entries(catalog).map(([id,item])=>[id,mergeMetadata({},item)]));}

export default function App(){
  const {t,language}=useI18n();
  const [path,setPath]=useState(()=>readRoute()),[ready,setReady]=useState(false),[dataset,setDataset]=useState(null);
  const [metadata,setMetadata]=useState({}),[growth,setGrowth]=useState([]),[entity,setEntity]=useState('tracks'),[mode,setMode]=useState('plays'),[view,setView]=useState('library');
  const [filters,setFilters]=useState({...emptyFilters}),[filtersOpen,setFiltersOpen]=useState(false),[query,setQuery]=useState('');
  const minMs=filters.minMs||1;
  const [selected,setSelected]=useState(null),[modal,setModal]=useState(null),[audienceArtist,setAudienceArtist]=useState(null);
  const [busy,setBusy]=useState(false),[toast,setToast]=useState(''),[apiError,setApiError]=useState(null);
  const [player,setPlayer]=useState(null),[playRequest,setPlayRequest]=useState(0);
  const deferredQuery=useDeferredValue(query);
  const trackMapRef=useRef(new Map()),metadataRef=useRef(metadata);
  metadataRef.current=metadata;
  function navigate(next,replace=false){history[replace?'replaceState':'pushState']({},'',routeHref(next));setPath(next);setFiltersOpen(false);window.scrollTo({top:0});}
  useEffect(()=>{const pop=()=>setPath(readRoute());const events=routeChangeEvents();for(const event of events)window.addEventListener(event,pop);return()=>{for(const event of events)window.removeEventListener(event,pop);};},[]);
  useEffect(()=>{
    let live=true;
    Promise.all([readLocal('history').catch(()=>null),readLocal('catalog').catch(()=>({})),readLocal('growth').catch(()=>[])]).then(([data,cache,snapshots])=>{if(live){setMetadata(cleanCatalog(cache||{}));setDataset(data||null);setGrowth(snapshots||[]);setReady(true);}});
    return()=>{live=false;};
  },[]);
  useEffect(()=>{if(ready&&!dataset&&path!=='/upload')navigate('/upload',true);},[ready,dataset,path]);
  useEffect(()=>{if(toast){const timer=setTimeout(()=>setToast(''),7000);return()=>clearTimeout(timer);}},[toast]);
  const trackMap=useMemo(()=>new Map((dataset?.tracks||[]).map(track=>[track.id,track])),[dataset]);
  trackMapRef.current=trackMap;
  const onMetadata=useCallback((id,item)=>{if(item)setMetadata(previous=>({...previous,[id]:mergeMetadata(previous[id],item)}));},[]);
  const catalogQueue=useMemo(()=>createCatalogQueue({
    resolve:resolveCatalogBatch,
    getMetadata:id=>metadataRef.current[id],
    onEntries:entries=>setMetadata(previous=>{const next={...previous};for(const [id,item]of Object.entries(entries))next[id]=mergeMetadata(previous[id],item);return next;}),
    onState:state=>setApiError(state.failures.length?{key:state.retryAt?'Каталог ограничил частоту запросов. Повторим автоматически.':'Не удалось обновить сведения о {count} треках. Повторите запрос.',count:state.failures.length}:null),
  }),[]);
  useEffect(()=>()=>catalogQueue.close(),[catalogQueue]);
  const requestMetadata=useCallback(items=>{
    catalogQueue.add(items.map(item=>trackMapRef.current.get(item.topTrackId||item.id)).filter(Boolean));
  },[catalogQueue]);
  const analysis=useMemo(()=>dataset?analyzeHistory(dataset,{entity,minMs,query:deferredQuery,metadata,growth,...filters}):null,[dataset,entity,minMs,deferredQuery,metadata,growth,filters]);
  const base=useMemo(()=>dataset?analyzeHistory(dataset,{entity,minMs,metadata,growth}):null,[dataset,entity,minMs,metadata,growth]);
  const allArtists=useMemo(()=>dataset?analyzeHistory(dataset,{entity:'artists',minMs:1,metadata,growth}).items:[],[dataset,metadata,growth]);
  const audience=useAudienceHistory(dataset,addSnapshots);
  const selectedItem=useMemo(()=>{if(!selected||!dataset)return selected;return (selected.id.startsWith('artist:')?allArtists:analyzeHistory(dataset,{entity:'tracks',minMs:1,metadata,growth}).items).find(item=>item.id===selected.id)||selected;},[selected,dataset,allArtists,metadata,growth]);
  const requestVisibleItems=useCallback(items=>{requestMetadata(items);audience.request(items,{priority:true});},[requestMetadata,audience.request]);
  const genres=useMemo(()=>[...new Set((base?.items||[]).flatMap(item=>item.genres||[]))].sort(),[base]);
  const genreCoverage=useMemo(()=>({known:(dataset?.tracks||[]).filter(track=>metadata[track.id]?.genres?.length).length,total:dataset?.tracks.length||0}),[dataset,metadata]);
  const dateBounds=useMemo(()=>{const events=dataset?.events;if(!events?.length)return {};return {min:new Date(events[0][1]*1000).toISOString().slice(0,10),max:new Date(events.at(-1)[1]*1000).toISOString().slice(0,10)};},[dataset]);
  const playCountMax=useMemo(()=>(base?.items||[]).reduce((maximum,item)=>Math.max(maximum,item.plays),1),[base]);
  const byPlays=useMemo(()=>[...(analysis?.items||[])].sort((a,b)=>b.plays-a.plays||b.msPlayed-a.msPlayed||a.name.localeCompare(b.name)),[analysis]);
  const podium=byPlays.slice(0,3),podiumKey=podium.map(item=>item.id).join('|');
  const sorted=useMemo(()=>mode==='plays'?byPlays:[...byPlays].sort((a,b)=>(b.growthScore??-1)-(a.growthScore??-1)||b.plays-a.plays),[byPlays,mode]);
  useEffect(()=>{if(podiumKey)requestVisibleItems(podium);},[podiumKey,requestVisibleItems]);
  const closeFilters=useCallback(()=>setFiltersOpen(false),[]);
  const stats=analysis?.stats||{};
  const isUpload=path==='/upload'||!dataset;

  async function importHistory(files){
    const selectedFiles=Array.from(files||[]);if(!selectedFiles.length||busy)return;
    if(selectedFiles.some(file=>!/^.+\.(zip|json)$/i.test(file.name))){setToast('Выберите ZIP или JSON истории Spotify.');return;}
    setBusy(true);
    try{
      const worker=new Worker(new URL('./history-worker.js',import.meta.url),{type:'module'});
      const next=await new Promise((resolve,reject)=>{worker.onmessage=({data})=>{worker.terminate();data.error?reject(Error(data.error)):resolve(data.dataset);};worker.onerror=()=>{worker.terminate();reject(Error('Не удалось прочитать файл. Проверьте формат истории.'));};worker.postMessage({files:selectedFiles});});
      await writeLocal('history',next);catalogQueue.reset();
      setDataset(next);setFilters({...emptyFilters});setQuery('');setEntity('tracks');setMode('plays');setSelected(null);setPlayer(null);setView('library');navigate('/');
    }catch(error){setToast(error.message);}finally{setBusy(false);}
  }
  function play(item){const raw=item.id?.startsWith('artist:')?trackMap.get(item.topTrackId)||{id:item.topTrackId,name:item.topTrack,artist:item.name,uri:item.topTrackUri}:item;setPlayer({...raw,...metadata[raw.id],name:raw.name,artist:raw.artist});setPlayRequest(value=>value+1);}
  function selectItem(item){if(item.plays==null&&!item.id.startsWith('artist:')){const full=analyzeHistory(dataset,{entity:'tracks',minMs:1,metadata,growth}).items.find(track=>track.id===item.id);setSelected(full||item);}else setSelected(item);requestVisibleItems([item]);}
  function openAudience(artist=null){const lifetime=artist?allArtists.find(item=>item.name.toLocaleLowerCase()===artist.name.toLocaleLowerCase()):null;const target=artist?{...lifetime,...artist,firstPlayed:artist.firstPlayed||lifetime?.firstPlayed}:null;setSelected(null);setAudienceArtist(target);if(target)audience.request([target],{priority:true});setModal('audience');}
  function addSnapshots(records){setGrowth(previous=>{const merged=new Map(previous.map(record=>[[record.artist.toLocaleLowerCase(),record.date,record.source,record.metric].join('|'),record]));for(const record of records)merged.set([record.artist.toLocaleLowerCase(),record.date,record.source,record.metric].join('|'),record);const next=[...merged.values()];writeLocal('growth',next).catch(()=>{});return next;});}
  function exportCsv(){const cell=value=>'"'+String(value??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';download('\ufeffname,artist,plays,minutes,first_played,genres\n'+sorted.map(item=>[item.name,item.artist,item.plays,Math.round(item.msPlayed/60000),item.firstPlayed,(item.genres||[]).join(';')].map(cell).join(',')).join('\n'),`og-listener-${entity}.csv`);}
  function retryMetadata(){catalogQueue.retry();}

  return <div className="app-shell">
    <header className={`topbar${isUpload?' is-upload':''}`}><a className="brand" href={routeHref(dataset?'/':'/upload')} onClick={e=>{e.preventDefault();navigate(dataset?'/':'/upload');setView('library');}}><AudioLines size={25}/><span>OG<span style={{color:'var(--accent)'}}>.</span>Listener</span></a>{!isUpload&&<nav className="top-nav" aria-label={t('Разделы')}><button className={view==='library'?'selected':''} onClick={()=>setView('library')}>{t('Музыка')}</button><button className={view==='history'?'selected':''} onClick={()=>setView('history')}>{t('История')}</button></nav>}<div className="topbar-actions"><LanguageSwitcher/>{!isUpload&&<button className="button button-small" onClick={()=>navigate('/upload')}><Upload size={15}/><span>{t('Загрузить архив')}</span></button>}</div></header>
    {isUpload?<main className="upload-page"><div className="upload-intro"><h1>{t('История, которую')}<br/>{t('вы слушали.')}</h1><p>{t('Загрузите архив Spotify, чтобы увидеть свою музыку.')}</p></div><DropZone accept=".zip,.json" multiple busy={busy||!ready} onFiles={importHistory}>{busy?<LoaderCircle className="spin" size={36}/>:<FileArchive size={36} strokeWidth={1.4}/>}<strong>{busy?t('Читаем историю…'):t('Перетащите архив сюда')}</strong><span>{t('ZIP или JSON из Spotify')}</span><span className="button button-primary"><Upload size={16}/>{busy?t('Обработка…'):t('Выбрать архив')}</span></DropZone><p className="upload-privacy">{t('Файл обрабатывается в браузере. Музыка и обложки открываются из внешних источников.')}</p>{dataset&&<button className="continue-library" onClick={()=>navigate('/')}><Disc3 size={20}/><span>{t('Открыть библиотеку')} <small>{t('{count} треков',{count:number(dataset.tracks.length)})}</small></span><ArrowRight size={19}/></button>}<a className="text-button upload-instructions" href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">{t('Как получить историю Spotify')}<ArrowUpRight size={14}/></a></main>:<main className="library-page">
      <section className="library-heading"><div><h1>{view==='history'?t('История прослушиваний'):t('Моя музыка')}</h1>{view==='history'&&<p>{t('{count} треков',{count:number(stats.tracks)})} <span>·</span> {t('{count} исполнителей',{count:number(stats.artists)})}</p>}</div><button className="icon-button" aria-label={t('Экспортировать CSV')} onClick={exportCsv}><Download size={19}/></button></section>
      <section className="library-controls"><div className="entity-toggle" role="group" aria-label={t('Треки или исполнители')}><button className={entity==='tracks'?'selected':''} onClick={()=>setEntity('tracks')}><Disc3 size={16}/>{t('Треки')}</button><button className={entity==='artists'?'selected':''} onClick={()=>setEntity('artists')}><Mic2 size={16}/>{t('Исполнители')}</button></div><div className="controls-spacer"/><label className="search-box"><Search size={18}/><input aria-label={t('Найти трек или исполнителя')} value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('Поиск по музыке')}/>{query&&<button aria-label={t('Очистить поиск')} onClick={()=>setQuery('')}><X size={16}/></button>}</label><div className="filters-anchor"><button className={`button filter-trigger ${countFilters(filters)?'applied':''}`} data-filter-trigger aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(value=>!value)}><SlidersHorizontal size={17}/>{t('Фильтры')}{countFilters(filters)>0&&<span>{number(countFilters(filters))}</span>}</button>{filtersOpen&&<FiltersPopover value={filters} genres={genres} genreCoverage={genreCoverage} dateBounds={dateBounds} playCountMax={playCountMax} onChange={setFilters} onClose={closeFilters}/>}</div></section>
      {apiError&&<div className="inline-error" role="status">{t(apiError.key,{count:number(apiError.count)})}<button className="text-button" onClick={retryMetadata}>{t('Повторить')}</button></div>}
      {view==='history'?<HistoryTable dataset={dataset} metadata={metadata} filters={filters} query={deferredQuery} entity={entity} analysis={analysis} minMs={minMs} onSelect={selectItem}/>:<>
        {podium.length>0&&<section className="podium-section"><div className="section-heading"><h2>{t('На повторе')}</h2></div><div className="podium">{[2,0,1].filter(index=>podium[index]).map(index=>{const item=podium[index];return <article className={`podium-card podium-place-${index+1}`} data-rank={index+1} key={item.id}><button className="podium-select" aria-label={t('Открыть {name}',{name:item.name})} onClick={()=>selectItem(item)}><div className="podium-cover"><Artwork item={item}/><span className="podium-rank">{number(index+1)}</span></div><div className="podium-description"><strong>{item.name}</strong><span>{entity==='tracks'?item.artist:t('{count} треков',{count:number(item.trackCount)})}</span><b>{number(item.plays)}<small>{t('прослушиваний',{count:item.plays})}</small></b></div></button><button className="podium-play" aria-label={t('Слушать {name}',{name:item.name})} onClick={()=>play(item)}><Play size={18} fill="currentColor"/></button></article>;})}</div></section>}
        <section className="overview-strip"><div className="stats-grid"><div className="stat"><span>{t('Прослушивания')}</span><strong>{number(stats.plays)}</strong></div><div className="stat"><span>{t('Часы с музыкой')}</span><strong>{number(stats.msPlayed/3600000)}</strong></div><div className="stat"><span>{t('Разных треков')}</span><strong>{number(stats.tracks)}</strong></div><div className="stat"><span>{t('Исполнителей')}</span><strong>{number(stats.artists)}</strong></div></div><section className="activity-panel"><div className="section-heading"><h2>{t('Музыка на протяжении лет')}</h2>{countFilters(filters)>0&&<span>{t('Выбранный период')}</span>}</div><ActivityChart months={analysis.months}/></section></section>
        <section className="music-section"><div className="library-list-heading"><h2>{entity==='artists'?t('Исполнители'):t('Треки')} <span className="small-count">{number(analysis.items.length)}</span></h2><div className="method-tabs" role="group" aria-label={t('Показатель размера')}><button className={mode==='plays'?'selected':''} onClick={()=>setMode('plays')}>{t('Прослушивания')}</button><button className={mode==='growth'?'selected':''} onClick={()=>setMode('growth')}><Sparkles size={14}/>{t('Ранние открытия')}</button></div></div>{(sorted.length>podium.length||!sorted.length)&&<Mosaic key={`${entity}-${mode}-${JSON.stringify(filters)}-${deferredQuery}`} items={sorted} excludeIds={podium.map(item=>item.id)} rankOffset={mode==='plays'?3:0} mode={mode} entity={entity} onSelect={selectItem} onPlay={play} onImportGrowth={()=>openAudience()} onVisibleItems={requestVisibleItems}/>}</section>
      </>}
    </main>}
    {modal==='audience'&&<AudienceDialog artist={audienceArtist} history={audience} growth={growth} onClose={()=>setModal(null)}/>}
    {selected&&<TrackDetails key={selectedItem.id} item={selectedItem} dataset={dataset} metadata={metadata} audience={audience} growth={growth} onClose={()=>setSelected(null)} onPlay={play} onSelect={selectItem}/>}
    {player&&<AudioPlayer track={player} playRequest={playRequest} onClose={()=>setPlayer(null)} onError={setToast} onResolved={onMetadata} onOpenDetails={selectItem}/>}
    {toast&&<div className="toast" role="status"><Info size={18}/><span>{translateError(toast,language)}</span><button aria-label={t('Закрыть уведомление')} onClick={()=>setToast('')}><X size={18}/></button></div>}
  </div>;
}

function HistoryTable({dataset,metadata,filters,query,entity,analysis,minMs,onSelect}){
  const {t,locale}=useI18n();
  const dateTimeFormat=useMemo(()=>new Intl.DateTimeFormat(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'}),[locale]);
  const [page,setPage]=useState(0);useEffect(()=>setPage(0),[dataset,filters,minMs,query,entity]);
  const events=useMemo(()=>{const from=filters.dateFrom?Date.parse(`${filters.dateFrom}T00:00:00Z`):-Infinity;const to=filters.dateTo?Date.parse(`${filters.dateTo}T00:00:00Z`)+86400000:Infinity;const allowed=new Set(analysis.items.map(item=>entity==='artists'?item.name.toLocaleLowerCase():item.id));return [...dataset.events].reverse().filter(event=>{const track=dataset.tracks[event[0]];return track&&allowed.has(entity==='artists'?track.artist.toLocaleLowerCase():track.id)&&event[2]>0&&event[2]>=minMs&&event[1]*1000>=from&&event[1]*1000<to;});},[dataset,analysis,entity,filters,minMs]);
  return <section className="history-panel"><div className="section-heading"><h2>{t('Последние прослушивания')}</h2><span>{t('{count} записей',{count:number(events.length)})}</span></div>{events.slice(page*30,page*30+30).map((event,index)=>{const track=dataset.tracks[event[0]];return <button className="history-table-row" key={`${event[1]}-${index}`} onClick={()=>onSelect({...track,...metadata[track.id],plays:null})}><span className="history-track"><Artwork item={{...track,...metadata[track.id]}}/><span><strong>{track.name}</strong><small>{track.artist}</small></span></span><time>{dateTimeFormat.format(new Date(event[1]*1000))}</time><span>{Math.floor(event[2]/60000)}:{String(Math.floor(event[2]/1000)%60).padStart(2,'0')}</span></button>;})}<div className="pagination"><span>{t('Страница {page}',{page:number(page+1)})}</span><button className="button button-small" disabled={page===0} onClick={()=>setPage(page-1)}><ArrowLeft size={14}/>{t('Назад')}</button><button className="button button-small" disabled={(page+1)*30>=events.length} onClick={()=>setPage(page+1)}>{t('Далее')}<ArrowRight size={14}/></button></div></section>;
}
