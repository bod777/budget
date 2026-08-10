import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { env } from '../env.ts';

export function registerReferenceRoutes(app: FastifyInstance) {
  app.get('/api/reference', async (_request, reply) => {
    const [categories, channels] = await Promise.all([
      query(
        `select id, kind, name, bucket, sort_order as "sortOrder"
         from categories where archived = false
         order by kind, sort_order, name`,
      ),
      query(
        `select id, name, kinds, sort_order as "sortOrder"
         from channels where archived = false
         order by sort_order, name`,
      ),
    ]);
    return reply.send({
      categories,
      channels,
      currency: env.currency,
      locale: env.locale,
    });
  });

  app.get('/api/health', async (_request, reply) => {
    await query('select 1');
    return reply.send({ ok: true });
  });
}
