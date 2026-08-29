import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { env } from '../env.ts';
import { ensureTabs, formatHeaders, replaceTab, type CellValue } from '../lib/sheets.ts';
import { periodContaining, periodFor, shiftMonth } from '../lib/pay-periods.ts';
import { loadSchedule, type Schedule } from './pay-schedule.ts';

/**
 * One-way mirror of the database into a Google Sheet.
 *
 * Deliberately one-way. Sheet rows have no stable identifier, so reconciling
 * edits made on both sides means matching on date, amount and description --
 * guesswork that silently loses data, and precisely the duplicate-prone
 * situation this app was built to escape. The database is the source of truth;
 * the sheet is a mirror to pivot, chart and keep as a backup.
 *
 * Every run replaces each tab wholesale, so the sheet cannot drift.
 */

const EXPENSES_TAB = 'Expenses';
const INCOME_TAB = 'Income';
const TRANSFERS_TAB = 'Transfers';
const BALANCES_TAB = 'Balances';
const PERIODS_TAB = 'Periods';
const TABS = [EXPENSES_TAB, INCOME_TAB, TRANSFERS_TAB, BALANCES_TAB, PERIODS_TAB];

interface EntryRow {
  occurred_on: string;
  description: string;
  counterparty: string | null;
  amount: number;
  category: string;
  bucket: string | null;
  account: string | null;
  note: string | null;
  source: string;
  logged_at: string;
}

export { loadSchedule };

function iso(value: unknown): string {
  return String(value).slice(0, 10);
}

/**
 * `timestamptz` comes back as a Date, whose default string form is
 * "Sun Aug 09 2026 15:08:00 GMT+0100" — unsortable in a spreadsheet. Dates are
 * rendered as plain ISO instead so the column sorts and filters properly.
 */
function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export async function entryRows(
  kind: 'expense' | 'income',
  { rules, overrides }: Schedule,
): Promise<CellValue[][]> {
  const rows = await query<EntryRow>(
    `select e.occurred_on, e.description, cp.name as counterparty, e.amount,
            cat.name as category, cat.bucket, ch.name as account, e.note,
            e.source, e.logged_at
     from entries e
     left join counterparties cp on cp.id = e.counterparty_id
     join categories cat on cat.id = e.category_id
     left join accounts ch on ch.id = e.account_id
     where e.kind = $1
     order by e.occurred_on desc, e.id desc`,
    [kind],
  );

  const header: CellValue[] = [
    'Date',
    'Description',
    kind === 'expense' ? 'Payee' : 'Payer',
    'Amount',
    'Category',
    ...(kind === 'expense' ? (['Fixed/Variable'] as CellValue[]) : []),
    'Account',
    // The whole point of mirroring rather than exporting: pivot by budget
    // period, which a date column alone cannot express.
    'Budget period',
    'Note',
    'Source',
    'Logged at',
  ];

  const body = rows.map((row): CellValue[] => {
    const date = iso(row.occurred_on);
    return [
      date,
      row.description,
      row.counterparty ?? '',
      Number(row.amount),
      row.category,
      ...(kind === 'expense' ? [row.bucket ?? ''] : []),
      row.account ?? '',
      periodContaining(date, rules, overrides).month,
      row.note ?? '',
      row.source,
      timestamp(row.logged_at),
    ];
  });

  return [header, ...body];
}

export async function transferRows({ rules, overrides }: Schedule): Promise<CellValue[][]> {
  const rows = await query<{
    occurred_on: string;
    description: string;
    amount: number;
    from_name: string | null;
    to_name: string | null;
    note: string | null;
    source: string;
    logged_at: string;
  }>(
    `select e.occurred_on, e.description, e.amount,
            src.name as from_name, dest.name as to_name,
            e.note, e.source, e.logged_at
     from entries e
     left join accounts src on src.id = e.account_id
     left join accounts dest on dest.id = e.to_account_id
     where e.kind = 'transfer'
     order by e.occurred_on desc, e.id desc`,
  );

  const header: CellValue[] = [
    'Date', 'Description', 'From', 'To', 'Amount', 'Budget period', 'Note', 'Source', 'Logged at',
  ];

  return [
    header,
    ...rows.map((row): CellValue[] => {
      const date = iso(row.occurred_on);
      return [
        date,
        row.description,
        row.from_name ?? '',
        row.to_name ?? '',
        Number(row.amount),
        periodContaining(date, rules, overrides).month,
        row.note ?? '',
        row.source,
        timestamp(row.logged_at),
      ];
    }),
  ];
}

