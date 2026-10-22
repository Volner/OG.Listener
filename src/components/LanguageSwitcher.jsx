import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../lib/i18n-react.jsx';
import './language-switcher.css';

function Flag({ language }) {
  return <svg className="language-flag" data-country={language === 'ru' ? 'ru' : 'gb'} viewBox="0 0 30 20" aria-hidden="true" focusable="false">
    {language === 'ru' ? <><path fill="#fff" d="M0 0h30v7H0z"/><path fill="#0039a6" d="M0 7h30v6H0z"/><path fill="#d52b1e" d="M0 13h30v7H0z"/></> : <>
      <path fill="#012169" d="M0 0h30v20H0z"/><path stroke="#fff" strokeWidth="5" d="m0 0 30 20M30 0 0 20"/><path stroke="#c8102e" strokeWidth="2" d="m0 0 30 20M30 0 0 20"/><path stroke="#fff" strokeWidth="7" d="M15 0v20M0 10h30"/><path stroke="#c8102e" strokeWidth="4" d="M15 0v20M0 10h30"/>
    </>}
  </svg>;
}

export default function LanguageSwitcher() {
  const { t, language, setPreference } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('[aria-selected="true"]')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function choose(next) { setPreference(next); setOpen(false); trigger.current?.focus(); }
  function keyboard(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.current.querySelectorAll('[role="option"]')];
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
  return <div className="language-switcher" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="language-switcher-trigger" type="button" aria-label={t('Язык интерфейса')} title={t('Язык интерфейса')} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
      <Flag language={language}/><span>{language}</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    {open && <div className="language-switcher-menu" ref={menu} id={menuId} role="listbox" aria-label={t('Язык интерфейса')} onKeyDown={keyboard}>
      {['ru', 'en'].map(code => <button key={code} type="button" role="option" aria-label={code === 'ru' ? t('Русский') : 'English'} aria-selected={language === code} tabIndex={language === code ? 0 : -1} onClick={() => choose(code)}><Flag language={code}/><span>{code}</span></button>)}
    </div>}
  </div>;
}
