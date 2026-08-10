/**
 * Tests for the fiddly pure logic: date recurrence and import coercion.
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrencesBetween } from '../src/lib/recurrence.ts';
import {
  buildCanonicalNames,
  parseAmount,
  parseFormDate,
  parseFormTimestamp,
} from '../scripts/lib/normalise.ts';
import { parseCsvRecords } from '../scripts/lib/csv.ts';

test('weekly recurrence lands on the anchor weekday', () => {
  // 2026-08-01 is a Saturday.
  const dates = occurrencesBetween('weekly', '2026-08-01', '2026-08-01', '2026-08-31');
  assert.deepEqual(dates, ['2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']);
});

test('weekly recurrence excludes the boundary it starts after', () => {
  const dates = occurrencesBetween('weekly', '2026-08-01', '2026-08-08', '2026-08-20');
  assert.deepEqual(dates, ['2026-08-15']);
});

test('fortnightly steps by 14 days', () => {
  const dates = occurrencesBetween('fortnightly', '2026-01-05', '2026-01-05', '2026-02-20');
  assert.deepEqual(dates, ['2026-01-19', '2026-02-02', '2026-02-16']);
});

test('monthly recurrence keeps the day of month', () => {
  const dates = occurrencesBetween('monthly', '2026-03-02', '2026-03-02', '2026-06-30');
  assert.deepEqual(dates, ['2026-04-02', '2026-05-02', '2026-06-02']);
});

test('monthly recurrence clamps to short months rather than skipping them', () => {
  // Anchored on the 31st: February must still fire, on the 28th.
  const dates = occurrencesBetween('monthly', '2026-01-31', '2026-01-31', '2026-04-30');
  assert.deepEqual(dates, ['2026-02-28', '2026-03-31', '2026-04-30']);
});

test('yearly recurrence repeats the month and day', () => {
  const dates = occurrencesBetween('yearly', '2024-08-03', '2024-08-03', '2027-01-01');
  assert.deepEqual(dates, ['2025-08-03', '2026-08-03']);
});

test('recurrence never produces dates before its anchor', () => {
  const dates = occurrencesBetween('monthly', '2026-06-15', '2026-01-01', '2026-08-31');
  assert.deepEqual(dates, ['2026-07-15', '2026-08-15']);
});

test('the anchor itself never fires, so automating a logged item cannot re-log it', () => {
  // Anchoring on the most recent gym payment must not produce that same date.
  assert.deepEqual(occurrencesBetween('weekly', '2026-08-08', '2026-06-11', '2026-08-10'), []);
  assert.deepEqual(occurrencesBetween('monthly', '2026-08-02', '2026-06-11', '2026-08-10'), []);
  assert.deepEqual(occurrencesBetween('yearly', '2026-08-03', '2026-06-11', '2026-08-10'), []);
});

test('amounts parse across the formats used in the sheets', () => {
  assert.equal(parseAmount('€49.00'), 49);
  assert.equal(parseAmount('49'), 49);
  assert.equal(parseAmount('€1,394.77'), 1394.77);
  assert.equal(parseAmount('4,321.09'), 4321.09);
  assert.equal(parseAmount('  € 22.14 '), 22.14);
  assert.equal(parseAmount('1,250'), 1250);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('n/a'), null);
});

test('dates parse as day-first and reject impossible ones', () => {
  assert.equal(parseFormDate('08/08/2026'), '2026-08-08');
  assert.equal(parseFormDate('3/7/2026'), '2026-07-03');
  assert.equal(parseFormDate('31/02/2026'), null);
  assert.equal(parseFormDate('not a date'), null);
});

test('timestamps keep the time of entry', () => {
  assert.equal(parseFormTimestamp('29/07/2026 08:06:29'), '2026-07-29T08:06:29');
  assert.equal(parseFormTimestamp('29/07/2026'), '2026-07-29T00:00:00');
});

test('csv handles quoted fields containing commas', () => {
  const rows = parseCsvRecords(
    'Date,Description,Amount\n26/07/2026,"Ice cream, Water, Coke",5.25\n',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.Description, 'Ice cream, Water, Coke');
  assert.equal(rows[0]!.Amount, '5.25');
});

test('payee variants collapse to the canonical spelling', () => {
  const { canonical } = buildCanonicalNames([
    'Flex Gym',
    'Flex Gym',
    'Felx Gym',
    'Anthropic',
    'Antrophic',
    'Pat Murphy',
    'Pat Muprhy',
  ]);
  assert.equal(canonical.get('flex gym'), 'Flex Gym');
  assert.equal(canonical.get('felx gym'), 'Flex Gym');
  assert.equal(canonical.get('antrophic'), 'Anthropic');
  assert.equal(canonical.get('pat muprhy'), 'Pat Murphy');
});

test('distinct payees are never merged by the fuzzy pass', () => {
  const { canonical } = buildCanonicalNames([
    'Aldi',
    'Lidl',
    'Mary Egan',
    'Mary Crean',
    'Mary Egan',
  ]);
  assert.equal(canonical.get('aldi'), 'Aldi');
  assert.equal(canonical.get('lidl'), 'Lidl');
  assert.equal(canonical.get('mary egan'), 'Mary Egan');
  assert.equal(canonical.get('mary crean'), 'Mary Crean');
});

test('trailing whitespace alone does not create a second payee', () => {
  const { canonical } = buildCanonicalNames(['Acme Insurance', 'Acme Insurance ', '48 Mobile ']);
  assert.equal(canonical.get('acme insurance'), 'Acme Insurance');
  assert.equal(canonical.get('48 mobile'), '48 Mobile');
});
