import React, { useMemo, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { useI18n } from '../lib/i18n-react.jsx';
import './filter-trigger.css';

export default function FilterTrigger({ count = 0, open = false, onToggle, onClear }) {
  const { t, locale } = useI18n();
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const toggle = useRef(null);
  const applied = count > 0;

  return <div className={`filter-control${applied ? ' filter-control--applied' : ''}`} data-filter-trigger>
    <button
      type="button"
      className="filter-control__toggle"
      ref={toggle}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggle}
    >
      <SlidersHorizontal size={17} aria-hidden="true"/>
      {t('Фильтры')}
      {applied && <span className="filter-control__count">{numberFormat.format(count)}</span>}
    </button>
    {applied && <div className="filter-control__clear-slot">
      <button
        type="button"
        className="filter-control__clear"
        aria-label={t('Сбросить фильтры')}
        title={t('Сбросить фильтры')}
        onClick={() => { onClear(); toggle.current?.focus({ preventScroll: true }); }}
      >
        <X size={17} aria-hidden="true"/>
      </button>
    </div>}
  </div>;
}
