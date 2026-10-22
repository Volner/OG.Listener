const DAY = 86400000;

/** Calendar dates are UTC throughout the history filters. Invalid dates stay invalid. */
export function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match || Number(match[1]) < 1) return null;
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return calendarDate(result) === value ? result : null;
}

export function calendarDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getUTCFullYear() >= 1 && value.getUTCFullYear() <= 9999 ? value.toISOString().slice(0, 10) : '';
}

export function calendarBounds(minDate, maxDate) {
  let min = parseCalendarDate(minDate) ? minDate : '';
  let max = parseCalendarDate(maxDate) ? maxDate : '';
  if (min && max && min > max) [min, max] = [max, min];
  return { min, max };
}

export function clampCalendarDate(value, minDate, maxDate) {
  if (!parseCalendarDate(value)) return '';
  const { min, max } = calendarBounds(minDate, maxDate);
  return min && value < min ? min : max && value > max ? max : value;
}

export function addCalendarDays(value, amount) {
  const parsed = parseCalendarDate(value);
  return parsed ? calendarDate(new Date(parsed.getTime() + amount * DAY)) : '';
}

export function calendarMonth(value) {
  return parseCalendarDate(value) ? `${value.slice(0, 7)}-01` : '';
}

export function calendarMonthEnd(value) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return '';
  parsed.setUTCMonth(parsed.getUTCMonth() + 1, 0);
  return calendarDate(parsed);
}

export function shiftCalendarMonth(value, amount) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return '';
  const wantedDay = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + amount);
  const month = calendarDate(parsed);
  if (!month) return '';
  parsed.setUTCDate(Math.min(wantedDay, Number(calendarMonthEnd(month).slice(-2))));
  return calendarDate(parsed);
}

export function calendarMonthAvailable(value, minDate, maxDate) {
  const month = calendarMonth(value);
  if (!month) return false;
  const { min, max } = calendarBounds(minDate, maxDate);
  return (!min || calendarMonthEnd(month) >= min) && (!max || month <= max);
}

export function calendarMonthDays(value) {
  const first = calendarMonth(value);
  const parsed = parseCalendarDate(first);
  if (!parsed) return [];
  const offset = (parsed.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => addCalendarDays(first, index - offset));
}

export function selectCalendarRange(value, day) {
  if (!parseCalendarDate(day)) return { from: value?.from || '', to: value?.to || '' };
  const from = parseCalendarDate(value?.from) ? value.from : '';
  if (!from || parseCalendarDate(value?.to)) return { from: day, to: '' };
  return from <= day ? { from, to: day } : { from: day, to: from };
}

export function calendarKeyDate(value, key) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return '';
  const weekday = (parsed.getUTCDay() + 6) % 7;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[key];
  if (offset !== undefined) return addCalendarDays(value, offset);
  if (key === 'PageUp' || key === 'PageDown') return shiftCalendarMonth(value, key === 'PageUp' ? -1 : 1);
  return value;
}
