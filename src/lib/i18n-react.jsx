import { useCallback, useSyncExternalStore } from 'react';
import { getLanguageSnapshot, getLocale, setLanguagePreference, subscribeLanguage, translate } from './i18n.js';

export function useI18n() {
  const snapshot = useSyncExternalStore(subscribeLanguage, getLanguageSnapshot, () => 'auto|ru');
  const [preference, language] = snapshot.split('|');
  const t = useCallback((message, params) => translate(message, params, language), [language]);
  return { t, language, locale: getLocale(language), preference, setPreference: setLanguagePreference };
}
