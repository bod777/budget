import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';

/**
 * Monthly rollup, replacing the copied budget workbook.
 *
 * The surplus chain is taken from the spreadsheet and verified against
 * August 2026, where opening 300.00 + this month 1,700.00 = 2,000.00:
 *
 *   incomeSurplus     = income actual - expense actual
 *   thisMonthSurplus  = incomeSurplus - savings actual
 *   closingSurplus    = openingSurplus + thisMonthSurplus
 *
 * Opening surplus is stored rather than recomputed recursively so that a
 * correction to an old month does not silently rewrite every month after it.
 */

function monthBounds(month: string) {
  const start = `${month}-01`;
  return { start, next: `(date '${start}' + interval '1 month')::date` };
}

function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function registerBudgetRoutes(app: FastifyInstance) {
  app.get<{ Params: { month: string } }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const { start } = monthBounds(month);

    const monthRow = await query<{ month: string; opening_surplus: number; note: string | null }>(
      'select month, opening_surplus, note from budget_months where month = $1::date',
      [start],
    );

    // Actuals per category for the month.
    const actuals = await query<{ category_id: number; actual: number }>(
      `select category_id, sum(amount) as actual
       from entries
       where occurred_on >= $1::date
         and occurred_on < ($1::date + interval '1 month')
       group by category_id`,
      [start],
    );
    const actualByCategory = new Map(actuals.map((r) => [r.category_id, Number(r.actual)]));

    const budgets = await query<{ category_id: number; amount: number; note: string | null }>(
      'select category_id, amount, note from budget_lines where month = $1::date',
      [start],
    );
    const budgetByCategory = new Map(budgets.map((r) => [r.category_id, r]));

    const categories = await query<{
      id: number;
      kind: 'expense' | 'income';
      name: string;
      bucket: 'fixed' | 'variable' | null;
      sort_order: number;
    }>(
      `select id, kind, name, bucket, sort_order
       from categories
       where archived = false
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
      id: number;
      name: string;
      budget: number;
      actual: number;
      sort_order: number;
    }>(
      `select id, name, budget, actual, sort_order
       from savings_lines where month = $1::date order by sort_order, name`,
      [start],
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

    const openingSurplus = monthRow[0] ? Number(monthRow[0].opening_surplus) : 0;
    const incomeSurplusBudget = Math.round((incomeBudget - expenseBudget) * 100) / 100;
    const incomeSurplusActual = Math.round((incomeActual - expenseActual) * 100) / 100;
    const thisMonthBudget = Math.round((incomeSurplusBudget - savingsBudget) * 100) / 100;
    const thisMonthActual = Math.round((incomeSurplusActual - savingsActual) * 100) / 100;

    return reply.send({
      month,
      exists: monthRow.length > 0,
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
   * Starts a month by copying the previous month's budget and savings targets
   * and carrying its closing surplus forward -- the equivalent of duplicating
   * the workbook, minus the duplicating.
   */
  app.post<{ Params: { month: string }; Body: { copyFrom?: string } }>(
    '/api/months/:month/init',
    async (request, reply) => {
      const month = request.params.month;
      if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
      const source = request.body?.copyFrom ?? previousMonth(month);
      if (!isMonth(source)) return reply.code(400).send({ error: 'copyFrom must be YYYY-MM' });

      const start = `${month}-01`;
      const sourceStart = `${source}-01`;

      await withTransaction(async (client) => {
        // Carry forward the source month's closing surplus.
        const prior = await client.query<{ opening_surplus: number }>(
          'select opening_surplus from budget_months where month = $1::date',
          [sourceStart],
        );
        const priorOpening = prior.rows[0] ? Number(prior.rows[0].opening_surplus) : 0;

        const sums = await client.query<{ kind: string; total: number }>(
          `select c.kind, coalesce(sum(e.amount), 0) as total
           from entries e join categories c on c.id = e.category_id
           where e.occurred_on >= $1::date
             and e.occurred_on < ($1::date + interval '1 month')
           group by c.kind`,
          [sourceStart],
        );
        const priorIncome = Number(sums.rows.find((r) => r.kind === 'income')?.total ?? 0);
        const priorExpense = Number(sums.rows.find((r) => r.kind === 'expense')?.total ?? 0);

        const priorSavings = await client.query<{ total: number }>(
          'select coalesce(sum(actual), 0) as total from savings_lines where month = $1::date',
          [sourceStart],
        );

        const closing =
          Math.round(
            (priorOpening +
              (priorIncome - priorExpense) -
              Number(priorSavings.rows[0]?.total ?? 0)) *
              100,
          ) / 100;

        await client.query(
          `insert into budget_months (month, opening_surplus)
           values ($1::date, $2)
           on conflict (month) do update set opening_surplus = excluded.opening_surplus`,
          [start, closing],
        );

        await client.query(
          `insert into budget_lines (month, category_id, amount, note)
           select $1::date, category_id, amount, note from budget_lines where month = $2::date
           on conflict (month, category_id) do nothing`,
          [start, sourceStart],
        );

        await client.query(
          `insert into savings_lines (month, name, budget, actual, sort_order)
           select $1::date, name, budget, 0, sort_order from savings_lines where month = $2::date
           on conflict (month, name) do nothing`,
          [start, sourceStart],
        );
      });

      return reply.send({ month, initialisedFrom: source });
    },
  );

  app.put<{
    Params: { month: string };
    Body: {
      openingSurplus?: number;
      note?: string | null;
      lines?: { categoryId: number; amount: number; note?: string | null }[];
      savings?: { name: string; budget: number; actual: number; sortOrder?: number }[];
    };
  }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const start = `${month}-01`;
    const body = request.body ?? {};

    await withTransaction(async (client) => {
      await client.query(
        `insert into budget_months (month, opening_surplus, note)
         values ($1::date, coalesce($2, 0), $3)
         on conflict (month) do update set
           opening_surplus = coalesce($2, budget_months.opening_surplus),
           note = coalesce($3, budget_months.note)`,
        [start, body.openingSurplus ?? null, body.note ?? null],
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

      if (body.savings) {
        await client.query('delete from savings_lines where month = $1::date', [start]);
        for (const [index, line] of body.savings.entries()) {
          await client.query(
            `insert into savings_lines (month, name, budget, actual, sort_order)
             values ($1::date, $2, $3, $4, $5)`,
            [start, line.name, line.budget, line.actual, line.sortOrder ?? index],
          );
        }
      }
    });

    return reply.send({ month, saved: true });
  });

  /** Month list for the picker, newest first. */
  app.get('/api/months', async (_request, reply) => {
    const rows = await query(
      `select to_char(m, 'YYYY-MM') as month from (
         select distinct date_trunc('month', occurred_on)::date as m from entries
         union
         select month from budget_months
       ) all_months
       order by m desc`,
    );
    return reply.send({ months: rows.map((r) => (r as { month: string }).month) });
  });
}
