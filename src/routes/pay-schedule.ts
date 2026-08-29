import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import {
  periodContaining,
  periodFor,
  shiftMonth,
  type PayOverride,
  type PayRule,
} from '../lib/pay-periods.ts';

/**
 * Editing the pay schedule.
 *
 * A rule applies from a given month until a later rule supersedes it, so
 * changing jobs means adding a row rather than editing the old one — which
 * keeps historical periods computable.
 *
 * A one-off — pay landing early one month — is an override on that month
 * instead: changing the rule would move every period after it as well.
 */

export interface Schedule {
  rules: PayRule[];
  overrides: PayOverride[];
}

export interface RuleInput {
  effectiveFrom?: string;
  dayRule?: string | number;
  note?: string | null;
}

export function normaliseRule(
  input: RuleInput,
): { ok: true; effectiveFrom: string; dayRule: string; note: string | null } | { ok: false; error: string } {
  const raw = (input.effectiveFrom ?? '').trim();
  // Accept a month or a full date; a rule always takes effect from the 1st.
  const match = raw.match(/^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/);
  if (!match) return { ok: false, error: 'effectiveFrom must be YYYY-MM' };
  const effectiveFrom = `${match[1]}-${match[2]}-01`;

  const day = input.dayRule;
  let dayRule: string;
  if (day === 'last') {
    dayRule = 'last';
  } else {
    const value = Number(day);
    if (!Number.isInteger(value) || value < 1 || value > 31) {
      return { ok: false, error: 'dayRule must be "last" or a day between 1 and 31' };
    }
    dayRule = String(value);
  }

  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null;
  return { ok: true, effectiveFrom, dayRule, note };
}

async function loadRules(): Promise<PayRule[]> {
  const rows = await query<{ effective_from: string; day_rule: string; note: string | null }>(
    'select effective_from, day_rule, note from pay_schedule order by effective_from',
  );
  return rows.map((row) => ({
    effectiveFrom: String(row.effective_from).slice(0, 10),
    dayRule: row.day_rule === 'last' ? 'last' : Number(row.day_rule),
    note: row.note,
  }));
}

async function loadOverrides(): Promise<PayOverride[]> {
  const rows = await query<{ month: string; paid_on: string; note: string | null }>(
    'select month, paid_on, note from pay_overrides order by month',
  );
  return rows.map((row) => ({
    month: String(row.month).slice(0, 7),
    paidOn: String(row.paid_on).slice(0, 10),
    note: row.note,
  }));
}

/**
 * The whole schedule: the standing rules plus any months where pay actually
 * landed elsewhere. Every route that works out a period loads it from here, so
 * a one-off cannot be honoured on the dashboard and forgotten in the charts.
 */
