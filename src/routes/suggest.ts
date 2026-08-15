import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { normaliseKey } from '../lib/text.ts';

/**
 * Autocomplete is built from the shape of the history rather than a hand-kept
 * list of favourites: a "template" is a combination of description, payee,
 * category and account that has been entered before. Picking one fills the
 * whole form, which is the point -- the vast majority of entries are repeats
 * of something already logged.
 *
 * Ranking is frequency with a 90-day half-life, so a weekly shop outranks a
 * subscription cancelled last year without either being manually curated.
 */
const TEMPLATE_SQL = `
  with grouped as (
    select
      lower(regexp_replace(btrim(e.description), '\\s+', ' ', 'g')) as desc_key,
      e.counterparty_id,
      e.category_id,
      -- Account is deliberately not a grouping key. Paying for the same weekly
      -- shop on a different card does not make it a different habit, and
      -- grouping by it splits one entry into several near-identical
      -- suggestions that crowd out genuinely different ones. The most recent
      -- account is offered instead, and is trivially changed at entry.
      (array_agg(e.account_id order by e.occurred_on desc, e.id desc))[1] as account_id,
      count(*)::int as uses,
      max(e.occurred_on) as last_used,
      (array_agg(e.description order by e.occurred_on desc, e.id desc))[1] as description,
      (array_agg(e.amount order by e.occurred_on desc, e.id desc))[1] as last_amount,
      percentile_cont(0.5) within group (order by e.amount) as median_amount,
      min(e.amount) as min_amount,
      max(e.amount) as max_amount
    from entries e
    where e.kind = $1
      and e.occurred_on >= current_date - $2::int
    group by 1, 2, 3
  )
  select
    g.description,
    g.counterparty_id,
    cp.name as counterparty,
    g.category_id,
    cat.name as category,
    g.account_id,
    ch.name as account,
    g.uses,
    g.last_used,
    g.last_amount,
    -- percentile_cont returns double precision; round() needs numeric.
    round(g.median_amount::numeric, 2) as median_amount,
    g.min_amount,
    g.max_amount,
    -- Flag templates whose amount is not reliably repeatable, so the UI can
    -- prefill it but invite a second look.
    (g.max_amount - g.min_amount) > greatest(g.median_amount * 0.15, 0.02) as amount_varies,
    (
      g.uses::float
      * power(0.5, greatest(current_date - g.last_used, 0)::float / 90)
      * case
          when $3 = '' then 1.0
          when g.desc_key like lower($3) || '%' then 3.0
          when coalesce(lower(cp.name), '') like lower($3) || '%' then 2.0
          else 1.0
        end
    ) as score
  from grouped g
  left join counterparties cp on cp.id = g.counterparty_id
  join categories cat on cat.id = g.category_id
  left join accounts ch on ch.id = g.account_id
  where
    $3 = ''
    or g.desc_key like '%' || lower($3) || '%'
    or coalesce(lower(cp.name), '') like '%' || lower($3) || '%'
  order by score desc, g.last_used desc
  limit $4::int
`;

export function templateKey(t: {
  description: string;
  counterparty_id: number | null;
  category_id: number;
}): string {
  return `${normaliseKey(t.description)}|${t.counterparty_id ?? ''}|${t.category_id}`;
}

interface QuickPickRow {
  template_key: string;
  pinned: boolean;
  hidden: boolean;
  sort_order: number;
}

