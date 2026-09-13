/**
 * Coercion and cleanup for the Google Form exports.
 *
 * The response sheets accumulated three kinds of mess over ~3 years:
 *   - amounts stored inconsistently ("€1,394.77", "1394.77", "30")
 *   - dates as DD/MM/YYYY text
 *   - the same payee spelled several ways (Anthropic / Antrophic / "Anthropic ")
 *
 * Only the last one is genuinely lossy to leave alone, because it splits a
 * payee's history across several buckets and weakens autocomplete.
 */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normaliseKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Spelling variants that normalisation alone will not merge, because they are
 * transpositions or genuinely different words. Keys are normalised forms;
 * values are the canonical display spelling.
 *
 * Only public businesses belong here. Variants of people's names, or of places
 * that would say where someone lives, go in data/counterparty-aliases.json,
 * which the importer merges over this table.
 */
export const COUNTERPARTY_ALIASES: Record<string, string> = {
  antrophic: 'Anthropic',
  anthropic: 'Anthropic',
  // normaliseKey turns punctuation into a space, so "Conn's Camera" keys as
  // "conn s camera", not "conns camera". Both spacings appear in the data.
  'conn s camera': "Conn's Camera",
  'conn s cameras': "Conn's Camera",
  'conns camera': "Conn's Camera",
  'conns cameras': "Conn's Camera",
  justeat: 'Just Eat',
  'just eat': 'Just Eat',
  'm s': 'Marks & Spencer',
  'marks spencer': 'Marks & Spencer',
  'marks spencers': 'Marks & Spencer',
  'marks spencer s': 'Marks & Spencer',
  qpark: 'Q Park',
  'q park': 'Q Park',
  'google one': 'Google',
  google: 'Google',
  'art hobby': 'Art & Hobby',
  'the art hobby shop': 'Art & Hobby',
  'art hobby shop': 'Art & Hobby',
  // Too short for the fuzzy pass, and a letter insertion rather than a plural.
  coasta: 'Costa',
  costa: 'Costa',
};

/** Parses DD/MM/YYYY (optionally followed by a time) into an ISO date string. */
export function parseFormDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, d, m, y] = match;
  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Reject dates that rolled over (e.g. 31/02).
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCDate() !== day || check.getUTCMonth() + 1 !== month) return null;
  return iso;
}

/** Parses DD/MM/YYYY HH:MM:SS into an ISO timestamp, treating it as local. */
export function parseFormTimestamp(raw: string): string | null {
  const date = parseFormDate(raw);
  if (!date) return null;
  const time = raw.trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!time) return `${date}T00:00:00`;
  const [, h, mi, s] = time;
  return `${date}T${String(Number(h)).padStart(2, '0')}:${mi}:${s ?? '00'}`;
}

/** Strips currency symbols and thousands separators. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim();
  if (cleaned === '') return null;

  // Both separators present: the last one is the decimal point.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised = cleaned;
  if (lastComma >= 0 && lastDot >= 0) {
    normalised =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is a thousands separator when it is not 2 digits from the
    // end ("1,394" vs "12,50").
    normalised =
      cleaned.length - lastComma - 1 === 2
        ? cleaned.replace(',', '.')
        : cleaned.replace(/,/g, '');
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** Title-cases a name while leaving existing internal capitals alone. */
function tidyDisplayName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Ranks two equally common spellings of the same payee.
 *
 * Frequency decides first, but plenty of variants appear exactly once each,
 * and falling back to alphabetical order picks the typo about half the time
 * ("Circle K Grafton Steet" sorts before "...Street"). Capitalisation is the
 * better signal: a name typed deliberately capitalises each word, whereas a
 * hurried one does not. Length breaks the remaining ties, on the grounds that
 * dropped letters are the most common phone-keyboard slip.
 */
function spellingQuality(name: string): number {
  const words = name.split(' ').filter((word) => /[a-z]/i.test(word));
  if (words.length === 0) return 0;
  return words.every((word) => /^[^a-zA-Z]*[A-Z]/.test(word)) ? 1 : 0;
}

function preferredSpelling(a: string, b: string): number {
  return (
    spellingQuality(b) - spellingQuality(a) || b.length - a.length || a.localeCompare(b)
  );
}

