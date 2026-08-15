import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { periodContaining, periodFor, shiftMonth, type PayRule } from '../lib/pay-periods.ts';

/**
 * Aggregates for the history charts.
 *
 * Everything is bucketed by budget period rather than calendar month, so the
 * numbers here agree with the dashboard rather than telling a slightly
 * different story.
 */

async function payRules(): Promise<PayRule[]> {
  const rows = await query<{ effective_from: string; day_rule: string }>(
    'select effective_from, day_rule from pay_schedule order by effective_from',
  );
  return rows.map((row) => ({
    effectiveFrom: String(row.effective_from).slice(0, 10),
    dayRule: row.day_rule === 'last' ? 'last' : Number(row.day_rule),
  }));
}

function iso(value: unknown): string {
  return String(value).slice(0, 10);
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export function registerStatsRoutes(app: FastifyInstance) {
  /** Spending and income for each of the last N periods, oldest first. */
  app.get<{ Querystring: { limit?: string } }>('/api/stats/periods', async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 12), 2), 48);
    const rules = await payRules();
    if (rules.length === 0) return reply.send({ periods: [] });

    // One row per day and kind, bucketed into periods here rather than issuing
    // a query per period.
    const rows = await query<{ occurred_on: string; kind: string; total: number }>(
      `select e.occurred_on, e.kind, sum(e.amount) as total
       from entries e
       where e.kind <> 'transfer'
       group by 1, 2`,
    );
    const savingsRows = await query<{ occurred_on: string; total: number }>(
      `select e.occurred_on,
              sum(case when e.to_account_id = a.id then e.amount else -e.amount end) as total
       from entries e
       join accounts a on a.kind = 'savings'
         and (e.to_account_id = a.id or e.account_id = a.id)
       where e.kind = 'transfer'
       group by 1`,
    );

    const buckets = new Map<string, { expenses: number; income: number; savings: number }>();
    const touch = (month: string) => {
      let bucket = buckets.get(month);
      if (!bucket) {
        bucket = { expenses: 0, income: 0, savings: 0 };
        buckets.set(month, bucket);
      }
      return bucket;
    };

    for (const row of rows) {
      const month = periodContaining(iso(row.occurred_on), rules).month;
      const bucket = touch(month);
      if (row.kind === 'expense') bucket.expenses += Number(row.total);
      else bucket.income += Number(row.total);
    }
    for (const row of savingsRows) {
      touch(periodContaining(iso(row.occurred_on), rules).month).savings += Number(row.total);
    }

    // Walk back from the period containing today so the series is continuous
    // even where a period had no activity at all.
    const current = periodContaining(todayIso(), rules).month;
    const months: string[] = [];
    for (let offset = limit - 1; offset >= 0; offset--) months.push(shiftMonth(current, -offset));

    const earliest = await query<{ earliest: string | null }>(
      'select min(occurred_on) as earliest from entries',
    );
    const firstMonth = earliest[0]?.earliest
      ? periodContaining(iso(earliest[0].earliest), rules).month
      : current;

    const periods = months
      .filter((month) => month >= firstMonth)
      .map((month) => {
        const bucket = buckets.get(month) ?? { expenses: 0, income: 0, savings: 0 };
        const period = periodFor(month, rules);
        return {
          month,
          start: period.start,
          end: period.end,
          expenses: Math.round(bucket.expenses * 100) / 100,
          income: Math.round(bucket.income * 100) / 100,
          savings: Math.round(bucket.savings * 100) / 100,
          net: Math.round((bucket.income - bucket.expenses) * 100) / 100,
          // The current period is still filling up, so charts can mark it.
          partial: month === current,
        };
      });

    return reply.send({ periods });
  });

  /** Category spend for one period, with the previous period for comparison. */
  app.get<{ Querystring: { month?: string } }>('/api/stats/categories', async (request, reply) => {
    const rules = await payRules();
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(request.query.month ?? '')
      ? request.query.month!
      : periodContaining(todayIso(), rules).month;

    const period = periodFor(month, rules);
    const previous = periodFor(shiftMonth(month, -1), rules);

    const rows = await query<{ name: string; bucket: string | null; amount: number; prior: number }>(
      `select c.name, c.bucket,
              coalesce(sum(e.amount) filter (
                where e.occurred_on >= $1::date and e.occurred_on < $2::date
              ), 0) as amount,
              coalesce(sum(e.amount) filter (
                where e.occurred_on >= $3::date and e.occurred_on < $4::date
              ), 0) as prior
       from categories c
       left join entries e on e.category_id = c.id and e.kind = 'expense'
       where c.kind = 'expense'
       group by c.id
       having coalesce(sum(e.amount) filter (
                where e.occurred_on >= $1::date and e.occurred_on < $2::date
              ), 0) > 0
           or coalesce(sum(e.amount) filter (
                where e.occurred_on >= $3::date and e.occurred_on < $4::date
              ), 0) > 0
       order by 3 desc`,
      [period.start, period.end, previous.start, previous.end],
    );

    return reply.send({
      month,
      start: period.start,
      end: period.end,
      categories: rows.map((row) => ({
        name: row.name,
        bucket: row.bucket,
        amount: Math.round(Number(row.amount) * 100) / 100,
        previous: Math.round(Number(row.prior) * 100) / 100,
      })),
    });
  });
}
