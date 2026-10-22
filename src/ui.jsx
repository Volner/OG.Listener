import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, X } from 'lucide-react';
import { formatDate, formatNumber, getLanguage } from './lib/i18n.js';
import { useI18n } from './lib/i18n-react.jsx';

export const number = n => formatNumber(Math.round(n || 0));
export const date = value => formatDate(value);
export const ratio = value => formatNumber(value,{maximumFractionDigits:3});
export const genreLabels = {'Hip-Hop/Rap':'Хип-хоп / рэп','R&B/Soul':'R&B / соул',Alternative:'Альтернатива',Electronic:'Электроника',Pop:'Поп',Rock:'Рок',Classical:'Классика',Jazz:'Джаз',Dance:'Танцевальная'};
export const genreLabel = value => getLanguage()==='ru' ? genreLabels[value] || value : value;

export function Artwork({item,className=''}) {
  const remote = item.artwork;
  const [failed,setFailed] = useState(0);
  useEffect(()=>setFailed(0),[remote]);
  const source = failed === 0 && /^https?:\/\//.test(remote||'') ? remote : null;
  const initials=(item.artist||item.name||'?').split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase();
  return <span className={`artwork ${className}`}><span className="artwork-initials" aria-hidden="true">{initials}</span>{source&&<img src={source} alt="" loading="lazy" decoding="async" onError={()=>setFailed(value=>value+1)}/>}</span>;
}

export function Modal({title,onClose,children,modeless=false}) {
  const {t}=useI18n();
  const dialog=useRef(null);
  useEffect(()=>{const before=document.activeElement;modeless?dialog.current.show():dialog.current.showModal();return()=>{if(before?.isConnected)before.focus();};},[]);
  useEffect(()=>{if(!modeless)return;const escape=e=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[modeless,onClose]);
  return <>{modeless&&<button className="card-backdrop" tabIndex={-1} aria-label={t('Закрыть карточку')} onClick={onClose}/>}<dialog ref={dialog} className={`modal ${modeless?'card-modal':''}`} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===dialog.current){const r=dialog.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}><div className="modal-header"><AudioLines size={23}/><button className="icon-button" aria-label={t('Закрыть окно')} onClick={onClose}><X size={21}/></button></div><h2>{title}</h2>{children}</dialog></>;
}

export function DropZone({accept,multiple=false,busy=false,onFiles,children}) {
  const {t}=useI18n();
  const [drag,setDrag]=useState(false);
  return <label className={`drop-zone ${drag?'dragging':''} ${busy?'busy':''}`} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);if(!busy)onFiles(e.dataTransfer.files);}}><input aria-label={t('Выбрать файл для загрузки')} type="file" accept={accept} multiple={multiple} disabled={busy} onChange={e=>{onFiles(e.target.files);e.target.value='';}}/>{children}</label>;
}

export function download(content,filename,type='text/csv;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
