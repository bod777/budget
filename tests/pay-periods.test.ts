import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  irishPublicHolidays,
  previousWorkingDay,
  isWorkingDay,
} from '../src/lib/irish-holidays.ts';
import {
  paydayFor,
  paydayMonthFor,
  periodContaining,
  periodFor,
  type PayOverride,
  type PayRule,
} from '../src/lib/pay-periods.ts';

// A schedule that changed with a change of job: the 28th, then the last day.
const RULES: PayRule[] = [
  { effectiveFrom: '2000-01-01', dayRule: 28 },
  { effectiveFrom: '2026-07-01', dayRule: 'last' },
];

test('Easter Monday is found correctly', () => {
  // Easter Sunday 2026 is 5 April, 2027 is 28 March.
  assert.ok(irishPublicHolidays(2026).has('2026-04-06'));
  assert.ok(irishPublicHolidays(2027).has('2027-03-29'));
});

test('the standard Irish holidays are present', () => {
  const holidays = irishPublicHolidays(2026);
  assert.ok(holidays.has('2026-01-01'), 'New Year');
  assert.ok(holidays.has('2026-03-17'), 'St Patrick');
  assert.ok(holidays.has('2026-05-04'), 'first Monday in May');
  assert.ok(holidays.has('2026-06-01'), 'first Monday in June');
  assert.ok(holidays.has('2026-08-03'), 'first Monday in August');
  assert.ok(holidays.has('2026-10-26'), 'last Monday in October');
  assert.ok(holidays.has('2026-12-25'), 'Christmas');
  assert.ok(holidays.has('2026-12-26'), 'St Stephen');
});

test('a weekend Christmas produces substitute weekdays', () => {
  // 2027: 25 Dec is a Saturday and 26 Dec a Sunday, so the Monday and Tuesday
  // are taken instead -- which lands a bank holiday on the 28th.
  const holidays = irishPublicHolidays(2027);
  assert.ok(holidays.has('2027-12-27'));
  assert.ok(holidays.has('2027-12-28'));
});

test('previousWorkingDay steps back over weekends and holidays', () => {
  // Sunday 28 June 2026 -> Friday 26 June.
  assert.equal(previousWorkingDay('2026-06-28'), '2026-06-26');
  // A working day is returned untouched.
  assert.equal(previousWorkingDay('2026-07-31'), '2026-07-31');
  // Christmas Day 2026 is a Friday, so pay would land on Thursday the 24th.
  assert.equal(previousWorkingDay('2026-12-25'), '2026-12-24');
  assert.ok(isWorkingDay('2026-07-31'));
});

test('paydays match the ones observed in the spreadsheets', () => {
  // The first job: the 28th, moved back when it fell at a weekend.
  assert.equal(paydayFor('2026-01', RULES), '2026-01-28'); // Wednesday
  assert.equal(paydayFor('2026-02', RULES), '2026-02-27'); // 28th was a Saturday
  assert.equal(paydayFor('2026-03', RULES), '2026-03-27'); // 28th was a Saturday
  assert.equal(paydayFor('2026-04', RULES), '2026-04-28'); // Tuesday
  assert.equal(paydayFor('2026-05', RULES), '2026-05-28'); // Thursday
  assert.equal(paydayFor('2026-06', RULES), '2026-06-26'); // 28th was a Sunday
  // The second job: the last working day of the month.
  assert.equal(paydayFor('2026-07', RULES), '2026-07-31'); // Friday
  assert.equal(paydayFor('2026-08', RULES), '2026-08-31'); // Monday
});

test('the periods match the spreadsheet boundaries exactly', () => {
  // "2026 Budget - 7 July" recorded 26-6-2026 to 31-7-2026.
  assert.deepEqual(periodFor('2026-07', RULES), {
    month: '2026-07',
    start: '2026-06-26',
    end: '2026-07-31',
  });
  // The August sheet recorded 31-7-2026 to 31-8-2026.
  assert.deepEqual(periodFor('2026-08', RULES), {
    month: '2026-08',
    start: '2026-07-31',
    end: '2026-08-31',
  });
});

