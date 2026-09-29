/**
 * Tests for the fiddly pure logic: date recurrence and import coercion.
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorForFirstDue, occurrencesBetween } from '../src/lib/recurrence.ts';
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
    'Anthropic',
    'Anthropic',
    'Antrophic',
    'Costa',
    'Coasta',
  ]);
  assert.equal(canonical.get('anthropic'), 'Anthropic');
  assert.equal(canonical.get('antrophic'), 'Anthropic');
  assert.equal(canonical.get('coasta'), 'Costa');
});

test('aliases passed in replace the built-in table', () => {
  // A transposition too short for the fuzzy pass, so only an alias merges it.
  const aliases = { 'pat muprhy': 'Pat Murphy', 'pat murphy': 'Pat Murphy' };
  const { canonical } = buildCanonicalNames(['Pat Murphy', 'Pat Muprhy', 'Antrophic'], aliases);
  assert.equal(canonical.get('pat muprhy'), 'Pat Murphy');
  // The built-in table no longer applies once a different one is given.
  assert.equal(canonical.get('antrophic'), 'Antrophic');
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

test('a one-off typo does not become the canonical spelling', () => {
  // Each spelling appears once, so frequency cannot decide. Alphabetical order
  // would pick the typo in both of these.
  const { canonical } = buildCanonicalNames([
    'Circle K Grafton Street',
    'Circle K Grafton Steet',
    'The Lighthouse',
    'The Lighthous',
    "Conn's Cameras",
    "Conn's camera",
  ]);
  assert.equal(canonical.get('circle k grafton street'), 'Circle K Grafton Street');
  assert.equal(canonical.get('circle k grafton steet'), 'Circle K Grafton Street');
  assert.equal(canonical.get('the lighthouse'), 'The Lighthouse');
  assert.equal(canonical.get('the lighthous'), 'The Lighthouse');
  // Conn's is in the explicit alias table; apostrophes key as a space.
  assert.equal(canonical.get('conn s cameras'), "Conn's Camera");
  assert.equal(canonical.get('conn s camera'), "Conn's Camera");
});

test('a stray plural merges, but a one-letter substitution never does', () => {
  const { canonical } = buildCanonicalNames([
    ...Array(55).fill('Tesco'),
    ...Array(4).fill('Tescos'),
    ...Array(8).fill('Easons'),
    ...Array(3).fill('Eason'),
    // Genuinely different businesses that differ by one letter.
    'Aldi',
    'Aldo',
    'Lush',
    'Luas',
  ]);
  assert.equal(canonical.get('tesco'), 'Tesco');
  assert.equal(canonical.get('tescos'), 'Tesco');
  assert.equal(canonical.get('easons'), 'Easons');
  assert.equal(canonical.get('eason'), 'Easons');
  assert.equal(canonical.get('aldi'), 'Aldi');
  assert.equal(canonical.get('aldo'), 'Aldo');
  assert.equal(canonical.get('lush'), 'Lush');
  assert.equal(canonical.get('luas'), 'Luas');
});

test('capitalisation outranks length when picking a spelling', () => {
  const { canonical } = buildCanonicalNames(['Aircoach', 'Air coach']);
  assert.equal(canonical.get('aircoach'), 'Aircoach');
  assert.equal(canonical.get('air coach'), 'Aircoach');
});

test('every Marks & Spencer variant lands on one name', () => {
  const { canonical } = buildCanonicalNames([
    'M&S',
    'Marks & Spencer',
    'Marks & Spencers',
    "Marks & Spencer's",
  ]);
  for (const key of ['m s', 'marks spencer', 'marks spencers', 'marks spencer s']) {
    assert.equal(canonical.get(key), 'Marks & Spencer');
  }
});

test('trailing whitespace alone does not create a second payee', () => {
  const { canonical } = buildCanonicalNames(['Acme Insurance', 'Acme Insurance ', '48 Mobile ']);
  assert.equal(canonical.get('acme insurance'), 'Acme Insurance');
  assert.equal(canonical.get('48 mobile'), '48 Mobile');
});

/**
 * The round trip that matters: an anchor derived from a wanted first date must
 * actually produce that date, or a standing order set up by hand silently
 * skips its first payment.
 */
function firstDue(cadence: Parameters<typeof occurrencesBetween>[0], wanted: string): string {
  const anchor = anchorForFirstDue(cadence, wanted);
  return occurrencesBetween(cadence, anchor, anchor, '2030-01-01')[0]!;
}

test('an anchor derived from the wanted first date produces that date', () => {
  assert.equal(firstDue('weekly', '2026-11-05'), '2026-11-05');
  assert.equal(firstDue('fortnightly', '2026-11-05'), '2026-11-05');
  assert.equal(firstDue('monthly', '2026-11-01'), '2026-11-01');
  assert.equal(firstDue('monthly', '2026-11-28'), '2026-11-28');
  assert.equal(firstDue('yearly', '2026-11-05'), '2026-11-05');
});

test('stepping back a month crosses the year boundary', () => {
  assert.equal(anchorForFirstDue('monthly', '2026-01-15'), '2025-12-15');
  assert.equal(anchorForFirstDue('yearly', '2026-01-15'), '2025-01-15');
});

test('a monthly anchor clamps to the length of the month it steps back into', () => {
  // 31 March steps back to 28 February, so the rule then falls due on the
  // 28th. The form previews the dates because of exactly this.
  assert.equal(anchorForFirstDue('monthly', '2026-03-31'), '2026-02-28');
  assert.equal(firstDue('monthly', '2026-03-31'), '2026-03-28');
  // A leap year has the 29th to land on.
  assert.equal(anchorForFirstDue('monthly', '2028-03-31'), '2028-02-29');
});

test('a yearly anchor clamps 29 February back to the 28th', () => {
  assert.equal(anchorForFirstDue('yearly', '2028-02-29'), '2027-02-28');
});
