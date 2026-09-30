import type { FastifyInstance } from 'fastify';
import { query } from '../db.ts';
import { env } from '../env.ts';
import { readSetting, writeSetting } from '../settings.ts';

export function registerReferenceRoutes(app: FastifyInstance) {
  app.get('/api/reference', async (_request, reply) => {
    const [categories, accounts] = await Promise.all([
      query(
        `select id, kind, name, bucket, sort_order as "sortOrder"
         from categories where archived = false
         order by kind, sort_order, name`,
      ),
      query(
        `select id, name, kind, usable_for as "usableFor", sort_order as "sortOrder"
         from accounts where archived = false
         order by sort_order, name`,
      ),
    ]);
    return reply.send({
      categories,
      accounts,
      currency: env.currency,
      locale: env.locale,
    });
  });

  app.get('/api/settings', async (_request, reply) => {
    return reply.send({ liquidFloor: Number(await readSetting('liquid_floor', '0')) || 0 });
  });

  app.put<{ Body: { liquidFloor?: number } }>('/api/settings', async (request, reply) => {
    const floor = Number(request.body?.liquidFloor);
    if (!Number.isFinite(floor) || floor < 0) {
      return reply.code(400).send({ error: 'liquidFloor must be zero or more' });
    }
    await writeSetting('liquid_floor', String(Math.round(floor * 100) / 100));
    return reply.send({ liquidFloor: Math.round(floor * 100) / 100 });
  });

  app.get('/api/health', async (_request, reply) => {
    await query('select 1');
    return reply.send({ ok: true });
  });
}