test('the last day rule falls back over a weekend', () => {
  // 31 May 2026 is a Sunday, so pay lands on Friday the 29th.
  const lastDayOnly: PayRule[] = [{ effectiveFrom: '2000-01-01', dayRule: 'last' }];
  assert.equal(paydayFor('2026-05', lastDayOnly), '2026-05-29');
  // February is short; 'last' must not overshoot.
  assert.equal(paydayFor('2027-02', lastDayOnly), '2027-02-26'); // 28th is a Sunday
});

test('a payday belongs to the period it opens, not the one it closes', () => {
  // The salary paid on 31 July funds August, matching the workbook where that
  // payment appears in the August sheet.
  assert.equal(periodContaining('2026-07-31', RULES).month, '2026-08');
  // The day before still belongs to July.
  assert.equal(periodContaining('2026-07-30', RULES).month, '2026-07');
  // A date mid-period.
  assert.equal(periodContaining('2026-08-09', RULES).month, '2026-08');
  // The day before the August payday closes August.
  assert.equal(periodContaining('2026-08-30', RULES).month, '2026-08');
  assert.equal(periodContaining('2026-08-31', RULES).month, '2026-09');
});

test('periods are contiguous and never overlap', () => {
  let previous = periodFor('2024-01', RULES);
  for (let i = 1; i <= 48; i++) {
    const month = periodFor(
      `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      RULES,
    );
    if (month.month === previous.month) continue;
    assert.equal(month.start, previous.end, `${previous.month} -> ${month.month} must join up`);
    assert.ok(month.end > month.start, `${month.month} must not be empty`);
    previous = month;
  }
});

// August 2026 pay landed on Friday the 28th rather than Monday the 31st.
const PAID_EARLY: PayOverride[] = [{ month: '2026-08', paidOn: '2026-08-28' }];

test('a one-off pay date overrides the rule for that month alone', () => {
  assert.equal(paydayFor('2026-08', RULES, PAID_EARLY), '2026-08-28');
  // Neither neighbour moves.
  assert.equal(paydayFor('2026-07', RULES, PAID_EARLY), '2026-07-31');
  assert.equal(paydayFor('2026-09', RULES, PAID_EARLY), '2026-09-30');
});

test('a one-off is taken literally, not shifted to a working day', () => {
  // Someone recording a Saturday means that Saturday, not the Friday before.
  const onASaturday: PayOverride[] = [{ month: '2026-08', paidOn: '2026-08-29' }];
  assert.equal(paydayFor('2026-08', RULES, onASaturday), '2026-08-29');
});

test('moving a payday closes one period early and opens the next early', () => {
  assert.deepEqual(periodFor('2026-08', RULES, PAID_EARLY), {
    month: '2026-08',
    start: '2026-07-31',
    end: '2026-08-28',
  });
  assert.deepEqual(periodFor('2026-09', RULES, PAID_EARLY), {
    month: '2026-09',
    start: '2026-08-28',
    end: '2026-09-30',
  });
  // Still contiguous: nothing is counted twice or dropped.
  assert.equal(
    periodFor('2026-08', RULES, PAID_EARLY).end,
    periodFor('2026-09', RULES, PAID_EARLY).start,
  );
});

test('spending after an early payday counts against the new period', () => {
  // 28-30 August would have belonged to August; the early pay moves them.
  assert.equal(periodContaining('2026-08-27', RULES, PAID_EARLY).month, '2026-08');
  assert.equal(periodContaining('2026-08-28', RULES, PAID_EARLY).month, '2026-09');
  assert.equal(periodContaining('2026-08-31', RULES, PAID_EARLY).month, '2026-09');
  // Without the override those same days sit either side of the 31st.
  assert.equal(periodContaining('2026-08-28', RULES).month, '2026-08');
});

test('a payday date resolves to the month whose pay it is', () => {
  // Under the "last day" rule August's pay is due on the 31st.
  assert.equal(paydayMonthFor('2026-08-28', RULES), '2026-08');
  assert.equal(paydayMonthFor('2026-08-31', RULES), '2026-08');
  // Arriving a day late is still August's pay, not September's.
  assert.equal(paydayMonthFor('2026-09-01', RULES), '2026-08');
  // Well into September it is September's.
  assert.equal(paydayMonthFor('2026-09-29', RULES), '2026-09');
  // Under the 28th rule, before the switch.
  assert.equal(paydayMonthFor('2026-05-28', RULES), '2026-05');
  assert.equal(paydayMonthFor('2026-06-26', RULES), '2026-06');
});