export async function loadSchedule(): Promise<Schedule> {
  const [rules, overrides] = await Promise.all([loadRules(), loadOverrides()]);
  return { rules, overrides };
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** A window of periods around today, so the effect of a rule is visible. */
function previewPeriods({ rules, overrides }: Schedule, back = 4, forward = 4) {
  if (rules.length === 0) return [];
  const current = periodContaining(todayIso(), rules, overrides);
  const periods = [];
  for (let offset = -back; offset <= forward; offset++) {
    const month = shiftMonth(current.month, offset);
    periods.push({
      ...periodFor(month, rules, overrides),
      isCurrent: offset === 0,
      // Which end of this period a one-off moved, so the UI can say so.
      startOverridden: overrides.some((o) => o.month === shiftMonth(month, -1)),
      endOverridden: overrides.some((o) => o.month === month),
    });
  }
  return periods;
}

export function registerPayScheduleRoutes(app: FastifyInstance) {
  app.get('/api/pay-schedule', async (_request, reply) => {
    const rows = await query<{
      id: number;
      effective_from: string;
      day_rule: string;
      note: string | null;
    }>('select id, effective_from, day_rule, note from pay_schedule order by effective_from');

    const schedule = await loadSchedule();
    return reply.send({
      rules: rows.map((row) => ({
        id: row.id,
        effectiveFrom: String(row.effective_from).slice(0, 7),
        dayRule: row.day_rule === 'last' ? 'last' : Number(row.day_rule),
        note: row.note,
      })),
      overrides: schedule.overrides,
      current: schedule.rules.length
        ? periodContaining(todayIso(), schedule.rules, schedule.overrides)
        : null,
      preview: previewPeriods(schedule),
    });
  });

  app.post<{ Body: RuleInput }>('/api/pay-schedule', async (request, reply) => {
    const parsed = normaliseRule(request.body ?? {});
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const rows = await query<{ id: number }>(
      `insert into pay_schedule (effective_from, day_rule, note)
       values ($1::date, $2, $3)
       on conflict (effective_from) do update set day_rule = excluded.day_rule, note = excluded.note
       returning id`,
      [parsed.effectiveFrom, parsed.dayRule, parsed.note],
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.patch<{ Params: { id: string }; Body: RuleInput }>(
    '/api/pay-schedule/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

      const parsed = normaliseRule(request.body ?? {});
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

      const clash = await query<{ id: number }>(
        'select id from pay_schedule where effective_from = $1::date and id <> $2',
        [parsed.effectiveFrom, id],
      );
      if (clash.length > 0) {
        return reply.code(409).send({ error: 'Another rule already starts that month' });
      }

      const rows = await query<{ id: number }>(
        `update pay_schedule set effective_from = $2::date, day_rule = $3, note = $4
         where id = $1 returning id`,
        [id, parsed.effectiveFrom, parsed.dayRule, parsed.note],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
      return reply.send({ updated: id });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/pay-schedule/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

    // Removing the last rule would leave no way to work out any period at all.
    const count = await query<{ n: number }>('select count(*)::int as n from pay_schedule');
    if ((count[0]?.n ?? 0) <= 1) {
      return reply.code(400).send({ error: 'At least one pay rule is needed' });
    }

    const rows = await query<{ id: number }>(
      'delete from pay_schedule where id = $1 returning id',
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return reply.send({ deleted: id });
  });

  /**
   * Records the day pay actually landed for one month — paid early before a
   * holiday weekend, say.
   *
   * The month named is the one the payday belongs to, and moving it moves two
   * boundaries at once: the end of that month's period and the start of the
   * next. Any boundary already pinned on those two periods is released, since
   * a pinned date would otherwise outrank the correction being made here.
   */
  app.put<{ Params: { month: string }; Body: { paidOn?: string; note?: string | null } }>(
    '/api/pay-schedule/overrides/:month',
    async (request, reply) => {
      const month = request.params.month;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return reply.code(400).send({ error: 'month must be YYYY-MM' });
      }
      const paidOn = (request.body?.paidOn ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) {
        return reply.code(400).send({ error: 'paidOn must be YYYY-MM-DD' });
      }
      // A payday belongs to its month, give or take the few days either side a
      // real early or late run moves it.
      const distance = Math.abs(Date.parse(paidOn) - Date.parse(`${month}-15`));
      if (!Number.isFinite(distance) || distance > 40 * 24 * 60 * 60 * 1000) {
        return reply.code(400).send({ error: `${paidOn} is not near ${month}` });
      }
      const note =
        typeof request.body?.note === 'string' && request.body.note.trim() !== ''
          ? request.body.note.trim()
          : null;

      await withTransaction(async (client) => {
        await client.query(
          `insert into pay_overrides (month, paid_on, note)
           values ($1::date, $2::date, $3)
           on conflict (month) do update set paid_on = excluded.paid_on, note = excluded.note`,
          [`${month}-01`, paidOn, note],
        );
        await client.query(
          'update budget_months set period_end = null where month = $1::date',
          [`${month}-01`],
        );
        await client.query(
          'update budget_months set period_start = null where month = $1::date',
          [`${shiftMonth(month, 1)}-01`],
        );
      });

      const schedule = await loadSchedule();
      return reply.send({
        month,
        paidOn,
        period: periodFor(month, schedule.rules, schedule.overrides),
        next: periodFor(shiftMonth(month, 1), schedule.rules, schedule.overrides),
        preview: previewPeriods(schedule),
      });
    },
  );

  /** Puts a month back on the standing schedule. */
  app.delete<{ Params: { month: string } }>(
    '/api/pay-schedule/overrides/:month',
    async (request, reply) => {
      const month = request.params.month;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return reply.code(400).send({ error: 'month must be YYYY-MM' });
      }

      const removed = await withTransaction(async (client) => {
        const result = await client.query('delete from pay_overrides where month = $1::date', [
          `${month}-01`,
        ]);
        if (result.rowCount) {
          await client.query('update budget_months set period_end = null where month = $1::date', [
            `${month}-01`,
          ]);
          await client.query(
            'update budget_months set period_start = null where month = $1::date',
            [`${shiftMonth(month, 1)}-01`],
          );
        }
        return result.rowCount ?? 0;
      });
      if (removed === 0) return reply.code(404).send({ error: 'not found' });

      return reply.send({ deleted: month, preview: previewPeriods(await loadSchedule()) });
    },
  );

  /**
   * Drops the boundaries pinned to past periods so they follow the current
   * schedule again. Kept as an explicit action because it rewrites the shape of
   * history: a period that has already been reported on will move.
   */
  app.post<{ Body: { from?: string } }>('/api/pay-schedule/rederive', async (request, reply) => {
    const from = (request.body?.from ?? '').trim();
    const schedule = await loadSchedule();

    const affected = await withTransaction(async (client) => {
      const result = from.match(/^\d{4}-(0[1-9]|1[0-2])$/)
        ? await client.query(
            `update budget_months set period_start = null, period_end = null
             where month >= $1::date returning month`,
            [`${from}-01`],
          )
        : await client.query(
            'update budget_months set period_start = null, period_end = null returning month',
          );
      return result.rowCount ?? 0;
    });

    return reply.send({ rederived: affected, preview: previewPeriods(schedule) });
  });
}
