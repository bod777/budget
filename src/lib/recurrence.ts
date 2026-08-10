/**
 * Pure recurrence maths, kept free of database imports so it can be tested
 * directly.
 */

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'yearly';

export const CADENCES: Cadence[] = ['weekly', 'fortnightly', 'monthly', 'yearly'];

export function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/**
 * Coerces a date coming back from Postgres to a UTC-midnight timestamp.
 * Scalar `date` columns arrive as ISO strings (see the type parser in db.ts)
 * but `array_agg(date)` bypasses it and yields Date objects, so both shapes
 * have to be handled or every interval comes out NaN.
 */
export function dateToTime(value: unknown): number {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  return parseIso(String(value).slice(0, 10)).getTime();
}

/**
 * Dates on which a rule falls due, strictly after both `after` and the anchor,
 * up to and including `until`.
 *
 * The anchor is exclusive because rules are nearly always created from a
 * pattern already present in the history, with the anchor set to the most
 * recent occurrence. Including it would immediately re-log an entry that has
 * already been recorded.
 *
 * Monthly rules clamp to the end of short months, so a rule anchored on the
 * 31st still fires in February rather than skipping it.
 */
export function occurrencesBetween(
  cadence: Cadence,
  anchorIso: string,
  after: string,
  until: string,
): string[] {
  const anchor = parseIso(anchorIso);
  const untilDate = parseIso(until);
  // Nothing before the anchor can be due, whatever `after` says.
  const from = Math.max(parseIso(after).getTime(), anchor.getTime());
  const results: string[] = [];

  if (cadence === 'weekly' || cadence === 'fortnightly') {
    const step = cadence === 'weekly' ? 7 : 14;
    const dayMs = 86_400_000;
    let cursor = anchor.getTime();
    if (cursor <= from) {
      const stepsBehind = Math.floor((from - cursor) / (step * dayMs)) + 1;
      cursor += stepsBehind * step * dayMs;
    }
    while (cursor <= untilDate.getTime()) {
      results.push(toIso(new Date(cursor)));
      cursor += step * dayMs;
    }
    return results;
  }

  const fromDate = new Date(from);

  if (cadence === 'monthly') {
    const anchorDay = anchor.getUTCDate();
    let year = fromDate.getUTCFullYear();
    let month = fromDate.getUTCMonth();
    for (let guard = 0; guard < 480; guard++) {
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = new Date(Date.UTC(year, month, Math.min(anchorDay, daysInMonth)));
      if (candidate.getTime() > untilDate.getTime()) break;
      if (candidate.getTime() > from) results.push(toIso(candidate));
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return results;
  }

  // yearly
  const anchorMonth = anchor.getUTCMonth();
  const anchorDay = anchor.getUTCDate();
  for (let year = fromDate.getUTCFullYear(); year <= untilDate.getUTCFullYear() + 1; year += 1) {
    const daysInMonth = new Date(Date.UTC(year, anchorMonth + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(year, anchorMonth, Math.min(anchorDay, daysInMonth)));
    if (candidate.getTime() > untilDate.getTime()) break;
    if (candidate.getTime() > from) results.push(toIso(candidate));
  }
  return results;
}