export async function balanceRows(): Promise<CellValue[][]> {
  const rows = await query<{
    name: string;
    kind: string;
    opening_balance: number | null;
    opening_on: string | null;
    movement: number;
  }>(
    `with movements as (
       select e.account_id as account_id, e.occurred_on,
              case e.kind when 'income' then e.amount
                          when 'expense' then -e.amount
                          when 'transfer' then -e.amount end as delta
       from entries e where e.account_id is not null
       union all
       select e.to_account_id, e.occurred_on, e.amount
       from entries e where e.kind = 'transfer' and e.to_account_id is not null
     )
     select a.name, a.kind, a.opening_balance, a.opening_on,
            coalesce(sum(m.delta), 0) as movement
     from accounts a
     left join movements m on m.account_id = a.id
       and (a.opening_on is null or m.occurred_on > a.opening_on)
     where a.archived = false
     group by a.id
     order by a.sort_order, a.name`,
  );

  const header: CellValue[] = [
    'Account', 'Type', 'Opening balance', 'Opening date', 'Movement since', 'Balance',
  ];

  return [
    header,
    ...rows.map((row): CellValue[] => {
      const opening = row.opening_balance === null ? null : Number(row.opening_balance);
      return [
        row.name,
        row.kind,
        opening,
        row.opening_on ? iso(row.opening_on) : '',
        Math.round(Number(row.movement) * 100) / 100,
        // Left blank rather than guessed when no opening balance is known.
        opening === null ? '' : Math.round((opening + Number(row.movement)) * 100) / 100,
      ];
    }),
  ];
}

