import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_STORAGE_KEY, EN_MESSAGES, createLanguageStore, detectBrowserLanguage, formatDate, formatNumber, translate, translateError } from '../src/lib/i18n.js';
import { audienceStatusText } from '../src/lib/audience-status.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('browser language uses ordered supported preferences and falls back to English', () => {
  assert.equal(detectBrowserLanguage(['en-GB', 'ru-RU']), 'en');
  assert.equal(detectBrowserLanguage(['ru-RU', 'en-US']), 'ru');
  assert.equal(detectBrowserLanguage(['RU_ru']), 'ru');
  assert.equal(detectBrowserLanguage(['de-DE', 'ru']), 'ru');
  assert.equal(detectBrowserLanguage(['fr-FR']), 'en');
  assert.equal(detectBrowserLanguage([]), 'en');
});

test('manual language survives a new visit, takes priority over browser changes and automatic mode restores detection', () => {
  const storage = memoryStorage({ history: 'private library stays untouched' });
  let languages = ['en-US'];
  const options = { storage, browserLanguages: () => languages };
  const store = createLanguageStore(options);
  const snapshots = [];
  const unsubscribe = store.subscribe(() => snapshots.push(store.getSnapshot()));
  assert.equal(store.getSnapshot(), 'auto|en');
  store.setPreference('ru');
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), 'ru');
  assert.equal(createLanguageStore(options).getSnapshot(), 'ru|ru');
  languages = ['fr-FR'];
  store.refreshBrowserLanguage();
  assert.equal(store.getLanguage(), 'ru');
  store.setPreference('auto');
  assert.equal(store.getSnapshot(), 'auto|en');
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), null);
  languages = ['ru-RU']; store.refreshBrowserLanguage();
  assert.equal(store.getSnapshot(), 'auto|ru');
  assert.equal(storage.getItem('history'), 'private library stays untouched');
  unsubscribe();
  assert.deepEqual(snapshots, ['ru|ru', 'auto|en', 'auto|ru']);
});

test('cross-tab preference updates and blocked storage preserve usable language selection', () => {
  const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'invalid' });
  const store = createLanguageStore({ storage, browserLanguages: () => ['ru'] });
  assert.equal(store.getSnapshot(), 'auto|ru');
  storage.setItem(LANGUAGE_STORAGE_KEY, 'en'); store.refreshStoredPreference();
  assert.equal(store.getSnapshot(), 'en|en');
  const blocked = createLanguageStore({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } }, browserLanguages: () => ['en'] });
  blocked.setPreference('ru'); assert.equal(blocked.getSnapshot(), 'ru|ru');
  blocked.setPreference('auto'); assert.equal(blocked.getSnapshot(), 'auto|en');
});

test('all English translations keep interpolation placeholders without translating listener data', () => {
  const tokens = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [source, translated] of Object.entries(EN_MESSAGES)) {
    assert.equal(typeof translated, 'string', source);
    assert.deepEqual(tokens(translated), tokens(source), source);
    assert.doesNotMatch(translated, /\p{Script=Cyrillic}/u, source);
  }
  assert.equal(translate('Слушать {name}', { name: 'Моя песня' }, 'en'), 'Play Моя песня');
  assert.equal(translate('Слушать {name}', { name: 'My song' }, 'ru'), 'Слушать My song');
  assert.equal(translate('прослушиваний', { count: 1 }, 'en'), 'play');
  assert.equal(translate('{count} треков', { count: '1' }, 'en'), '1 track');
  assert.equal(translate('{count} треков', { count: '1,001' }, 'en'), '1,001 tracks');
});

test('dates, numbers, coverage and import errors follow the selected locale while UTC dates remain stable', () => {
  assert.equal(formatNumber(12345, {}, 'en'), '12,345');
  assert.match(formatNumber(12345, {}, 'ru'), /^12\D345$/);
  assert.equal(formatDate('2022-11-10T23:30:00Z', {}, 'en'), 'November 10, 2022');
  assert.match(formatDate('2022-11-10T23:30:00Z', {}, 'ru'), /^10 ноября 2022/);
  assert.equal(audienceStatusText({ status: 'not_tracked' }, 'en'), 'Artist not found in the available charts');
  assert.equal(translateError('Не удалось прочитать JSON: История.json', 'en'), 'Could not read JSON: История.json');
  assert.doesNotMatch(translateError('Неизвестная ошибка источника', 'en'), /\p{Script=Cyrillic}/u);
  assert.equal(translateError('Failed to fetch', 'ru'), 'Не удалось подключиться. Проверьте соединение и повторите попытку.');
});
