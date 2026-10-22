import { getLanguage, translate, translateError } from './i18n.js';

export function audienceStatusText(record,language=getLanguage()){
  const t=message=>translate(message,{},language);
  if(!record)return t('История проверяется автоматически.');
  switch(record.status){
    case 'ready':return t('Есть снимок рядом с первым прослушиванием.');
    case 'no_baseline':return t('Нет снимка рядом с первым прослушиванием. Коэффициент пока неизвестен.');
    case 'not_tracked':return t('Исполнитель не найден в доступных таблицах');
    case 'ambiguous':return t('Не удалось однозначно сопоставить исполнителя с источником.');
    case 'deferred':return t('Проверка архивных дат продолжится автоматически.');
    case 'unavailable':return t('Источник временно недоступен. Повторная попытка выполняется автоматически.');
    default:return record.note?translateError(record.note,{fallback:t('Исторических снимков пока нет.')},language):t('Исторических снимков пока нет.');
  }
}
