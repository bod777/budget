import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import {
  periodContaining,
  periodFor,
  shiftMonth,
  type PayRule,
  type Period,
} from '../lib/pay-periods.ts';

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

async function payRules(): Promise<PayRule[]> {
  const rows = await query<{ effective_from: string; day_rule: string; note: string | null }>(
    'select effective_from, day_rule, note from pay_schedule order by effective_from',
  );
  return rows.map((row) => ({
    effectiveFrom: String(row.effective_from).slice(0, 10),
    dayRule: row.day_rule === 'last' ? 'last' : Number(row.day_rule),
    note: row.note,
  }));
}

/**
 * Boundaries for a period. A stored pair wins over a computed one, so editing
 * the schedule cannot silently move a period that has already been closed off.
 */
async function boundsFor(month: string, rules: PayRule[]): Promise<Period> {
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
  return periodFor(month, rules);
}

export function registerBudgetRoutes(app: FastifyInstance) {
  app.get<{ Params: { month: string } }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });

    const rules = await payRules();
    const period = await boundsFor(month, rules);
    const start = `${month}-01`;

    const monthRow = await query<{ opening_surplus: number; note: string | null }>(
      'select opening_surplus, note from budget_months where month = $1::date',
      [start],
    );

    const actuals = await query<{ category_id: number; actual: number }>(
      `select category_id, sum(amount) as actual
       from entries
       where occurred_on >= $1::date and occurred_on < $2::date
       group by category_id`,
      [period.start, period.end],
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

      const rules = await payRules();
      const period = await boundsFor(month, rules);
      const sourcePeriod = await boundsFor(source, rules);
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
           group by c.kind`,
          [sourcePeriod.start, sourcePeriod.end],
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
          `insert into savings_lines (month, name, budget, actual, sort_order)
           select $1::date, name, budget, 0, sort_order from savings_lines where month = $2::date
           on conflict (month, name) do nothing`,
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
      savings?: { name: string; budget: number; actual: number; sortOrder?: number }[];
    };
  }>('/api/months/:month', async (request, reply) => {
    const month = request.params.month;
    if (!isMonth(month)) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const start = `${month}-01`;
    const body = request.body ?? {};
    const rules = await payRules();
    const period = await boundsFor(month, rules);

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

    return reply.send({ month, saved: true, period });
  });

  /** Period list for the picker, newest first. */
  app.get('/api/months', async (_request, reply) => {
    const rules = await payRules();
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
      const first = periodContaining(String(earliest).slice(0, 10), rules);
      const last = periodContaining(String(latest).slice(0, 10), rules);
      let cursor = first.month;
      for (let guard = 0; guard < 600; guard++) {
        months.add(cursor);
        if (cursor === last.month) break;
        cursor = shiftMonth(cursor, 1);
      }
    }

    return reply.send({ months: [...months].sort().reverse() });
  });

  /** The pay schedule, plus which period today falls in. */
  app.get('/api/pay-schedule', async (_request, reply) => {
    const rules = await payRules();
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    return reply.send({ rules, current: periodContaining(iso, rules) });
  });
}
