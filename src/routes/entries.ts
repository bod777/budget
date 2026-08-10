import type { FastifyInstance } from 'fastify';
import { query, withTransaction } from '../db.ts';
import { resolveCounterparty } from '../lib/counterparties.ts';
import { tidy } from '../lib/text.ts';

interface EntryInput {
  kind?: string;
  occurredOn?: string;
  description?: string;
  counterparty?: string | null;
  amount?: number | string;
  categoryId?: number;
  channelId?: number | null;
  note?: string | null;
  force?: boolean;
}

const SELECT_ENTRY = `
  select
    e.id, e.kind, e.occurred_on as "occurredOn", e.description,
    e.counterparty_id as "counterpartyId", cp.name as counterparty,
    e.amount, e.category_id as "categoryId", cat.name as category,
    cat.bucket, e.channel_id as "channelId", ch.name as channel,
    e.note, e.source, e.logged_at as "loggedAt"
  from entries e
  left join counterparties cp on cp.id = e.counterparty_id
  join categories cat on cat.id = e.category_id
  left join channels ch on ch.id = e.channel_id
`;

interface Validated {
  kind: 'expense' | 'income';
  occurredOn: string;
  description: string;
  counterparty: string | null;
  amount: number;
  categoryId: number;
  channelId: number | null;
  note: string | null;
}

function validate(body: EntryInput): { ok: true; value: Validated } | { ok: false; error: string } {
  const kind = body.kind === 'income' ? 'income' : body.kind === 'expense' ? 'expense' : null;
  if (!kind) return { ok: false, error: 'kind must be "expense" or "income"' };

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

  const categoryId = Number(body.categoryId);
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return { ok: false, error: 'categoryId is required' };
  }

  const channelId =
    body.channelId === null || body.channelId === undefined ? null : Number(body.channelId);
  if (channelId !== null && !Number.isInteger(channelId)) {
    return { ok: false, error: 'channelId must be an integer or null' };
  }

  return {
    ok: true,
    value: {
      kind,
      occurredOn,
      description,
      counterparty: body.counterparty ? tidy(body.counterparty) : null,
      amount: Math.round(amount * 100) / 100,
      categoryId,
      channelId,
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

    if (request.query.kind === 'expense' || request.query.kind === 'income') {
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
        `(lower(e.description) like $${params.length} or lower(cp.name) like $${params.length})`,
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

      if (!request.body.force) {
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
            category_id, channel_id, note, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'manual')
         returning id`,
        [
          value.kind,
          value.occurredOn,
          value.description,
          counterpartyId,
          value.amount,
          value.categoryId,
          value.channelId,
          value.note,
        ],
      );

      const row = await client.query(`${SELECT_ENTRY} where e.id = $1`, [inserted.rows[0]!.id]);
      return { entry: row.rows[0] };
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
             amount = $6, category_id = $7, channel_id = $8, note = $9,
             updated_at = now()
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
            value.channelId,
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
