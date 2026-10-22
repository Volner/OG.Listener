import React, { useMemo } from 'react';
import { Play, ArrowUpRight, CalendarDays } from 'lucide-react';
import { Modal, Artwork, number, date, genreLabel } from '../ui.jsx';
import { analyzeItemHistory } from '../lib/history.js';
import { useI18n } from '../lib/i18n-react.jsx';
import ActivityChart from './ActivityChart.jsx';
import AudienceGrowthChart from './AudienceGrowthChart.jsx';

export default function TrackDetails({item,dataset,metadata,audience,growth,onClose,onPlay,onSelect}) {
  const {t}=useI18n();
  const isArtist=item.id.startsWith('artist:');
  const id=isArtist?item.topTrackId:item.id;
  const cached=metadata[id]||{};
  const detail={...item,artwork:(isArtist?cached.artistArtwork:null)||cached.artwork||item.artwork,previewUrl:cached.previewUrl||item.previewUrl,genres:isArtist?item.genres:cached.genres?.length?cached.genres:item.genres};
  const track=isArtist?{...cached,id:item.topTrackId,uri:item.topTrackUri,name:item.topTrack,artist:item.name}:detail;
  const history=useMemo(()=>analyzeItemHistory(dataset,item,{minMs:1,metadata}),[dataset,item.id,metadata]);
  const first=item.firstTrack;
  const coverage=audience?.getCoverage(item);
  const spotifyUrl=isArtist&&/^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]{22}(?:[?#]|$)/.test(item.spotifyUrl||'')?item.spotifyUrl:!isArtist&&/^[A-Za-z0-9]{22}$/.test(id)?`https://open.spotify.com/track/${id}`:null;
  return <Modal title={item.name} onClose={onClose} modeless>
    <div className="track-hero"><Artwork item={detail} className="detail-cover"/><div><span className="item-kind">{isArtist?t('Исполнитель'):t('Трек')}</span><h3>{isArtist?t('{count} треков в истории',{count:number(history.stats.tracks)}):item.artist}</h3>{item.album&&<p>{item.album}</p>}<div className="genre-chips">{detail.genres?.length?detail.genres.map(genre=><span key={genre}>{genreLabel(genre)}</span>):<span className="unknown-genre">{t('Жанр пока не определён')}</span>}</div></div></div>
    <button className="button button-primary full-width" onClick={()=>onPlay(track)}><Play size={17} fill="currentColor"/>{isArtist?t('Слушать {name}',{name:item.topTrack}):t('Слушать')}</button>
    <div className="detail-stats"><div><span>{t('Прослушивания')}</span><strong>{number(history.stats.plays)}</strong></div><div><span>{t('Время с музыкой')}</span><strong>{number(history.stats.msPlayed/60000)}<small> {t('мин')}</small></strong></div></div>
    <section className="card-chart"><div className="section-heading"><h3>{t('История прослушиваний')}</h3><span>{t('За всё время')}</span></div><ActivityChart months={history.months}/></section>
    <div className="first-listen"><CalendarDays size={19}/><div><span>{t('Первое прослушивание')}</span><strong>{date(item.firstPlayed)}</strong></div></div>
    {isArtist&&first&&<section className="first-track-section"><h3>{t('Первый услышанный трек')}</h3><button className="first-track-button" onClick={()=>onSelect({...first,...metadata[first.id],plays:null})}><Artwork item={{...first,...metadata[first.id]}}/><span><strong>{first.name}</strong><small>{date(first.firstPlayed)}</small></span><ArrowUpRight size={18}/></button></section>}
    <AudienceGrowthChart records={growth} artist={isArtist?item.name:item.artist} firstPlayed={item.firstPlayed} source={item.growthSource} coverage={coverage}/>
    {cached.lastfmUrl&&<a className="text-button lastfm-source" href={cached.lastfmUrl} target="_blank" rel="noreferrer">{t('Теги и метаданные Last.fm')}<ArrowUpRight size={14}/></a>}
    {spotifyUrl&&<div className="detail-api-actions"><a className="text-button" href={spotifyUrl} target="_blank" rel="noreferrer">{t('Открыть в Spotify')}<ArrowUpRight size={14}/></a></div>}
  </Modal>;
}
