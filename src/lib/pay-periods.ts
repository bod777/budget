/**
 * Budget periods run payday to payday, not calendar month to calendar month.
 *
 * A period is named for the month it ends in, matching the spreadsheets it
 * replaces: the "July 2026" budget covered 26 June to 31 July, because pay
 * landed on Friday 26 June (the 28th was a Sunday) and again on 31 July.
 *
 * The end is exclusive, so the next payday belongs to the next period and no
 * day is counted twice.
 *
 * Where pay landed somewhere other than the rule predicts -- paid early before
 * a bank holiday weekend, say -- that single month is recorded as an override
 * rather than by changing the rule, which would move every later period too.
 */
import { previousWorkingDay } from './irish-holidays.ts';

export interface PayRule {
  /** First of the month from which this rule applies. */
  effectiveFrom: string;
  /** 'last' for the last day of the month, otherwise a day of the month. */
  dayRule: 'last' | number;
  note?: string | null;
}

/**
 * A month where pay actually landed somewhere other than the rule says --
 * paid early before Christmas, say. Recorded per month, because it is a fact
 * about that month rather than a change of schedule.
 */
export interface PayOverride {
  /** Month whose payday moved, YYYY-MM. */
  month: string;
  /** The date pay actually arrived. Taken literally. */
  paidOn: string;
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
 *
 * A recorded override for the month wins outright and is not shifted -- it is
 * the observed date, not one derived from a rule.
 */
export function paydayFor(month: string, rules: PayRule[], overrides: PayOverride[] = []): string {
  const override = overrides.find((entry) => entry.month === month);
  if (override) return override.paidOn;

  const { year, month: m } = parseMonth(month);
  const rule = ruleFor(rules, month);
  const last = daysInMonth(year, m);
  const nominalDay = rule.dayRule === 'last' ? last : Math.min(rule.dayRule, last);
  return previousWorkingDay(iso(year, m, nominalDay));
}

/** The period named for `month`: from the previous payday up to this one. */
export function periodFor(month: string, rules: PayRule[], overrides: PayOverride[] = []): Period {
  return {
    month,
    start: paydayFor(shiftMonth(month, -1), rules, overrides),
    end: paydayFor(month, rules, overrides),
  };
}

/** The period a given date falls inside. */
export function periodContaining(
  date: string,
  rules: PayRule[],
  overrides: PayOverride[] = [],
): Period {
  const month = date.slice(0, 7);
  // The date's own month is the natural first guess, but a date on or after
  // that month's payday belongs to the next period, and one before the
  // previous payday to an earlier period.
  for (const delta of [0, 1, -1, 2, -2]) {
    const candidate = periodFor(shiftMonth(month, delta), rules, overrides);
    if (date >= candidate.start && date < candidate.end) return candidate;
  }
  return periodFor(month, rules, overrides);
}

/** Every period between two dates, oldest first. */
export function periodsBetween(
  from: string,
  to: string,
  rules: PayRule[],
  overrides: PayOverride[] = [],
): Period[] {
  const first = periodContaining(from, rules, overrides);
  const last = periodContaining(to, rules, overrides);
  const periods: Period[] = [];
  let cursor = first.month;
  for (let guard = 0; guard < 600; guard++) {
    periods.push(periodFor(cursor, rules, overrides));
    if (cursor === last.month) break;
    cursor = shiftMonth(cursor, 1);
  }
  return periods;
}

/**
 * Which month's payday a given date represents.
 *
 * Judged by nearness to the scheduled paydays around it, because the calendar
 * month is not reliable on its own: pay landing on 1 September is August's
 * arriving a day late, not September's arriving twenty-nine days early.
 *
 * Existing overrides are deliberately ignored, so re-recording a payday that
 * has already been moved still resolves to the same month rather than being
 * pulled toward wherever it was last put.
 */
export function paydayMonthFor(date: string, rules: PayRule[]): string {
  const month = date.slice(0, 7);
  let best = month;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const delta of [-1, 0, 1]) {
    const candidate = shiftMonth(month, delta);
    const distance = Math.abs(Date.parse(paydayFor(candidate, rules)) - Date.parse(date));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
