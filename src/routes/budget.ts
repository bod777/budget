import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import { periodContaining, periodFor, shiftMonth, type Period } from '../lib/pay-periods.ts';
import { loadSchedule, type Schedule } from './pay-schedule.ts';

/**
 * Period rollup, replacing the copied budget workbook.
 *
 * Periods run payday to payday rather than across the calendar month — see
 * lib/pay-periods.ts. The end is exclusive, so the payday that opens a period
 * is counted once, in the period it funds.
 *
 * The surplus chain is taken from the spreadsheet and verified against
 * August 2026, where opening 300.00 + this month 1,700.00 = 2,000.00:
 *
 *   incomeSurplus     = income actual - expense actual
 *   thisMonthSurplus  = incomeSurplus - savings actual
 *   closingSurplus    = openingSurplus + thisMonthSurplus
 *
 * Opening surplus is stored rather than recomputed recursively so that a
 * correction to an old period does not silently rewrite every one after it.
 */

function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * Boundaries for a period. A stored pair wins over a computed one, so editing
 * the schedule cannot silently move a period that has already been closed off.
 */
async function boundsFor(month: string, schedule: Schedule): Promise<Period> {
  const stored = await query<{ period_start: string | null; period_end: string | null }>(
    'select period_start, period_end from budget_months where month = $1::date',
    [`${month}-01`],
  );
  const row = stored[0];
  if (row?.period_start && row.period_end) {
    return {
      month,
      start: String(row.period_start).slice(0, 10),
      end: String(row.period_end).slice(0, 10),
    };
  }
  return periodFor(month, schedule.rules, schedule.overrides);
}


/**
 * What a period opens with.
 *
 * A stored figure always wins, so correcting an old period never silently
 * rewrites every one after it. Where nothing is stored -- a period not yet
 * started -- it is rolled forward from the last one that was, so a new budget
 * arrives with the surplus already carried rather than at zero.
 */
async function openingSurplusFor(month: string, schedule: Schedule): Promise<number> {
  const stored = await query<{ opening_surplus: number }>(
    'select opening_surplus from budget_months where month = $1::date',
    [`${month}-01`],
  );
  if (stored[0]) return Number(stored[0].opening_surplus);

  // Walk back to the most recent period that has a stored opening, then roll
  // it forward one period at a time.
  const anchor = await query<{ month: string }>(
    "select to_char(max(month), 'YYYY-MM') as month from budget_months where month < $1::date",
    [`${month}-01`],
  );
  const from = anchor[0]?.month;
  if (!from) return 0;

  let surplus = await query<{ opening_surplus: number }>(
    'select opening_surplus from budget_months where month = $1::date',
    [`${from}-01`],
  ).then((rows) => Number(rows[0]?.opening_surplus ?? 0));

  let cursor = from;
  for (let guard = 0; guard < 36 && cursor < month; guard++) {
    const period = periodFor(cursor, schedule.rules, schedule.overrides);
    const sums = await query<{ kind: string; total: number }>(
      `select c.kind, coalesce(sum(e.amount), 0) as total
       from entries e join categories c on c.id = e.category_id
       where e.occurred_on >= $1::date and e.occurred_on < $2::date
         and e.kind <> 'transfer'
       group by c.kind`,
      [period.start, period.end],
    );
    const income = Number(sums.find((r) => r.kind === 'income')?.total ?? 0);
    const expense = Number(sums.find((r) => r.kind === 'expense')?.total ?? 0);
    const savings = await query<{ total: number }>(
      `select coalesce(sum(
         case when e.to_account_id = a.id then e.amount else -e.amount end
       ), 0) as total
       from entries e
       join accounts a on a.kind = 'savings'
         and (e.to_account_id = a.id or e.account_id = a.id)
       where e.kind = 'transfer'
         and e.occurred_on >= $1::date and e.occurred_on < $2::date`,
      [period.start, period.end],
    ).then((rows) => Number(rows[0]?.total ?? 0));

    surplus = Math.round((surplus + income - expense - savings) * 100) / 100;
    cursor = shiftMonth(cursor, 1);
  }
  return surplus;
}

