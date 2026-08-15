import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { env } from './env.ts';
import { registerAuth } from './auth.ts';
import { registerGoogleAuthRoutes } from './routes/google-auth.ts';
import { registerReferenceRoutes } from './routes/reference.ts';
import { registerAccountRoutes } from './routes/accounts.ts';
import { registerEntryRoutes } from './routes/entries.ts';
import { registerSuggestRoutes } from './routes/suggest.ts';
import { registerBudgetRoutes } from './routes/budget.ts';
import { registerPayScheduleRoutes } from './routes/pay-schedule.ts';
import { registerRecurringRoutes, generatePending } from './routes/recurring.ts';
import { registerSheetSyncRoutes, scheduleSheetSync } from './routes/sheet-sync.ts';
import { pool } from './db.ts';

const here = dirname(fileURLToPath(import.meta.url));
// dist/server.js in production, src/server.ts under tsx.
const projectRoot = join(here, '..');
const webDist = join(projectRoot, 'web', 'dist');

const app = Fastify({
  logger: {
    level: env.isProduction ? 'info' : 'warn',
    transport: env.isProduction ? undefined : { target: 'pino-pretty' },
  },
  trustProxy: true,
});

await app.register(cookie, { secret: env.sessionSecret });
await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

registerAuth(app);
registerGoogleAuthRoutes(app);
registerReferenceRoutes(app);
registerAccountRoutes(app);
registerEntryRoutes(app);
registerSuggestRoutes(app);
registerBudgetRoutes(app);
registerPayScheduleRoutes(app);
registerRecurringRoutes(app);
registerSheetSyncRoutes(app);

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  // SPA fallback: anything that is not an API route serves the shell. Static
  // files are matched first, so hashed assets never reach this.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`no built frontend at ${webDist} — API only`);
}

// Materialise anything due at boot and once an hour after that, so pending
// items are waiting whenever the app is opened.
generatePending().catch((error) => app.log.error(error, 'initial recurring generation failed'));
setInterval(
  () => {
    generatePending().catch((error) => app.log.error(error, 'recurring generation failed'));
  },
  3600 * 1000,
).unref();

scheduleSheetSync(app);

const close = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: env.port, host: '0.0.0.0' });
