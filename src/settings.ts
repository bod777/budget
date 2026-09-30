import { query } from './db.ts';

/**
 * App-wide preferences, as a small key/value store. See db/008_settings.sql for
 * why it is shaped that way.
 */
export async function readSetting(key: string, fallback: string): Promise<string> {
  const rows = await query<{ value: string }>('select value from settings where key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

export async function writeSetting(key: string, value: string): Promise<void> {
  await query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}
