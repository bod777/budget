/**
 * Budget periods run payday to payday, not calendar month to calendar month.
 *
 * A period is named for the month it ends in, matching the spreadsheets it
 * replaces: the "July 2026" budget covered 26 June to 31 July, because pay
 * landed on Friday 26 June (the 28th was a Sunday) and again on 31 July.
 *
 * The end is exclusive, so the next payday belongs to the next period and no
 * day is counted twice.
 */
import { previousWorkingDay } from './irish-holidays.ts';

export interface PayRule {
  /** First of the month from which this rule applies. */
  effectiveFrom: string;
  /** 'last' for the last day of the month, otherwise a day of the month. */
  dayRule: 'last' | number;
  note?: string | null;
}

export interface Period {
  /** Month the period is named for, YYYY-MM. */
  month: string;
  /** Inclusive. */
  start: string;
  /** Exclusive. */
  end: string;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseMonth(month: string): { year: number; month: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { year: y, month: m };
}

export function shiftMonth(month: string, delta: number): string {
  const { year, month: m } = parseMonth(month);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ruleFor(rules: PayRule[], month: string): PayRule {
  const target = `${month}-01`;
  const applicable = rules
    .filter((rule) => rule.effectiveFrom <= target)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const rule = applicable[applicable.length - 1] ?? rules[0];
  if (!rule) throw new Error('no pay rule configured');
  return rule;
}

/**
 * The day pay actually lands for a given month: the nominal day, moved back to
 * the previous working day when it falls on a weekend or bank holiday.
 */
export function paydayFor(month: string, rules: PayRule[]): string {
  const { year, month: m } = parseMonth(month);
  const rule = ruleFor(rules, month);
  const last = daysInMonth(year, m);
  const nominalDay = rule.dayRule === 'last' ? last : Math.min(rule.dayRule, last);
  return previousWorkingDay(iso(year, m, nominalDay));
}

/** The period named for `month`: from the previous payday up to this one. */
export function periodFor(month: string, rules: PayRule[]): Period {
  return {
    month,
    start: paydayFor(shiftMonth(month, -1), rules),
    end: paydayFor(month, rules),
  };
}

/** The period a given date falls inside. */
export function periodContaining(date: string, rules: PayRule[]): Period {
  const month = date.slice(0, 7);
  // The date's own month is the natural first guess, but a date on or after
  // that month's payday belongs to the next period, and one before the
  // previous payday to an earlier period.
  for (const delta of [0, 1, -1, 2, -2]) {
    const candidate = periodFor(shiftMonth(month, delta), rules);
    if (date >= candidate.start && date < candidate.end) return candidate;
  }
  return periodFor(month, rules);
}

/** Every period between two dates, oldest first. */
export function periodsBetween(from: string, to: string, rules: PayRule[]): Period[] {
  const first = periodContaining(from, rules);
  const last = periodContaining(to, rules);
  const periods: Period[] = [];
  let cursor = first.month;
  for (let guard = 0; guard < 600; guard++) {
    periods.push(periodFor(cursor, rules));
    if (cursor === last.month) break;
    cursor = shiftMonth(cursor, 1);
  }
  return periods;
}