export function registerSuggestRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { kind?: string; q?: string; limit?: string; windowDays?: string };
  }>('/api/suggest', async (request, reply) => {
    const kind = request.query.kind === 'income' ? 'income' : 'expense';
    const q = (request.query.q ?? '').trim();
    const limit = Math.min(Math.max(Number(request.query.limit ?? 8), 1), 40);
    // Two years of history keeps yearly subscriptions discoverable.
    const windowDays = Math.min(Math.max(Number(request.query.windowDays ?? 730), 30), 3650);

    const rows = await query(TEMPLATE_SQL, [kind, windowDays, q, limit]);
    return reply.send({ templates: rows });
  });

  /**
   * The zero-typing path: the handful of things worth a single tap.
   *
   * Pinned choices come first and always show. The rest is filled
   * automatically from what repeats with a stable amount -- a button that
   * fills in the wrong number is worse than no button -- skipping anything
   * explicitly hidden.
   */
  app.get<{ Querystring: { kind?: string; limit?: string } }>(
    '/api/suggest/quick',
    async (request, reply) => {
      const kind = request.query.kind === 'income' ? 'income' : 'expense';
      const limit = Math.min(Math.max(Number(request.query.limit ?? 8), 1), 20);

      const [candidates, overrides] = await Promise.all([
        query(TEMPLATE_SQL, [kind, 400, '', 80]),
        query<QuickPickRow>(
          'select template_key, pinned, hidden, sort_order from quick_picks where kind = $1',
          [kind],
        ),
      ]);

      const byKey = new Map(overrides.map((row) => [row.template_key, row]));
      const withKeys = (candidates as Record<string, never>[]).map((t) => ({
        template: t,
        key: templateKey(t as never),
      }));

      const pinned = withKeys
        .filter((c) => byKey.get(c.key)?.pinned)
        .sort((a, b) => (byKey.get(a.key)?.sort_order ?? 0) - (byKey.get(b.key)?.sort_order ?? 0));

      const auto = withKeys.filter((c) => {
        const override = byKey.get(c.key);
        if (override?.pinned || override?.hidden) return false;
        const t = c.template as unknown as { uses: number; amount_varies: boolean };
        return t.uses >= 3 && !t.amount_varies;
      });

      return reply.send({
        quick: [...pinned, ...auto].slice(0, limit).map((c) => ({ ...c.template, key: c.key })),
      });
    },
  );

  /** Everything that could be a one-tap button, with its current choice. */
  app.get<{ Querystring: { kind?: string } }>(
    '/api/suggest/quick/options',
    async (request, reply) => {
      const kind = request.query.kind === 'income' ? 'income' : 'expense';
      const [candidates, overrides] = await Promise.all([
        query(TEMPLATE_SQL, [kind, 400, '', 60]),
        query<QuickPickRow>(
          'select template_key, pinned, hidden, sort_order from quick_picks where kind = $1',
          [kind],
        ),
      ]);
      const byKey = new Map(overrides.map((row) => [row.template_key, row]));

      return reply.send({
        options: (candidates as Record<string, never>[]).map((t) => {
          const key = templateKey(t as never);
          const override = byKey.get(key);
          const template = t as unknown as { uses: number; amount_varies: boolean };
          return {
            ...t,
            key,
            pinned: override?.pinned ?? false,
            hidden: override?.hidden ?? false,
            // Whether it would appear on its own, with no choice recorded.
            automatic: template.uses >= 3 && !template.amount_varies,
          };
        }),
      });
    },
  );

  app.put<{ Body: { key?: string; kind?: string; pinned?: boolean; hidden?: boolean } }>(
    '/api/suggest/quick',
    async (request, reply) => {
      const key = (request.body?.key ?? '').trim();
      if (key === '') return reply.code(400).send({ error: 'key is required' });
      const kind = request.body?.kind === 'income' ? 'income' : 'expense';
      const pinned = request.body?.pinned === true;
      const hidden = request.body?.hidden === true;
      if (pinned && hidden) {
        return reply.code(400).send({ error: 'a button cannot be both pinned and hidden' });
      }

      // No choice recorded means "behave automatically", so clearing both
      // removes the row rather than storing two falses.
      if (!pinned && !hidden) {
        await query('delete from quick_picks where template_key = $1', [key]);
        return reply.send({ key, pinned: false, hidden: false });
      }

      await query(
        `insert into quick_picks (template_key, kind, pinned, hidden, sort_order)
         values ($1, $2, $3, $4, coalesce((select max(sort_order) + 1 from quick_picks), 0))
         on conflict (template_key) do update set
           pinned = excluded.pinned, hidden = excluded.hidden, kind = excluded.kind`,
        [key, kind, pinned, hidden],
      );
      return reply.send({ key, pinned, hidden });
    },
  );

  /** Payee/payer type-ahead, ranked the same way. */
  app.get<{ Querystring: { kind?: string; q?: string; limit?: string } }>(
    '/api/suggest/counterparties',
    async (request, reply) => {
      const kind = request.query.kind === 'income' ? 'income' : 'expense';
      const q = (request.query.q ?? '').trim();
      const limit = Math.min(Math.max(Number(request.query.limit ?? 8), 1), 30);

      const rows = await query(
        `select
           cp.id,
           cp.name,
           count(*)::int as uses,
           max(e.occurred_on) as last_used,
           (array_agg(e.category_id order by e.occurred_on desc, e.id desc))[1] as category_id,
           (array_agg(e.account_id order by e.occurred_on desc, e.id desc))[1] as account_id
         from entries e
         join counterparties cp on cp.id = e.counterparty_id
         where e.kind = $1
           and ($2 = '' or lower(cp.name) like '%' || lower($2) || '%')
         group by cp.id, cp.name
         order by
           (count(*)::float * power(0.5, greatest(current_date - max(e.occurred_on), 0)::float / 90))
             * case when lower(cp.name) like lower($2) || '%' then 3.0 else 1.0 end desc
         limit $3::int`,
        [kind, q, limit],
      );
      return reply.send({ counterparties: rows });
    },
  );
}
