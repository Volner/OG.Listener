import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays, calendarBounds, calendarKeyDate, calendarMonthAvailable, calendarMonthDays,
  calendarMonthEnd, clampCalendarDate, parseCalendarDate, selectCalendarRange, shiftCalendarMonth,
} from '../src/lib/date-range.js';

test('calendar dates reject invalid days and accept leap days without local timezone shifts', () => {
  assert.equal(parseCalendarDate('2024-02-29').toISOString(), '2024-02-29T00:00:00.000Z');
  for (const value of ['2023-02-29', '2026-02-31', '2026-13-01', '2026-00-10', '2026-10-00', '0000-01-01', '2026-1-01', '']) assert.equal(parseCalendarDate(value), null);
  assert.equal(addCalendarDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
});

test('month changes clamp the day instead of overflowing February', () => {
  assert.equal(shiftCalendarMonth('2024-03-31', -1), '2024-02-29');
  assert.equal(shiftCalendarMonth('2023-01-31', 1), '2023-02-28');
  assert.equal(shiftCalendarMonth('2026-12-15', 1), '2027-01-15');
  assert.equal(calendarMonthEnd('2024-02-10'), '2024-02-29');
});

test('month grid has six Monday-first weeks and includes adjacent month days', () => {
  const days = calendarMonthDays('2026-10-22');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2026-09-28');
  assert.equal(days.at(-1), '2026-11-08');
  assert.equal(parseCalendarDate(days[0]).getUTCDay(), 1);
  assert.equal(calendarMonthDays('2021-02-01')[0], '2021-02-01');
});

test('range selection supports reverse order, a single day and beginning a new range', () => {
  assert.deepEqual(selectCalendarRange({ from: '', to: '' }, '2026-10-20'), { from: '2026-10-20', to: '' });
  assert.deepEqual(selectCalendarRange({ from: '2026-10-20', to: '' }, '2026-10-10'), { from: '2026-10-10', to: '2026-10-20' });
  assert.deepEqual(selectCalendarRange({ from: '2026-10-20', to: '' }, '2026-10-20'), { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(selectCalendarRange({ from: '2026-10-10', to: '2026-10-20' }, '2026-11-01'), { from: '2026-11-01', to: '' });
});

test('bounds clamp keyboard navigation and disable only months entirely outside the archive', () => {
  assert.deepEqual(calendarBounds('2026-10-20', '2019-02-10'), { min: '2019-02-10', max: '2026-10-20' });
  assert.equal(clampCalendarDate('2018-01-01', '2019-02-10', '2026-10-20'), '2019-02-10');
  assert.equal(clampCalendarDate('2027-01-01', '2019-02-10', '2026-10-20'), '2026-10-20');
  assert.equal(calendarMonthAvailable('2019-02-01', '2019-02-10', '2026-10-20'), true);
  assert.equal(calendarMonthAvailable('2019-01-01', '2019-02-10', '2026-10-20'), false);
  assert.equal(calendarMonthAvailable('2026-11-01', '2019-02-10', '2026-10-20'), false);
});

test('keyboard arrows, Monday/Sunday boundaries and page navigation keep calendar semantics', () => {
  assert.equal(calendarKeyDate('2026-10-22', 'ArrowLeft'), '2026-10-21');
  assert.equal(calendarKeyDate('2026-10-22', 'ArrowRight'), '2026-10-23');
  assert.equal(calendarKeyDate('2026-10-22', 'ArrowUp'), '2026-10-15');
  assert.equal(calendarKeyDate('2026-10-22', 'ArrowDown'), '2026-10-29');
  assert.equal(calendarKeyDate('2026-10-22', 'Home'), '2026-10-19');
  assert.equal(calendarKeyDate('2026-10-22', 'End'), '2026-10-25');
  assert.equal(calendarKeyDate('2026-03-31', 'PageUp'), '2026-02-28');
  assert.equal(calendarKeyDate('2026-12-31', 'PageDown'), '2027-01-31');
});
