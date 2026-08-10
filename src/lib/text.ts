/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normaliseKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Collapses runs of whitespace without touching capitalisation. */
export function tidy(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}
