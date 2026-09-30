import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { loadAccountBalances } from '../balances.ts';
import { tidy } from '../lib/text.ts';

/**
 * Accounts and their balances.
 *
 * Balances are always derived, never stored, so they cannot fall out of step
 * with the entries that produce them. When a balance disagrees with the real
 * statement, that difference is information -- something is missing or wrong --
 * which is the whole point of tracking them.
 *
 * A credit card is a liability: spending pushes it negative and paying it off
 * brings it back toward zero. The arithmetic is the same as any other account;
 * only the presentation differs.
 */

const ACCOUNT_KINDS = new Set(['current', 'credit', 'cash', 'savings', 'other']);

/**
 * What an account can be picked for follows from what it is, so it is derived
 * rather than asked about: no income onto a credit card, and nothing spent
 * straight out of savings.
 *
 * Savings allows income so interest credited to the account can be recorded,
 * but not expenses -- money leaves savings by transfer, which every account is
 * eligible for regardless of this list.
 */
function usableForKind(kind: string): string[] {
  switch (kind) {
    case 'credit':
      return ['expense'];
    case 'savings':
      return ['income'];
    default:
      return ['expense', 'income'];
  }
}

export function registerAccountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async (_request, reply) => {
    const accounts = (await loadAccountBalances()).map((account) => ({
      ...account,
      // A credit card's balance is what is owed, so it reads more naturally
      // with the sign flipped in the interface.
      owed: account.kind === 'credit' && account.balance !== null ? -account.balance : null,
      needsOpeningBalance: account.openingBalance === null,
    }));

    const savings = accounts.filter((a) => a.kind === 'savings' && !a.archived);
    const savingsTotal = savings.every((a) => a.balance !== null)
      ? Math.round(savings.reduce((total, a) => total + (a.balance ?? 0), 0) * 100) / 100
      : null;

    return reply.send({ accounts, savingsTotal });
  });

  app.post<{
    Body: { name?: string; kind?: string; openingBalance?: number | null; openingOn?: string | null };
  }>('/api/accounts', async (request, reply) => {
    const name = tidy(request.body?.name ?? '');
    if (name === '') return reply.code(400).send({ error: 'name is required' });
    const kind = ACCOUNT_KINDS.has(request.body?.kind ?? '') ? request.body!.kind! : 'other';

    const openingBalance = request.body?.openingBalance ?? null;
    const openingOn = request.body?.openingOn ?? null;
    if (openingOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(openingOn)) {
      return reply.code(400).send({ error: 'openingOn must be YYYY-MM-DD' });
    }
    // A balance with no date would be applied to every entry ever recorded.
    if (openingBalance !== null && openingOn === null) {
      return reply.code(400).send({ error: 'openingOn is required when setting a balance' });
    }

    const rows = await query<{ id: number }>(
      `insert into accounts (name, kind, usable_for, opening_balance, opening_on, sort_order)
       values ($1, $2, $3, $4, $5::date, coalesce((select max(sort_order) + 10 from accounts), 10))
       on conflict (name) do nothing
       returning id`,
      [name, kind, usableForKind(kind), openingBalance, openingOn],
    );
    if (rows.length === 0) return reply.code(409).send({ error: 'An account with that name exists' });
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      kind?: string;
      openingBalance?: number | null;
      openingOn?: string | null;
      archived?: boolean;
    };
  }>('/api/accounts/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const body = request.body ?? {};

    if (body.kind !== undefined && !ACCOUNT_KINDS.has(body.kind)) {
      return reply.code(400).send({ error: 'unknown account kind' });
    }
    if (body.openingOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(body.openingOn)) {
      return reply.code(400).send({ error: 'openingOn must be YYYY-MM-DD' });
    }
    // A balance without a date would be applied to every entry ever recorded.
    const settingBalance = body.openingBalance !== undefined && body.openingBalance !== null;
    if (settingBalance && body.openingOn === undefined) {
      const existing = await query<{ opening_on: string | null }>(
        'select opening_on from accounts where id = $1',
        [id],
      );
      if (!existing[0]?.opening_on) {
        return reply.code(400).send({ error: 'openingOn is required when setting a balance' });
      }
    }

    const rows = await query<{ id: number }>(
      // Changing the kind re-derives what the account can be picked for,
      // otherwise a current account turned into savings would go on being
      // offered as somewhere money was spent.
      `update accounts set
         name = coalesce($2, name),
         kind = coalesce($3, kind),
         usable_for = case when $3::text is null then usable_for else $9::text[] end,
         opening_balance = case when $4::boolean then $5 else opening_balance end,
         opening_on = case when $6::boolean then $7::date else opening_on end,
         archived = coalesce($8, archived)
       where id = $1
       returning id`,
      [
        id,
        body.name ? tidy(body.name) : null,
        body.kind ?? null,
        body.openingBalance !== undefined,
        body.openingBalance ?? null,
        body.openingOn !== undefined,
        body.openingOn ?? null,
        body.archived ?? null,
        body.kind ? usableForKind(body.kind) : null,
      ],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return reply.send({ updated: id });
  });
}