export function registerBudgetRoutes(app: FastifyInstance) {
  app.get<{ Params: { month: string } }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });

    const schedule = await loadSchedule();
    const period = await boundsFor(month, schedule);
    const start = `${month}-01`;

    const monthRow = await query<{ opening_surplus: number; note: string | null }>(
      'select opening_surplus, note from budget_months where month = $1::date',
      [start],
    );

    const actuals = await query<{ category_id: number; actual: number }>(
      `select category_id, sum(amount) as actual
       from entries
       where occurred_on >= $1::date and occurred_on < $2::date
         and kind <> 'transfer'
       group by category_id`,
      [period.start, period.end],
    );
    const actualByCategory = new Map(actuals.map((r) => [r.category_id, Number(r.actual)]));

    const source = await query<{ month: string }>(
      `select to_char(max(month), 'YYYY-MM') as month
       from budget_lines where month <= $1::date`,
      [start],
    );
    const sourceMonth = source[0]?.month ?? null;
    const inheritedFrom = sourceMonth && sourceMonth !== month ? sourceMonth : null;

    const budgets = sourceMonth
      ? await query<{ category_id: number; amount: number; note: string | null }>(
          'select category_id, amount, note from budget_lines where month = $1::date',
          [`${sourceMonth}-01`],
        )
      : [];
    const budgetByCategory = new Map(budgets.map((r) => [r.category_id, r]));

    const categories = await query<{
      id: number;
      kind: 'expense' | 'income';
      name: string;
      bucket: 'fixed' | 'variable' | null;
    }>(
      `select id, kind, name, bucket
       from categories where archived = false
       order by kind, sort_order, name`,
    );

    const lines = categories.map((category) => {
      const budgetRow = budgetByCategory.get(category.id);
      const budget = budgetRow ? Number(budgetRow.amount) : 0;
      const actual = actualByCategory.get(category.id) ?? 0;
      return {
        categoryId: category.id,
        kind: category.kind,
        name: category.name,
        bucket: category.bucket,
        budget,
        actual,
        // Expenses: positive means under budget. Income: positive means ahead.
        difference:
          category.kind === 'expense'
            ? Math.round((budget - actual) * 100) / 100
            : Math.round((actual - budget) * 100) / 100,
        note: budgetRow?.note ?? null,
      };
    });

    const savings = await query<{
      accountId: number;
      name: string;
      budget: number;
      actual: number;
    }>(
      `select
         a.id as "accountId",
         a.name,
         coalesce(t.amount, 0) as budget,
         coalesce((
           select sum(case when e.to_account_id = a.id then e.amount else -e.amount end)
           from entries e
           where e.kind = 'transfer'
             and (e.to_account_id = a.id or e.account_id = a.id)
             and e.occurred_on >= $2::date and e.occurred_on < $3::date
         ), 0) as actual
       from accounts a
       left join savings_targets t on t.account_id = a.id
         and t.month = (select max(month) from savings_targets where month <= $1::date)
       where a.kind = 'savings' and a.archived = false
       order by a.sort_order, a.name`,
      [start, period.start, period.end],
    );

    const sum = (kind: 'expense' | 'income', field: 'budget' | 'actual') =>
      Math.round(
        lines.filter((l) => l.kind === kind).reduce((total, l) => total + l[field], 0) * 100,
      ) / 100;

    const expenseBudget = sum('expense', 'budget');
    const expenseActual = sum('expense', 'actual');
    const incomeBudget = sum('income', 'budget');
    const incomeActual = sum('income', 'actual');
    const savingsBudget =
      Math.round(savings.reduce((t, s) => t + Number(s.budget), 0) * 100) / 100;
    const savingsActual =
      Math.round(savings.reduce((t, s) => t + Number(s.actual), 0) * 100) / 100;

    const openingSurplus = await openingSurplusFor(month, schedule);
    const incomeSurplusBudget = Math.round((incomeBudget - expenseBudget) * 100) / 100;
    const incomeSurplusActual = Math.round((incomeActual - expenseActual) * 100) / 100;
    const thisMonthBudget = Math.round((incomeSurplusBudget - savingsBudget) * 100) / 100;
    const thisMonthActual = Math.round((incomeSurplusActual - savingsActual) * 100) / 100;

    return reply.send({
      month,
      exists: monthRow.length > 0,
      // Which period these budget figures came from, when not set here yet.
      inheritedFrom,
      periodStart: period.start,
      periodEnd: period.end,
      openingSurplus,
      note: monthRow[0]?.note ?? null,
      lines,
      savings,
      totals: {
        expenseBudget,
        expenseActual,
        expenseDifference: Math.round((expenseBudget - expenseActual) * 100) / 100,
        incomeBudget,
        incomeActual,
        incomeDifference: Math.round((incomeActual - incomeBudget) * 100) / 100,
        savingsBudget,
        savingsActual,
        incomeSurplusBudget,
        incomeSurplusActual,
        thisMonthBudget,
        thisMonthActual,
        closingBudget: Math.round((openingSurplus + thisMonthBudget) * 100) / 100,
        closingActual: Math.round((openingSurplus + thisMonthActual) * 100) / 100,
      },
    });
  });

  /**
   * Starts a period by copying the previous one's budget and savings targets
   * and carrying its closing surplus forward -- the equivalent of duplicating
   * the workbook, minus the duplicating.
   */
  app.post<{ Params: { month: string }; Body: { copyFrom?: string } }>(
    '/api/months/:month/init',
    async (request, reply) => {
      const month = request.params.month;
      if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
      const source = request.body?.copyFrom ?? shiftMonth(month, -1);
      if (!isMonth(source)) return reply.code(400).send({ error: 'copyFrom must be YYYY-MM' });

      const schedule = await loadSchedule();
      const period = await boundsFor(month, schedule);
      const sourcePeriod = await boundsFor(source, schedule);
      const start = `${month}-01`;
      const sourceStart = `${source}-01`;

      await withTransaction(async (client) => {
        const prior = await client.query<{ opening_surplus: number }>(
          'select opening_surplus from budget_months where month = $1::date',
          [sourceStart],
        );
        const priorOpening = prior.rows[0] ? Number(prior.rows[0].opening_surplus) : 0;

        const sums = await client.query<{ kind: string; total: number }>(
          `select c.kind, coalesce(sum(e.amount), 0) as total
           from entries e join categories c on c.id = e.category_id
           where e.occurred_on >= $1::date and e.occurred_on < $2::date
             and e.kind <> 'transfer'
           group by c.kind`,
          [sourcePeriod.start, sourcePeriod.end],
        );
        const priorIncome = Number(sums.rows.find((r) => r.kind === 'income')?.total ?? 0);
        const priorExpense = Number(sums.rows.find((r) => r.kind === 'expense')?.total ?? 0);

        const priorSavings = await client.query<{ total: number }>(
          `select coalesce(sum(
             case when e.to_account_id = a.id then e.amount else -e.amount end
           ), 0) as total
           from entries e
           join accounts a on a.kind = 'savings'
             and (e.to_account_id = a.id or e.account_id = a.id)
           where e.kind = 'transfer'
             and e.occurred_on >= $1::date and e.occurred_on < $2::date`,
          [sourcePeriod.start, sourcePeriod.end],
        );

        const closing =
          Math.round(
            (priorOpening +
              (priorIncome - priorExpense) -
              Number(priorSavings.rows[0]?.total ?? 0)) *
              100,
          ) / 100;

        await client.query(
          `insert into budget_months (month, opening_surplus, period_start, period_end)
           values ($1::date, $2, $3::date, $4::date)
           on conflict (month) do update set
             opening_surplus = excluded.opening_surplus,
             period_start = coalesce(budget_months.period_start, excluded.period_start),
             period_end = coalesce(budget_months.period_end, excluded.period_end)`,
          [start, closing, period.start, period.end],
        );

        await client.query(
          `insert into budget_lines (month, category_id, amount, note)
           select $1::date, category_id, amount, note from budget_lines where month = $2::date
           on conflict (month, category_id) do nothing`,
          [start, sourceStart],
        );

        await client.query(
          `insert into savings_targets (month, account_id, amount)
           select $1::date, account_id, amount from savings_targets where month = $2::date
           on conflict (month, account_id) do nothing`,
          [start, sourceStart],
        );
      });

      return reply.send({ month, initialisedFrom: source, period });
    },
  );

  app.put<{
    Params: { month: string };
    Body: {
      openingSurplus?: number;
      note?: string | null;
      lines?: { categoryId: number; amount: number; note?: string | null }[];
      savings?: { accountId: number; budget: number }[];
    };
  }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const start = `${month}-01`;
    const body = request.body ?? {};
    const schedule = await loadSchedule();
    const period = await boundsFor(month, schedule);

    await withTransaction(async (client) => {
      await client.query(
        `insert into budget_months (month, opening_surplus, note, period_start, period_end)
         values ($1::date, coalesce($2, 0), $3, $4::date, $5::date)
         on conflict (month) do update set
           opening_surplus = coalesce($2, budget_months.opening_surplus),
           note = coalesce($3, budget_months.note),
           period_start = coalesce(budget_months.period_start, excluded.period_start),
           period_end = coalesce(budget_months.period_end, excluded.period_end)`,
        [start, body.openingSurplus ?? null, body.note ?? null, period.start, period.end],
      );

      for (const line of body.lines ?? []) {
        await client.query(
          `insert into budget_lines (month, category_id, amount, note)
           values ($1::date, $2, $3, $4)
           on conflict (month, category_id) do update set
             amount = excluded.amount, note = excluded.note`,
          [start, line.categoryId, line.amount, line.note ?? null],
        );
      }

      for (const line of body.savings ?? []) {
        await client.query(
          `insert into savings_targets (month, account_id, amount)
           values ($1::date, $2, $3)
           on conflict (month, account_id) do update set amount = excluded.amount`,
          [start, line.accountId, line.budget],
        );
      }
    });

    return reply.send({ month, saved: true, period });
  });

  /** Period list for the picker, newest first. */
  app.get('/api/months', async (_request, reply) => {
    const { rules, overrides } = await loadSchedule();
    const bounds = await query<{ earliest: string | null; latest: string | null }>(
      'select min(occurred_on) as earliest, max(occurred_on) as latest from entries',
    );
    const stored = await query<{ month: string }>(
      "select to_char(month, 'YYYY-MM') as month from budget_months",
    );

    const months = new Set(stored.map((row) => row.month));
    const earliest = bounds[0]?.earliest;
    const latest = bounds[0]?.latest;

    if (earliest && latest) {
      const first = periodContaining(String(earliest).slice(0, 10), rules, overrides);
      const last = periodContaining(String(latest).slice(0, 10), rules, overrides);
      let cursor = first.month;
      for (let guard = 0; guard < 600; guard++) {
        months.add(cursor);
        if (cursor === last.month) break;
        cursor = shiftMonth(cursor, 1);
      }
    }

    return reply.send({ months: [...months].sort().reverse() });
  });

}
