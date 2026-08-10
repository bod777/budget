import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import { resolveCounterparty } from '../lib/counterparties.ts';
import { tidy } from '../lib/text.ts';

type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'yearly';

const CADENCES: Cadence[] = ['weekly', 'fortnightly', 'monthly', 'yearly'];

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/**
 * Coerces a date coming back from Postgres to a UTC-midnight timestamp.
 * Scalar `date` columns arrive as ISO strings (see the type parser in db.ts)
 * but `array_agg(date)` bypasses it and yields Date objects, so both shapes
 * have to be handled or every interval comes out NaN.
 */
function dateToTime(value: unknown): number {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  return parseIso(String(value).slice(0, 10)).getTime();
}

/**
 * Dates on which a rule falls due, strictly after `after` and up to `until`.
 *
 * Monthly rules clamp to the end of short months, so a rule anchored on the
 * 31st still fires in February rather than skipping it.
 */
export function occurrencesBetween(
  cadence: Cadence,
  anchorIso: string,
  after: string,
  until: string,
): string[] {
  const anchor = parseIso(anchorIso);
  const afterDate = parseIso(after);
  const untilDate = parseIso(until);
  const results: string[] = [];

  if (cadence === 'weekly' || cadence === 'fortnightly') {
    const step = cadence === 'weekly' ? 7 : 14;
    const dayMs = 86_400_000;
    let cursor = anchor.getTime();
    if (cursor <= afterDate.getTime()) {
      const stepsBehind = Math.floor((afterDate.getTime() - cursor) / (step * dayMs)) + 1;
      cursor += stepsBehind * step * dayMs;
    }
    while (cursor <= untilDate.getTime()) {
      results.push(toIso(new Date(cursor)));
      cursor += step * dayMs;
    }
    return results;
  }

  if (cadence === 'monthly') {
    const anchorDay = anchor.getUTCDate();
    let year = afterDate.getUTCFullYear();
    let month = afterDate.getUTCMonth();
    for (let guard = 0; guard < 480; guard++) {
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = new Date(Date.UTC(year, month, Math.min(anchorDay, daysInMonth)));
      if (candidate.getTime() > untilDate.getTime()) break;
      if (candidate.getTime() > afterDate.getTime() && candidate.getTime() >= anchor.getTime()) {
        results.push(toIso(candidate));
      }
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
    return results;
  }

  // yearly
  const anchorMonth = anchor.getUTCMonth();
  const anchorDay = anchor.getUTCDate();
  for (
    let year = afterDate.getUTCFullYear();
    year <= untilDate.getUTCFullYear() + 1;
    year += 1
  ) {
    const daysInMonth = new Date(Date.UTC(year, anchorMonth + 1, 0)).getUTCDate();
    const candidate = new Date(Date.UTC(year, anchorMonth, Math.min(anchorDay, daysInMonth)));
    if (candidate.getTime() > untilDate.getTime()) break;
    if (candidate.getTime() > afterDate.getTime() && candidate.getTime() >= anchor.getTime()) {
      results.push(toIso(candidate));
    }
  }
  return results;
}

/**
 * Materialises anything now due into `pending_entries`. Nothing lands in
 * `entries` here: an auto-logged item that never actually got charged would
 * otherwise quietly corrupt the month.
 */
export async function generatePending(today = toIso(new Date())): Promise<number> {
  const rules = await query<{
    id: number;
    kind: 'expense' | 'income';
    description: string;
    counterparty_id: number | null;
    amount: number | null;
    category_id: number;
    channel_id: number | null;
    cadence: Cadence;
    anchor_date: string;
    last_generated_on: string | null;
  }>(`select * from recurring_rules where active = true`);

  let created = 0;

  for (const rule of rules) {
    // Start from the last generated date, or from the anchor, but never
    // backfill more than 60 days after a long gap.
    const floor = toIso(new Date(parseIso(today).getTime() - 60 * 86_400_000));
    const after =
      rule.last_generated_on && rule.last_generated_on > floor
        ? rule.last_generated_on
        : floor;

    const due = occurrencesBetween(rule.cadence, rule.anchor_date, after, today);
    if (due.length === 0) continue;

    await withTransaction(async (client) => {
      for (const dueOn of due) {
        const result = await client.query(
          `insert into pending_entries
             (recurring_rule_id, due_on, kind, description, counterparty_id,
              amount, category_id, channel_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (recurring_rule_id, due_on) do nothing
           returning id`,
          [
            rule.id,
            dueOn,
            rule.kind,
            rule.description,
            rule.counterparty_id,
            rule.amount,
            rule.category_id,
            rule.channel_id,
          ],
        );
        if (result.rows.length > 0) created += 1;
      }
      await client.query('update recurring_rules set last_generated_on = $2 where id = $1', [
        rule.id,
        due[due.length - 1],
      ]);
    });
  }

  return created;
}

export function registerRecurringRoutes(app: FastifyInstance) {
  app.get('/api/recurring', async (_request, reply) => {
    const rules = await query(
      `select r.id, r.kind, r.description, r.counterparty_id as "counterpartyId",
              cp.name as counterparty, r.amount, r.category_id as "categoryId",
              cat.name as category, r.channel_id as "channelId", ch.name as channel,
              r.cadence, r.anchor_date as "anchorDate", r.active,
              r.last_generated_on as "lastGeneratedOn"
       from recurring_rules r
       left join counterparties cp on cp.id = r.counterparty_id
       join categories cat on cat.id = r.category_id
       left join channels ch on ch.id = r.channel_id
       order by r.active desc, r.cadence, r.description`,
    );
    return reply.send({ rules });
  });

  app.post<{
    Body: {
      kind?: string;
      description?: string;
      counterparty?: string | null;
      amount?: number | null;
      categoryId?: number;
      channelId?: number | null;
      cadence?: string;
      anchorDate?: string;
    };
  }>('/api/recurring', async (request, reply) => {
    const body = request.body ?? {};
    const kind = body.kind === 'income' ? 'income' : 'expense';
    const description = tidy(body.description ?? '');
    const cadence = CADENCES.includes(body.cadence as Cadence) ? (body.cadence as Cadence) : null;
    const anchorDate = (body.anchorDate ?? '').trim();

    if (description === '') return reply.code(400).send({ error: 'description is required' });
    if (!cadence) return reply.code(400).send({ error: 'cadence is invalid' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
      return reply.code(400).send({ error: 'anchorDate must be YYYY-MM-DD' });
    }
    if (!Number.isInteger(Number(body.categoryId))) {
      return reply.code(400).send({ error: 'categoryId is required' });
    }

    const rule = await withTransaction(async (client) => {
      const counterpartyId = await resolveCounterparty(client, body.counterparty);
      const result = await client.query<{ id: number }>(
        `insert into recurring_rules
           (kind, description, counterparty_id, amount, category_id, channel_id,
            cadence, anchor_date)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          kind,
          description,
          counterpartyId,
          body.amount ?? null,
          Number(body.categoryId),
          body.channelId ?? null,
          cadence,
          anchorDate,
        ],
      );
      return result.rows[0]!;
    });

    return reply.code(201).send({ id: rule.id });
  });

  app.patch<{ Params: { id: string }; Body: { active?: boolean; amount?: number | null } }>(
    '/api/recurring/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
      const rows = await query(
        `update recurring_rules set
           active = coalesce($2, active),
           amount = case when $3::boolean then $4 else amount end
         where id = $1 returning id`,
        [
          id,
          request.body?.active ?? null,
          Object.prototype.hasOwnProperty.call(request.body ?? {}, 'amount'),
          request.body?.amount ?? null,
        ],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
      return reply.send({ updated: id });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/recurring/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const rows = await query('delete from recurring_rules where id = $1 returning id', [id]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return reply.send({ deleted: id });
  });

  app.get('/api/pending', async (_request, reply) => {
    await generatePending();
    const pending = await query(
      `select p.id, p.due_on as "dueOn", p.kind, p.description,
              p.counterparty_id as "counterpartyId", cp.name as counterparty,
              p.amount, p.category_id as "categoryId", cat.name as category,
              p.channel_id as "channelId", ch.name as channel,
              p.recurring_rule_id as "ruleId"
       from pending_entries p
       left join counterparties cp on cp.id = p.counterparty_id
       join categories cat on cat.id = p.category_id
       left join channels ch on ch.id = p.channel_id
       where p.status = 'pending'
       order by p.due_on asc, p.id asc`,
    );
    return reply.send({ pending });
  });

  app.post<{ Params: { id: string }; Body: { amount?: number; occurredOn?: string } }>(
    '/api/pending/:id/confirm',
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

      const result = await withTransaction(async (client) => {
        const rows = await client.query<{
          id: number;
          due_on: string;
          kind: string;
          description: string;
          counterparty_id: number | null;
          amount: number | null;
          category_id: number;
          channel_id: number | null;
          recurring_rule_id: number;
          status: string;
        }>('select * from pending_entries where id = $1 for update', [id]);

        const pending = rows.rows[0];
        if (!pending) return { error: 'not found' as const };
        if (pending.status !== 'pending') return { error: 'already resolved' as const };

        const amount = request.body?.amount ?? pending.amount;
        if (amount === null || amount === undefined) {
          return { error: 'amount is required for this rule' as const };
        }

        const inserted = await client.query<{ id: number }>(
          `insert into entries
             (kind, occurred_on, description, counterparty_id, amount,
              category_id, channel_id, source, recurring_rule_id)
           values ($1, $2, $3, $4, $5, $6, $7, 'recurring', $8)
           returning id`,
          [
            pending.kind,
            request.body?.occurredOn ?? pending.due_on,
            pending.description,
            pending.counterparty_id,
            amount,
            pending.category_id,
            pending.channel_id,
            pending.recurring_rule_id,
          ],
        );

        await client.query(
          `update pending_entries set status = 'confirmed', entry_id = $2 where id = $1`,
          [id, inserted.rows[0]!.id],
        );
        return { entryId: inserted.rows[0]!.id };
      });

      if ('error' in result) {
        const code = result.error === 'not found' ? 404 : 400;
        return reply.code(code).send({ error: result.error });
      }
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>('/api/pending/:id/skip', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const rows = await query(
      `update pending_entries set status = 'skipped'
       where id = $1 and status = 'pending' returning id`,
      [id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found or already resolved' });
    return reply.send({ skipped: id });
  });

  /**
   * Proposes recurring rules by looking for entries that already repeat on a
   * regular cadence, so the fixed items can be set up without typing them out.
   */
  app.get('/api/recurring/suggestions', async (_request, reply) => {
    const rows = await query<{
      description: string;
      counterparty_id: number | null;
      counterparty: string | null;
      category_id: number;
      category: string;
      channel_id: number | null;
      kind: 'expense' | 'income';
      dates: string[];
      amounts: number[];
    }>(
      `select
         (array_agg(e.description order by e.occurred_on desc))[1] as description,
         e.counterparty_id, cp.name as counterparty,
         e.category_id, cat.name as category, e.channel_id, e.kind,
         array_agg(e.occurred_on order by e.occurred_on) as dates,
         array_agg(e.amount order by e.occurred_on) as amounts
       from entries e
       left join counterparties cp on cp.id = e.counterparty_id
       join categories cat on cat.id = e.category_id
       where e.occurred_on >= current_date - 400
       group by lower(btrim(e.description)), e.counterparty_id, cp.name,
                e.category_id, cat.name, e.channel_id, e.kind
       having count(*) >= 4`,
    );

    const existing = new Set(
      (
        await query<{ description: string; counterparty_id: number | null }>(
          'select lower(description) as description, counterparty_id from recurring_rules',
        )
      ).map((r) => `${r.description}|${r.counterparty_id ?? ''}`),
    );

    const suggestions = [];
    for (const row of rows) {
      if (existing.has(`${row.description.toLowerCase()}|${row.counterparty_id ?? ''}`)) continue;

      const dates = row.dates.map((d) => dateToTime(d));
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push((dates[i]! - dates[i - 1]!) / 86_400_000);
      }
      if (gaps.length < 3) continue;

      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      // Require most gaps to sit close to the median, so irregular spending
      // (groceries at whatever shop) is not mistaken for a subscription.
      const tolerance = Math.max(median * 0.25, 2);
      const consistent = gaps.filter((g) => Math.abs(g - median) <= tolerance).length / gaps.length;
      if (consistent < 0.7) continue;

      let cadence: Cadence | null = null;
      if (median >= 5 && median <= 9) cadence = 'weekly';
      else if (median >= 12 && median <= 17) cadence = 'fortnightly';
      else if (median >= 26 && median <= 34) cadence = 'monthly';
      else if (median >= 350 && median <= 380) cadence = 'yearly';
      if (!cadence) continue;

      const amounts = row.amounts.map(Number);
      const last = amounts[amounts.length - 1]!;
      const stable = amounts.every((a) => Math.abs(a - last) <= Math.max(last * 0.05, 0.02));

      suggestions.push({
        kind: row.kind,
        description: row.description,
        counterpartyId: row.counterparty_id,
        counterparty: row.counterparty,
        categoryId: row.category_id,
        category: row.category,
        channelId: row.channel_id,
        cadence,
        anchorDate: toIso(new Date(dates[dates.length - 1]!)),
        amount: stable ? last : null,
        amountVaries: !stable,
        occurrences: dates.length,
        medianGapDays: Math.round(median),
      });
    }

    suggestions.sort((a, b) => b.occurrences - a.occurrences);
    return reply.send({ suggestions });
  });
}
