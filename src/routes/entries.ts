import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import { resolveCounterparty } from '../lib/counterparties.ts';
import { tidy } from '../lib/text.ts';
import { paydayMonthFor, shiftMonth, type PayRule } from '../lib/pay-periods.ts';

interface EntryInput {
  kind?: string;
  occurredOn?: string;
  description?: string;
  counterparty?: string | null;
  amount?: number | string;
  categoryId?: number;
  accountId?: number | null;
  toAccountId?: number | null;
  note?: string | null;
  force?: boolean;
  /** Income only: treat this entry's date as the payday for its period. */
  marksPayday?: boolean;
}

const SELECT_ENTRY = `
  select
    e.id, e.kind, e.occurred_on as "occurredOn", e.description,
    e.counterparty_id as "counterpartyId", cp.name as counterparty,
    e.amount, e.category_id as "categoryId", cat.name as category,
    cat.bucket, e.account_id as "accountId", ch.name as account,
    e.to_account_id as "toAccountId", dest.name as "toAccount",
    e.note, e.source, e.logged_at as "loggedAt"
  from entries e
  left join counterparties cp on cp.id = e.counterparty_id
  left join categories cat on cat.id = e.category_id
  left join accounts ch on ch.id = e.account_id
  left join accounts dest on dest.id = e.to_account_id
`;

interface Validated {
  kind: 'expense' | 'income' | 'transfer';
  occurredOn: string;
  description: string;
  counterparty: string | null;
  amount: number;
  categoryId: number | null;
  accountId: number | null;
  toAccountId: number | null;
  note: string | null;
}

const KINDS = new Set(['expense', 'income', 'transfer']);

function validate(body: EntryInput): { ok: true; value: Validated } | { ok: false; error: string } {
  const kind = KINDS.has(body.kind ?? '') ? (body.kind as Validated['kind']) : null;
  if (!kind) return { ok: false, error: 'kind must be "expense", "income" or "transfer"' };

  const occurredOn = (body.occurredOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    return { ok: false, error: 'occurredOn must be an ISO date (YYYY-MM-DD)' };
  }

  const description = tidy(body.description ?? '');
  if (description === '') return { ok: false, error: 'description is required' };

  const amount = typeof body.amount === 'string' ? Number(body.amount) : body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: 'amount must be a non-negative number' };
  }

  const accountId =
    body.accountId === null || body.accountId === undefined ? null : Number(body.accountId);
  if (accountId !== null && !Number.isInteger(accountId)) {
    return { ok: false, error: 'accountId must be an integer or null' };
  }

  const toAccountId =
    body.toAccountId === null || body.toAccountId === undefined ? null : Number(body.toAccountId);

  // A transfer is a movement between two accounts and belongs to no spending
  // category; anything else must be categorised and must not have a second end.
  let categoryId: number | null = null;
  if (kind === 'transfer') {
    if (accountId === null || toAccountId === null) {
      return { ok: false, error: 'a transfer needs both a from and a to account' };
    }
    if (accountId === toAccountId) {
      return { ok: false, error: 'a transfer must be between two different accounts' };
    }
  } else {
    if (toAccountId !== null) {
      return { ok: false, error: 'only transfers have a destination account' };
    }
    categoryId = Number(body.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return { ok: false, error: 'categoryId is required' };
    }
  }

  return {
    ok: true,
    value: {
      kind,
      occurredOn,
      description,
      counterparty: kind === 'transfer' ? null : body.counterparty ? tidy(body.counterparty) : null,
      amount: Math.round(amount * 100) / 100,
      categoryId,
      accountId,
      toAccountId,
      note: body.note ? tidy(body.note) : null,
    },
  };
}

/**
 * Looks for entries that plausibly duplicate the one being added. Entering a
 * batch of a week's spending from memory makes it genuinely easy to log the
 * same transaction twice, which is exactly what happened a few times in the
 * spreadsheet history.
 */
async function findDuplicates(value: Validated) {
  return query(
    `${SELECT_ENTRY}
     where e.kind = $1
       and e.amount = $2
       and abs(e.occurred_on - $3::date) <= 3
       and (
         ($4::int is not null and e.counterparty_id = $4::int)
         or lower(e.description) = lower($5)
       )
     order by e.occurred_on desc
     limit 5`,
    [
      value.kind,
      value.amount,
      value.occurredOn,
      null, // resolved below when the counterparty already exists
      value.description,
    ],
  );
}

