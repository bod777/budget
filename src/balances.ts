import { query } from './db.ts';

/**
 * Account balances, derived and never stored, so they cannot fall out of step
 * with the entries that produce them.
 *
 * This lives apart from the routes because two of them need it -- the accounts
 * list and the Budget tab's available-to-spend figure -- and a second copy of
 * the arithmetic would be a second thing to get wrong. The opening-date rule in
 * particular is easy to restate incorrectly: the opening balance is the
 * *closing* balance of the day it is dated, so only entries strictly after it
 * move the figure.
 */
export const BALANCE_SQL = `
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

export interface BalanceRow {
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

export interface AccountBalance {
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
  /** Null when no opening balance has been set, so the figure is unknown. */
  balance: number | null;
}

export async function loadAccountBalances(): Promise<AccountBalance[]> {
  const rows = await query<BalanceRow>(BALANCE_SQL);
  return rows.map((row) => ({
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
    balance:
      row.openingBalance === null
        ? null
        : Math.round((Number(row.openingBalance) + Number(row.movement)) * 100) / 100,
  }));
}

/**
 * What is actually available day to day: everything that is not a savings
 * account, with a credit card's debt counted against it.
 *
 * Null when any of those accounts has no opening balance, because a total that
 * quietly leaves one out reads as authoritative when it is not.
 */
export function liquidTotal(accounts: AccountBalance[]): number | null {
  const liquid = accounts.filter((a) => a.kind !== 'savings' && !a.archived);
  if (liquid.length === 0) return null;
  if (liquid.some((a) => a.balance === null)) return null;
  return Math.round(liquid.reduce((total, a) => total + (a.balance ?? 0), 0) * 100) / 100;
}
