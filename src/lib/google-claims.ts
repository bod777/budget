/**
 * Validation of the claims in a Google ID token.
 *
 * Kept separate from the route so it can be tested directly: this is the check
 * that decides who gets to read three years of financial history, and every
 * failure mode here is silent — a wrong answer looks exactly like a successful
 * login.
 */

export interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

export type ClaimResult =
  | { ok: true; email: string }
  | { ok: false; reason: string; allowedFailure?: false };

const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export function verifyIdTokenClaims(
  claims: IdTokenClaims | null,
  options: { clientId: string; allowedEmails: string[]; now?: number },
): ClaimResult {
  if (!claims) return { ok: false, reason: 'malformed token' };

  const now = options.now ?? Date.now();

  if (typeof claims.iss !== 'string' || !VALID_ISSUERS.has(claims.iss)) {
    return { ok: false, reason: 'unexpected issuer' };
  }
  // Without this, a token minted for a different OAuth client would be
  // accepted -- the classic confused-deputy hole in ID token handling.
  if (claims.aud !== options.clientId) {
    return { ok: false, reason: 'token was not issued for this app' };
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) {
    return { ok: false, reason: 'token expired' };
  }

  // Google only guarantees the address when it says it verified it; an
  // unverified one is whatever the account holder typed in.
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) return { ok: false, reason: 'email not verified' };

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, reason: 'no email in token' };

  // An empty allow-list must never mean "allow everyone".
  if (options.allowedEmails.length === 0) {
    return { ok: false, reason: 'no allowed accounts configured' };
  }
  if (!options.allowedEmails.includes(email)) {
    return { ok: false, reason: 'that Google account is not allowed to use this app' };
  }

  return { ok: true, email };
}
