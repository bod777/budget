import type { PoolClient } from 'pg';
import { normaliseKey, tidy } from './text.ts';

/**
 * Resolves a typed payee/payer name to a counterparty id, creating one if the
 * name is genuinely new. Aliases recorded during import (and any added later)
 * win, so re-typing "Antrophic" still lands on the canonical "Anthropic".
 */
export async function resolveCounterparty(
  client: PoolClient,
  rawName: string | null | undefined,
): Promise<number | null> {
  const name = tidy(rawName ?? '');
  if (name === '') return null;
  const key = normaliseKey(name);
  if (key === '') return null;

  const alias = await client.query<{ counterparty_id: number }>(
    'select counterparty_id from counterparty_aliases where alias = $1',
    [key],
  );
  if (alias.rows[0]) return alias.rows[0].counterparty_id;

  const existing = await client.query<{ id: number }>(
    'select id from counterparties where normalized = $1',
    [key],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await client.query<{ id: number }>(
    `insert into counterparties (name, normalized) values ($1, $2)
     on conflict (normalized) do update set name = counterparties.name
     returning id`,
    [name, key],
  );
  return created.rows[0]!.id;
}
