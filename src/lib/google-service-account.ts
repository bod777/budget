import { createSign } from 'node:crypto';

/**
 * Access tokens for a Google service account.
 *
 * A service account is used rather than the sign-in OAuth client because the
 * two jobs are different: one proves who is at the keyboard, the other lets the
 * server write to a spreadsheet at 3am with nobody there. Bolting a write scope
 * onto the login flow would also drag it into Google's verification review.
 *
 * The flow is a self-signed JWT exchanged for an access token, which needs no
 * dependency beyond node's crypto.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Parses the JSON key file contents from an environment variable. */
export function parseServiceAccount(raw: string): ServiceAccountKey | null {
  if (!raw.trim()) return null;
  try {
    // Accept both raw JSON and base64, since pasting a multi-line private key
    // into a variable often mangles the newlines.
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return {
      client_email: parsed.client_email,
      // Variables set through a dashboard often arrive with literal \n.
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
    };
  } catch {
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

let cached: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(
  key: ServiceAccountKey,
  scope = 'https://www.googleapis.com/auth/spreadsheets',
): Promise<string> {
  // Re-use until a minute before expiry rather than minting one per call.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign(key.private_key).toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error('Google returned no access token');

  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Drops the cached token; used when a request comes back unauthorised. */
export function clearTokenCache() {
  cached = null;
}