export async function periodRows({ rules, overrides }: Schedule): Promise<CellValue[][]> {
  const bounds = await query<{ earliest: string | null; latest: string | null }>(
    'select min(occurred_on) as earliest, max(occurred_on) as latest from entries',
  );
  const earliest = bounds[0]?.earliest;
  const latest = bounds[0]?.latest;

  const header: CellValue[] = [
    'Period',
    'Start',
    'End (inclusive)',
    'Expenses',
    'Income',
    'Savings',
    'Net after savings',
    'Opening surplus',
    'Closing surplus',
  ];
  if (!earliest || !latest || rules.length === 0) return [header];

  const totals = await query<{ month_key: string; kind: string; total: number }>(
    `select to_char(occurred_on, 'YYYY-MM-DD') as month_key, c.kind, sum(e.amount) as total
     from entries e join categories c on c.id = e.category_id
     where e.kind <> 'transfer'
     group by 1, 2`,
  );

  // Bucket daily totals into periods rather than issuing a query per period.
  const byPeriod = new Map<string, { expense: number; income: number }>();
  for (const row of totals) {
    const month = periodContaining(row.month_key, rules, overrides).month;
    const bucket = byPeriod.get(month) ?? { expense: 0, income: 0 };
    if (row.kind === 'expense') bucket.expense += Number(row.total);
    else bucket.income += Number(row.total);
    byPeriod.set(month, bucket);
  }

  // Savings moved in a period comes from real transfers into savings accounts,
  // the same source the dashboard uses, so the two can never disagree.
  const savingsMoves = await query<{ occurred_on: string; total: number }>(
    `select e.occurred_on,
            sum(case when e.to_account_id = a.id then e.amount else -e.amount end) as total
     from entries e
     join accounts a on a.kind = 'savings'
       and (e.to_account_id = a.id or e.account_id = a.id)
     where e.kind = 'transfer'
     group by e.occurred_on`,
  );
  const savingsByMonth = new Map<string, number>();
  for (const row of savingsMoves) {
    const month = periodContaining(iso(row.occurred_on), rules, overrides).month;
    savingsByMonth.set(month, (savingsByMonth.get(month) ?? 0) + Number(row.total));
  }

  const opening = await query<{ month: string; opening_surplus: number }>(
    "select to_char(month, 'YYYY-MM') as month, opening_surplus from budget_months",
  );
  const openingByMonth = new Map(opening.map((r) => [r.month, Number(r.opening_surplus)]));

  const first = periodContaining(iso(earliest), rules, overrides).month;
  const last = periodContaining(iso(latest), rules, overrides).month;

  const body: CellValue[][] = [];
  let cursor = first;
  for (let guard = 0; guard < 600; guard++) {
    const period = periodFor(cursor, rules, overrides);
    const bucket = byPeriod.get(cursor) ?? { expense: 0, income: 0 };
    const savingsActual = savingsByMonth.get(cursor) ?? 0;
    const openingSurplus = openingByMonth.get(cursor) ?? 0;
    const net = Math.round((bucket.income - bucket.expense - savingsActual) * 100) / 100;

    // The end is exclusive; show the last day actually inside the period.
    const endDate = new Date(`${period.end}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() - 1);

    body.push([
      cursor,
      period.start,
      endDate.toISOString().slice(0, 10),
      Math.round(bucket.expense * 100) / 100,
      Math.round(bucket.income * 100) / 100,
      savingsActual,
      net,
      openingSurplus,
      Math.round((openingSurplus + net) * 100) / 100,
    ]);

    if (cursor === last) break;
    cursor = shiftMonth(cursor, 1);
  }

  body.reverse();
  return [header, ...body];
}

export async function runSheetSync(): Promise<{
  expenses: number;
  income: number;
  transfers: number;
  periods: number;
}> {
  const key = env.sheets.serviceAccount;
  const spreadsheetId = env.sheets.spreadsheetId;
  if (!key || !spreadsheetId) throw new Error('Google Sheets mirroring is not configured');

  const schedule = await loadSchedule();
  const [expenses, income, transfers, balances, periods] = await Promise.all([
    entryRows('expense', schedule),
    entryRows('income', schedule),
    transferRows(schedule),
    balanceRows(),
    periodRows(schedule),
  ]);

  await ensureTabs(key, spreadsheetId, TABS);
  await replaceTab(key, spreadsheetId, EXPENSES_TAB, expenses);
  await replaceTab(key, spreadsheetId, INCOME_TAB, income);
  await replaceTab(key, spreadsheetId, TRANSFERS_TAB, transfers);
  await replaceTab(key, spreadsheetId, BALANCES_TAB, balances);
  await replaceTab(key, spreadsheetId, PERIODS_TAB, periods);
  await formatHeaders(key, spreadsheetId, TABS);

  const counts = {
    expenses: Math.max(expenses.length - 1, 0),
    income: Math.max(income.length - 1, 0),
    transfers: Math.max(transfers.length - 1, 0),
    periods: Math.max(periods.length - 1, 0),
  };

  await query(
    `insert into sheet_sync (id, last_run_at, status, detail)
     values (1, now(), 'ok', $1)
     on conflict (id) do update set last_run_at = now(), status = 'ok', detail = $1`,
    [
      `${counts.expenses} expenses, ${counts.income} income, ` +
        `${counts.transfers} transfers, ${counts.periods} periods`,
    ],
  );

  return counts;
}

async function recordFailure(message: string) {
  await query(
    `insert into sheet_sync (id, last_run_at, status, detail)
     values (1, now(), 'failed', $1)
     on conflict (id) do update set last_run_at = now(), status = 'failed', detail = $1`,
    [message.slice(0, 500)],
  ).catch(() => {});
}

export function registerSheetSyncRoutes(app: FastifyInstance) {
  app.get('/api/sheet-sync', async (_request, reply) => {
    const rows = await query<{ last_run_at: string; status: string; detail: string | null }>(
      'select last_run_at, status, detail from sheet_sync where id = 1',
    );
    return reply.send({
      configured: env.sheets.enabled,
      spreadsheetId: env.sheets.spreadsheetId || null,
      serviceAccountEmail: env.sheets.serviceAccount?.client_email ?? null,
      lastRun: rows[0]
        ? { at: rows[0].last_run_at, status: rows[0].status, detail: rows[0].detail }
        : null,
    });
  });

  app.post('/api/sheet-sync/run', async (_request, reply) => {
    if (!env.sheets.enabled) {
      return reply.code(400).send({ error: 'Google Sheets mirroring is not configured' });
    }
    try {
      const counts = await runSheetSync();
      return reply.send({ ok: true, ...counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      app.log.error(error, 'sheet sync failed');
      await recordFailure(message);
      return reply.code(502).send({ error: message });
    }
  });
}

/** Nightly mirror, so the backup keeps up without anyone remembering. */
export function scheduleSheetSync(app: FastifyInstance) {
  if (!env.sheets.enabled) return;
  const run = () => {
    runSheetSync().catch(async (error) => {
      app.log.error(error, 'scheduled sheet sync failed');
      await recordFailure(error instanceof Error ? error.message : 'Sync failed');
    });
  };
  setInterval(run, 24 * 3600 * 1000).unref();
  // Give the server a moment to settle before the first run.
  setTimeout(run, 60_000).unref();
}
