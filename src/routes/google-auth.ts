import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.ts';
import { createSession, setSessionCookie } from '../auth.ts';
import { verifyIdTokenClaims } from '../lib/google-claims.ts';

/**
 * Google sign-in, authorisation-code flow with PKCE.
 *
 * Two things carry the security here, and neither is the OAuth client itself:
 *
 *  - `state`, bound to a short-lived signed cookie, so a callback the user did
 *    not initiate cannot be replayed at them.
 *  - the allow-list check on the verified email. An OAuth client establishes
 *    who someone is; it says nothing about whether they may read this data.
 *    Skip that check and the sign-in button admits anyone with a Google
 *    account.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TX_COOKIE = 'budget_oauth_tx';
const TX_SECONDS = 600;

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** Where Google is told to send the user back. Must match the console exactly. */
function redirectUri(request: FastifyRequest): string {
  if (env.publicUrl) return `${env.publicUrl}/api/auth/google/callback`;
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
  const host = request.headers.host ?? `localhost:${env.port}`;
  return `${proto}://${host}/api/auth/google/callback`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Reads the claims out of an ID token.
 *
 * The signature is not checked because this token was just fetched directly
 * from Google's token endpoint over TLS rather than accepted from the client —
 * the case Google's own documentation exempts from local verification. The
 * claims below still have to be checked: TLS proves where the token came from,
 * not what it says.
 */
function decodeIdToken(idToken: string): Record<string, unknown> | null {
  const segments = idToken.split('.');
  if (segments.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fail(reply: FastifyReply, reason: string) {
  reply.clearCookie(TX_COOKIE, { path: '/' });
  return reply.redirect(`/?auth_error=${encodeURIComponent(reason)}`);
}

export function registerGoogleAuthRoutes(app: FastifyInstance) {
  if (!env.google.enabled) return;

  app.get('/api/auth/google', async (request, reply) => {
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());

    reply.setCookie(TX_COOKIE, JSON.stringify({ state, verifier }), {
      path: '/',
      httpOnly: true,
      // 'lax' still sends the cookie on the top-level GET redirect back from
      // Google, while keeping it off cross-site subrequests.
      sameSite: 'lax',
      secure: env.isProduction,
      maxAge: TX_SECONDS,
      signed: true,
    });

    const params = new URLSearchParams({
      client_id: env.google.clientId,
      redirect_uri: redirectUri(request),
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // The account picker matters when several Google accounts are signed in.
      prompt: 'select_account',
    });

    return reply.redirect(`${AUTH_ENDPOINT}?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/google/callback',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      if (request.query.error) return fail(reply, request.query.error);

      const raw = request.cookies[TX_COOKIE];
      if (!raw) return fail(reply, 'Sign-in expired, please try again');

      const unsigned = request.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return fail(reply, 'Sign-in could not be verified');

      let tx: { state?: string; verifier?: string };
      try {
        tx = JSON.parse(unsigned.value);
      } catch {
        return fail(reply, 'Sign-in could not be verified');
      }

      const code = request.query.code ?? '';
      const state = request.query.state ?? '';
      if (!code || !state || !tx.state || !tx.verifier) {
        return fail(reply, 'Sign-in could not be verified');
      }
      if (!constantTimeEqual(state, tx.state)) {
        return fail(reply, 'Sign-in could not be verified');
      }

      let payload: { id_token?: string };
      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.google.clientId,
            client_secret: env.google.clientSecret,
            redirect_uri: redirectUri(request),
            grant_type: 'authorization_code',
            code_verifier: tx.verifier,
          }),
        });
        if (!response.ok) {
          app.log.warn({ status: response.status }, 'google token exchange failed');
          return fail(reply, 'Google sign-in failed');
        }
        payload = (await response.json()) as { id_token?: string };
      } catch (error) {
        app.log.error(error, 'google token exchange errored');
        return fail(reply, 'Google sign-in failed');
      }

      const claims = payload.id_token ? decodeIdToken(payload.id_token) : null;
      const verdict = verifyIdTokenClaims(claims, {
        clientId: env.google.clientId,
        allowedEmails: env.google.allowedEmails,
      });

      if (!verdict.ok) {
        app.log.warn({ reason: verdict.reason }, 'rejected Google sign-in');
        // The allow-list message is worth showing; the rest would only help
        // someone probing the endpoint.
        return fail(
          reply,
          verdict.reason.includes('not allowed')
            ? 'That Google account is not allowed to use this app'
            : 'Google sign-in failed',
        );
      }

      const token = await createSession(request.headers['user-agent']);
      setSessionCookie(reply, token);
      reply.clearCookie(TX_COOKIE, { path: '/' });
      return reply.redirect('/');
    },
  );
}