export function registerEntryRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      kind?: string;
      from?: string;
      to?: string;
      categoryId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/entries', async (request, reply) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (
      request.query.kind === 'expense' ||
      request.query.kind === 'income' ||
      request.query.kind === 'transfer'
    ) {
      params.push(request.query.kind);
      conditions.push(`e.kind = $${params.length}`);
    }
    if (request.query.from) {
      params.push(request.query.from);
      conditions.push(`e.occurred_on >= $${params.length}::date`);
    }
    if (request.query.to) {
      params.push(request.query.to);
      conditions.push(`e.occurred_on <= $${params.length}::date`);
    }
    if (request.query.categoryId) {
      params.push(Number(request.query.categoryId));
      conditions.push(`e.category_id = $${params.length}`);
    }
    if (request.query.search) {
      params.push(`%${request.query.search.toLowerCase()}%`);
      conditions.push(
        `(lower(e.description) like $${params.length} or lower(coalesce(cp.name, '')) like $${params.length})`,
      );
    }

    const limit = Math.min(Math.max(Number(request.query.limit ?? 100), 1), 500);
    const offset = Math.max(Number(request.query.offset ?? 0), 0);
    params.push(limit, offset);

    const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
    const rows = await query(
      `${SELECT_ENTRY} ${where}
       order by e.occurred_on desc, e.id desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return reply.send({ entries: rows });
  });

  app.post<{ Body: EntryInput }>('/api/entries', async (request, reply) => {
    const parsed = validate(request.body ?? {});
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const value = parsed.value;

    const created = await withTransaction(async (client) => {
      const counterpartyId = await resolveCounterparty(client, value.counterparty);

      if (!request.body.force && value.kind !== 'transfer') {
        const dupes = await client.query(
          `${SELECT_ENTRY}
           where e.kind = $1
             and e.amount = $2
             and abs(e.occurred_on - $3::date) <= 3
             and (
               ($4::int is not null and e.counterparty_id = $4::int)
               or lower(e.description) = lower($5)
             )
           order by e.occurred_on desc
           limit 5`,
          [value.kind, value.amount, value.occurredOn, counterpartyId, value.description],
        );
        if (dupes.rows.length > 0) {
          return { duplicates: dupes.rows };
        }
      }

      const inserted = await client.query(
        `insert into entries
           (kind, occurred_on, description, counterparty_id, amount,
            category_id, account_id, to_account_id, note, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual')
         returning id`,
        [
          value.kind,
          value.occurredOn,
          value.description,
          counterpartyId,
          value.amount,
          value.categoryId,
          value.accountId,
          value.toAccountId,
          value.note,
        ],
      );

      // Recording the payday happens with the entry, not after it: a salary
      // logged while its period stays open is exactly the mismatch this is
      // meant to prevent.
      let payday: { month: string; closes: string; opens: string } | null = null;
      if (request.body.marksPayday && value.kind === 'income') {
        const ruleRows = await client.query<{ effective_from: string; day_rule: string }>(
          'select effective_from, day_rule from pay_schedule order by effective_from',
        );
        const rules: PayRule[] = ruleRows.rows.map((r) => ({
          effectiveFrom: String(r.effective_from).slice(0, 10),
          dayRule: r.day_rule === 'last' ? 'last' : Number(r.day_rule),
        }));
        if (rules.length > 0) {
          const month = paydayMonthFor(value.occurredOn, rules);
          await client.query(
            `insert into pay_overrides (month, paid_on, note)
             values ($1::date, $2::date, $3)
             on conflict (month) do update set paid_on = excluded.paid_on, note = excluded.note`,
            [`${month}-01`, value.occurredOn, 'marked when logging pay'],
          );
          // Only the two boundaries this moves are unpinned; the rest stand.
          await client.query('update budget_months set period_end = null where month = $1::date', [
            `${month}-01`,
          ]);
          await client.query('update budget_months set period_start = null where month = $1::date', [
            `${shiftMonth(month, 1)}-01`,
          ]);
          payday = { month, closes: month, opens: shiftMonth(month, 1) };
        }
      }

      const row = await client.query(`${SELECT_ENTRY} where e.id = $1`, [inserted.rows[0]!.id]);
      return { entry: row.rows[0], payday };
    });

    if ('duplicates' in created && created.duplicates) {
      return reply.code(409).send({
        error: 'possible duplicate',
        duplicates: created.duplicates,
      });
    }
    return reply.code(201).send(created);
  });

  /** Live duplicate check, so the warning appears before the save is attempted. */
  app.post<{ Body: EntryInput }>('/api/entries/check', async (request, reply) => {
    const parsed = validate(request.body ?? {});
    if (!parsed.ok) return reply.send({ duplicates: [] });
    const duplicates = await findDuplicates(parsed.value);
    return reply.send({ duplicates });
  });

  app.patch<{ Params: { id: string }; Body: EntryInput }>(
    '/api/entries/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });

      const parsed = validate(request.body ?? {});
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const value = parsed.value;

      const updated = await withTransaction(async (client) => {
        const counterpartyId = await resolveCounterparty(client, value.counterparty);
        const result = await client.query(
          `update entries set
             kind = $2, occurred_on = $3, description = $4, counterparty_id = $5,
             amount = $6, category_id = $7, account_id = $8, to_account_id = $9,
             note = $10, updated_at = now()
           where id = $1
           returning id`,
          [
            id,
            value.kind,
            value.occurredOn,
            value.description,
            counterpartyId,
            value.amount,
            value.categoryId,
            value.accountId,
            value.toAccountId,
            value.note,
          ],
        );
        if (result.rows.length === 0) return null;
        const row = await client.query(`${SELECT_ENTRY} where e.id = $1`, [id]);
        return row.rows[0];
      });

      if (!updated) return reply.code(404).send({ error: 'not found' });
      return reply.send({ entry: updated });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const rows = await query('delete from entries where id = $1 returning id', [id]);
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return reply.send({ deleted: id });
  });
}