export interface CanonicalNames {
  /** normalised key -> canonical display name */
  canonical: Map<string, string>;
  /** merges applied, for the import report */
  merges: { from: string; to: string; count: number }[];
}

/** Levenshtein distance, bailing out once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * Builds the canonical-name map for every counterparty seen in the data.
 *
 * Three passes: the explicit alias table (COUNTERPARTY_ALIASES unless one is
 * passed in), then exact match on the
 * normalised key, then a conservative fuzzy pass that merges near-identical
 * long names (the sort of thing that comes from a typo on a phone keyboard).
 * The most frequently used spelling wins, so canonical names reflect habit.
 */
export function buildCanonicalNames(
  raw: Iterable<string>,
  aliases: Record<string, string> = COUNTERPARTY_ALIASES,
): CanonicalNames {
  const counts = new Map<string, { display: Map<string, number>; total: number }>();

  for (const value of raw) {
    const name = tidyDisplayName(value);
    if (name === '') continue;
    const key = normaliseKey(name);
    if (key === '') continue;
    let bucket = counts.get(key);
    if (!bucket) {
      bucket = { display: new Map(), total: 0 };
      counts.set(key, bucket);
    }
    bucket.display.set(name, (bucket.display.get(name) ?? 0) + 1);
    bucket.total += 1;
  }

  const canonical = new Map<string, string>();
  const merges: { from: string; to: string; count: number }[] = [];

  // Pass 1 + 2: explicit aliases, else the most common spelling of that key.
  for (const [key, bucket] of counts) {
    const alias = aliases[key];
    if (alias) {
      canonical.set(key, alias);
      continue;
    }
    const best = [...bucket.display.entries()].sort(
      (a, b) => b[1] - a[1] || preferredSpelling(a[0], b[0]),
    )[0]!;
    canonical.set(key, best[0]);
  }

  // Pass 3: fuzzy merge of long, near-identical names into the more frequent
  // of the pair. Thresholds are deliberately tight -- "Aldi"/"Lidl" and
  // "Mary Egan"/"Mary Crean" must never collapse.
  const keys = [...counts.keys()].sort(
    (a, b) =>
      counts.get(b)!.total - counts.get(a)!.total ||
      preferredSpelling(canonical.get(a)!, canonical.get(b)!),
  );
  const absorbed = new Set<string>();

  for (let i = 0; i < keys.length; i++) {
    const target = keys[i]!;
    if (absorbed.has(target)) continue;
    if (aliases[target]) continue;

    for (let j = i + 1; j < keys.length; j++) {
      const candidate = keys[j]!;
      if (absorbed.has(candidate)) continue;
      if (aliases[candidate]) continue;

      // Never merge names that differ by a digit -- "Card 1"/"Card 2".
      if (/\d/.test(target) || /\d/.test(candidate)) continue;

      // A trailing "s" is a slip, not a different shop ("Tesco"/"Tescos",
      // "Eason"/"Easons"). Safe below the general length floor because it is an
      // appended character rather than a substitution -- "Aldi"/"Aldo" and
      // "Lush"/"Luas" cannot match this way.
      const shorter = Math.min(target.length, candidate.length);
      const pluralSlip =
        shorter >= 4 && (target === `${candidate}s` || candidate === `${target}s`);

      if (!pluralSlip) {
        const len = Math.max(target.length, candidate.length);
        if (len < 8) continue;
        const threshold = len >= 14 ? 2 : 1;
        if (editDistance(target, candidate, threshold) > threshold) continue;
      }

      const to = canonical.get(target)!;
      absorbed.add(candidate);
      merges.push({ from: canonical.get(candidate)!, to, count: counts.get(candidate)!.total });
      canonical.set(candidate, to);
    }
  }

  // Record explicit-alias merges too, so the report shows the full picture.
  for (const [key, bucket] of counts) {
    const alias = aliases[key];
    if (!alias) continue;
    for (const [display, count] of bucket.display) {
      if (display !== alias) merges.push({ from: display, to: alias, count });
    }
  }

  return { canonical, merges };
}

export function canonicalNameFor(
  canonical: Map<string, string>,
  raw: string,
): string | null {
  const key = normaliseKey(raw);
  if (key === '') return null;
  return canonical.get(key) ?? tidyDisplayName(raw);
}
