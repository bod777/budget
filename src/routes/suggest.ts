import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';

/**
 * Autocomplete is built from the shape of the history rather than a hand-kept
 * list of favourites: a "template" is a combination of description, payee,
 * category and channel that has been entered before. Picking one fills the
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
      e.channel_id,
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
    group by 1, 2, 3, 4
  )
  select
    g.description,
    g.counterparty_id,
    cp.name as counterparty,
    g.category_id,
    cat.name as category,
    g.channel_id,
    ch.name as channel,
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
  left join channels ch on ch.id = g.channel_id
  where
    $3 = ''
    or g.desc_key like '%' || lower($3) || '%'
    or coalesce(lower(cp.name), '') like '%' || lower($3) || '%'
  order by score desc, g.last_used desc
  limit $4::int
`;

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
   * The zero-typing path: the handful of things logged often enough to deserve
   * a single tap. Restricted to templates with a stable amount, because a chip
   * that fills in the wrong number is worse than no chip.
   */
  app.get<{ Querystring: { kind?: string; limit?: string } }>(
    '/api/suggest/quick',
    async (request, reply) => {
      const kind = request.query.kind === 'income' ? 'income' : 'expense';
      const limit = Math.min(Math.max(Number(request.query.limit ?? 8), 1), 20);

      const rows = await query(
        `select * from (${TEMPLATE_SQL}) t
         where t.uses >= 3 and t.amount_varies = false
         order by t.score desc
         limit $5::int`,
        [kind, 365, '', 60, limit],
      );
      return reply.send({ quick: rows });
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
           (array_agg(e.channel_id order by e.occurred_on desc, e.id desc))[1] as channel_id
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
