import common from '../locales/en-common.js';
import library from '../locales/en-library.js';
import filters from '../locales/en-filters.js';
import details from '../locales/en-details.js';
import audio from '../locales/en-audio.js';

export const LANGUAGE_STORAGE_KEY = 'og-listener.language';
export const LOCALES = Object.freeze({ ru: 'ru-RU', en: 'en-US' });
export const EN_MESSAGES = Object.freeze({ ...common, ...library, ...filters, ...details, ...audio });
const EN_SINGULAR_MESSAGES = Object.freeze({
  'прослушиваний': 'play',
  'слушателей': 'listener',
  '{count} прослушиваний': '{count} play',
  '{count} треков': '{count} track',
  '{count} исполнителей': '{count} artist',
  '{count} треков в истории': '{count} track in your history',
  '{count} записей': '{count} record',
  '{from} — {to} · {count} снимков': '{from} — {to} · {count} snapshot',
  '{artist}. {count} архивных снимков. От {from} до {to}.': '{artist}. {count} archived snapshot. From {from} to {to}.',
  'Не удалось обновить сведения о {count} треках. Повторите запрос.': 'Could not update details for {count} track. Please retry.',
});
const validPreference = value => ['auto', 'ru', 'en'].includes(value) ? value : 'auto';

export function detectBrowserLanguage(languages = [], fallback = 'en') {
  for (const language of typeof languages === 'string' ? [languages] : languages || []) {
    const base = String(language).toLowerCase().split(/[-_]/)[0];
    if (Object.hasOwn(LOCALES, base)) return base;
  }
  return Object.hasOwn(LOCALES, fallback) ? fallback : 'en';
}

/** A language preference never touches the listener's IndexedDB library. */
export function createLanguageStore({ storage, browserLanguages = () => ['en'], onChange = () => {} } = {}) {
  const listeners = new Set();
  const read = () => { try { return validPreference(storage?.getItem(LANGUAGE_STORAGE_KEY)); } catch { return 'auto'; } };
  const automatic = () => detectBrowserLanguage(browserLanguages());
  let preference = read();
  let language = preference === 'auto' ? automatic() : preference;
  let snapshot = `${preference}|${language}`;
  function update(nextPreference) {
    preference = validPreference(nextPreference);
    const nextLanguage = preference === 'auto' ? automatic() : preference;
    const nextSnapshot = `${preference}|${nextLanguage}`;
    if (nextSnapshot === snapshot) return;
    language = nextLanguage;
    snapshot = nextSnapshot;
    onChange(language);
    for (const listener of listeners) listener();
  }
  return {
    getLanguage: () => language,
    getPreference: () => preference,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setPreference(next) {
      const selected = validPreference(next);
      try { selected === 'auto' ? storage?.removeItem(LANGUAGE_STORAGE_KEY) : storage?.setItem(LANGUAGE_STORAGE_KEY, selected); } catch { /* The choice still works for this page when storage is unavailable. */ }
      update(selected);
    },
    refreshBrowserLanguage: () => update(preference),
    refreshStoredPreference: () => update(read()),
  };
}

const inBrowser = typeof window !== 'undefined';
const store = createLanguageStore({
  storage: inBrowser ? {
    getItem: key => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: key => window.localStorage.removeItem(key),
  } : undefined,
  browserLanguages: () => inBrowser ? navigator.languages?.length ? navigator.languages : [navigator.language] : ['ru'],
  onChange: () => updateDocumentLanguage(),
});

export const getLanguage = () => store.getLanguage();
export const getLocale = (language = getLanguage()) => LOCALES[language] || LOCALES.en;
export const getLanguageSnapshot = () => store.getSnapshot();
export const subscribeLanguage = listener => store.subscribe(listener);
export const setLanguagePreference = preference => store.setPreference(preference);

export function translate(message, params = {}, language = getLanguage()) {
  const source = String(message ?? '');
  const count = Number(String(params.count).replace(/[\s,]/g, ''));
  const template = language === 'en' ? (count === 1 ? EN_SINGULAR_MESSAGES[source] : undefined) ?? EN_MESSAGES[source] ?? source : source;
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => params[key] === undefined ? placeholder : String(params[key]));
}

export function formatNumber(value, options = {}, language = getLanguage()) {
  return new Intl.NumberFormat(getLocale(language), options).format(value);
}
export function formatDate(value, options = {}, language = getLanguage()) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return translate('Нет данных', {}, language);
  return new Intl.DateTimeFormat(getLocale(language), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC', ...options }).format(date);
}

export function translateError(value, options = {}, language = getLanguage()) {
  if (typeof options === 'string') { language = options; options = {}; }
  const message = String(value?.message || value || '');
  if (['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(message)) return translate('Не удалось подключиться. Проверьте соединение и повторите попытку.', {}, language);
  if (language !== 'en') return message;
  if (Object.hasOwn(EN_MESSAGES, message)) return translate(message, {}, language);
  for (const [prefix, translated] of [
    ['Не удалось прочитать JSON: ', 'Could not read JSON: '],
    ['Не удалось открыть ZIP-архив: ', 'Could not open ZIP archive: '],
    ['Музыкальный каталог: HTTP ', 'Music catalog: HTTP '],
  ]) if (message.startsWith(prefix)) return translated + message.slice(prefix.length);
  return /\p{Script=Cyrillic}/u.test(message) ? options.fallback || translate('Сведения временно недоступны. Повторите попытку позже.', {}, language) : message;
}

export function updateDocumentLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = getLanguage();
  document.title = translate('OG.Listener — музыка в вашей истории');
  document.querySelector('meta[name="description"]')?.setAttribute('content', translate('Ваша история Spotify в музыке, цифрах и открытиях. Личная аналитика прослушиваний OG.Listener.'));
}

let initialized = false;
export function initializeLanguage() {
  if (!inBrowser || initialized) return;
  initialized = true;
  updateDocumentLanguage();
  window.addEventListener('languagechange', () => store.refreshBrowserLanguage());
  window.addEventListener('storage', event => { if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) store.refreshStoredPreference(); });
}
