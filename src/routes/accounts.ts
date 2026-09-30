import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
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

/**
 * An opening balance is the *closing* balance of the day it is dated, the way a
 * bank statement reads. Only entries after that date move it.
 *
 * The alternative -- counting the opening day itself -- double-counts anything
 * already logged for that day, because the figure read off a banking app
 * naturally includes the day's activity so far.
 *
 * An account with no opening balance has an unknown balance, reported as
 * unknown rather than silently as zero.
 */
const BALANCE_SQL = `
  with movements as (
    select
      e.account_id as account_id,
      e.occurred_on,
      case e.kind
        when 'income' then e.amount
        when 'expense' then -e.amount
        when 'transfer' then -e.amount
      end as delta
    from entries e
    where e.account_id is not null
    union all
    -- The receiving end of a transfer.
    select e.to_account_id, e.occurred_on, e.amount
    from entries e
    where e.kind = 'transfer' and e.to_account_id is not null
  )
  select
    a.id,
    a.name,
    a.kind,
    a.usable_for as "usableFor",
    a.opening_balance as "openingBalance",
    a.opening_on as "openingOn",
    a.sort_order as "sortOrder",
    a.archived,
    coalesce(sum(m.delta), 0) as movement,
    count(m.*)::int as "movementCount",
    -- When the figure last actually moved, which is what the balance is
    -- current as of. The opening date only says when it was last anchored.
    max(m.occurred_on) as "lastMovementOn"
  from accounts a
  left join movements m
    on m.account_id = a.id
   and (a.opening_on is null or m.occurred_on > a.opening_on)
  group by a.id
  order by a.sort_order, a.name
`;

interface BalanceRow {
  id: number;
  name: string;
  kind: string;
  usableFor: string[];
  openingBalance: number | null;
  openingOn: string | null;
  sortOrder: number;
  archived: boolean;
  movement: number;
  movementCount: number;
  lastMovementOn: string | null;
}

export function registerAccountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async (_request, reply) => {
    const rows = await query<BalanceRow>(BALANCE_SQL);

    const accounts = rows.map((row) => {
      const known = row.openingBalance !== null;
      const balance = known
        ? Math.round((Number(row.openingBalance) + Number(row.movement)) * 100) / 100
        : null;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        usableFor: row.usableFor,
        openingBalance: row.openingBalance === null ? null : Number(row.openingBalance),
        openingOn: row.openingOn ? String(row.openingOn).slice(0, 10) : null,
        sortOrder: row.sortOrder,
        archived: row.archived,
        movement: Math.round(Number(row.movement) * 100) / 100,
        movementCount: row.movementCount,
        lastMovementOn: row.lastMovementOn ? String(row.lastMovementOn).slice(0, 10) : null,
        balance,
        // A credit card's balance is what is owed, so it reads more naturally
        // with the sign flipped in the interface.
        owed: row.kind === 'credit' && balance !== null ? -balance : null,
        needsOpeningBalance: !known,
      };
    });

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
