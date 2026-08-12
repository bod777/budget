import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from './env.ts';
import { query } from './db.ts';

export const COOKIE = 'budget_session';
const SESSION_DAYS = 60;

declare module 'fastify' {
  interface FastifyRequest {
    authed?: boolean;
  }
}

export async function createSession(userAgent: string | undefined): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query(
    'insert into sessions (token, expires_at, user_agent) values ($1, $2, $3)',
    [token, expires, userAgent ?? null],
  );
  return token;
}

/** Single place where the session cookie's flags are decided. */
export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    maxAge: SESSION_DAYS * 86_400,
    signed: false,
  });
}

async function sessionValid(token: string): Promise<boolean> {
  const rows = await query('select 1 from sessions where token = $1 and expires_at > now()', [
    token,
  ]);
  return rows.length > 0;
}

export function registerAuth(app: FastifyInstance) {
  // In local development with no sign-in method configured at all there is
  // nothing to protect against, and requiring a login every restart is pure
  // friction. Configuring either method turns the gate back on.
  const authDisabled = !env.passwordHash && !env.google.enabled;
  if (authDisabled) {
    app.log.warn('No APP_PASSWORD_HASH or Google config — authentication is disabled (dev only)');
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0] ?? '';
    const isApi = url.startsWith('/api/');
    const isPublic =
      url === '/api/session' ||
      url === '/api/health' ||
      // The OAuth handshake necessarily happens before there is a session.
      url.startsWith('/api/auth/') ||
      !isApi; // static assets and the SPA shell handle their own gating

    if (isPublic || authDisabled) {
      request.authed = true;
      return;
    }

    const token = request.cookies[COOKIE];
    if (token && (await sessionValid(token))) {
      request.authed = true;
      return;
    }
    return reply.code(401).send({ error: 'unauthorised' });
  });

  app.get('/api/session', async (request) => {
    const methods = {
      password: Boolean(env.passwordHash),
      google: env.google.enabled,
    };
    if (authDisabled) return { authenticated: true, authDisabled: true, methods };
    const token = request.cookies[COOKIE];
    const authenticated = Boolean(token && (await sessionValid(token)));
    return { authenticated, authDisabled: false, methods };
  });

  app.post<{ Body: { password?: string } }>(
    '/api/session',
    {
      config: {
        rateLimit: { max: 8, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      if (authDisabled) return { authenticated: true, authDisabled: true };
      if (!env.passwordHash) {
        return reply.code(400).send({ error: 'Password sign-in is not configured' });
      }

      const password = request.body?.password ?? '';
      const ok = password !== '' && (await bcrypt.compare(password, env.passwordHash));
      if (!ok) {
        return reply.code(401).send({ error: 'Incorrect password' });
      }

      const token = await createSession(request.headers['user-agent']);
      setSessionCookie(reply, token);
      return { authenticated: true };
    },
  );

  app.delete('/api/session', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) await query('delete from sessions where token = $1', [token]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { authenticated: false };
  });

  // Opportunistic cleanup; there is only ever one user, so this stays tiny.
  setInterval(
    () => {
      query('delete from sessions where expires_at < now()').catch(() => {});
    },
    6 * 3600 * 1000,
  ).unref();
}
