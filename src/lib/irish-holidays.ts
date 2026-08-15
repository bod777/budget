/**
 * Irish public holidays, used to decide when a payday falls back to an earlier
 * working day.
 *
 * Computed rather than listed so the app keeps working in future years without
 * anyone maintaining a table of dates.
 */

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Meeus/Jones/Butcher Gregorian Easter algorithm. */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** nth (1-based) given weekday of a month; pass -1 for the last one. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  if (nth > 0) {
    const first = iso(year, month, 1);
    const shift = (weekday - dayOfWeek(first) + 7) % 7;
    return addDays(first, shift + (nth - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = iso(year, month, lastDay);
  const shift = (dayOfWeek(last) - weekday + 7) % 7;
  return addDays(last, -shift);
}

/**
 * The dates banks and offices are actually closed, including the substitute
 * weekdays given when a fixed-date holiday lands on a weekend.
 */
export function irishPublicHolidays(year: number): Set<string> {
  const observed = new Set<string>();
  const fixed: string[] = [
    iso(year, 1, 1), // New Year's Day
    iso(year, 3, 17), // St Patrick's Day
    iso(year, 12, 25), // Christmas Day
    iso(year, 12, 26), // St Stephen's Day
  ];

  const moveable: string[] = [
    addDays(easterSunday(year), 1), // Easter Monday
    nthWeekdayOfMonth(year, 5, 1, 1), // first Monday in May
    nthWeekdayOfMonth(year, 6, 1, 1), // first Monday in June
    nthWeekdayOfMonth(year, 8, 1, 1), // first Monday in August
    nthWeekdayOfMonth(year, 10, 1, -1), // last Monday in October
  ];

  // St Brigid's Day, from 2023: the first Monday in February, unless the 1st
  // is a Friday, in which case the 1st itself.
  if (year >= 2023) {
    const first = iso(year, 2, 1);
    moveable.push(dayOfWeek(first) === 5 ? first : nthWeekdayOfMonth(year, 2, 1, 1));
  }

  for (const date of moveable) observed.add(date);

  // Fixed dates falling at a weekend are taken on the next free weekday, so a
  // Saturday Christmas and Sunday St Stephen's become the Monday and Tuesday.
  for (const date of fixed) {
    observed.add(date);
    if (dayOfWeek(date) !== 0 && dayOfWeek(date) !== 6) continue;
    let substitute = addDays(date, 1);
    while (dayOfWeek(substitute) === 0 || dayOfWeek(substitute) === 6 || observed.has(substitute)) {
      substitute = addDays(substitute, 1);
    }
    observed.add(substitute);
  }

  return observed;
}

const cache = new Map<number, Set<string>>();

export function isIrishPublicHoliday(isoDate: string): boolean {
  const year = Number(isoDate.slice(0, 4));
  let holidays = cache.get(year);
  if (!holidays) {
    holidays = irishPublicHolidays(year);
    cache.set(year, holidays);
  }
  return holidays.has(isoDate);
}

export function isWeekend(isoDate: string): boolean {
  const day = dayOfWeek(isoDate);
  return day === 0 || day === 6;
}

export function isWorkingDay(isoDate: string): boolean {
  return !isWeekend(isoDate) && !isIrishPublicHoliday(isoDate);
}

/** Steps back to the nearest working day, returning `isoDate` if it is one. */
export function previousWorkingDay(isoDate: string): string {
  let cursor = isoDate;
  // Bounded so a bad holiday table can never spin forever.
  for (let guard = 0; guard < 30 && !isWorkingDay(cursor); guard++) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}
