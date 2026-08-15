import { parseServiceAccount } from './lib/google-service-account.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function emailList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const serviceAccount = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '');
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !serviceAccount) {
  console.warn('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed — mirroring is disabled.');
}

const googleClientId = process.env.GOOGLE_CLIENT_ID ?? '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
const allowedEmails = emailList(process.env.ALLOWED_EMAIL ?? '');

export const env = {
  port: Number(process.env.PORT ?? 3000),
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: required('SESSION_SECRET'),
  // Absent in local dev, where auth is bypassed. Required in production
  // unless Google sign-in is configured instead.
  passwordHash: process.env.APP_PASSWORD_HASH ?? '',

  google: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    /**
     * Who is allowed in. An OAuth client establishes *who someone is*, not
     * whether they may see this data — without this list, anyone with a Google
     * account could sign in, so sign-in stays disabled until it is set.
     */
    allowedEmails,
    enabled: Boolean(googleClientId && googleClientSecret && allowedEmails.length > 0),
  },

  /**
   * Origin used to build the OAuth redirect URI. Google matches it exactly
   * against the registered value, so it is configured rather than guessed from
   * proxy headers.
   */
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),

  sheets: {
    serviceAccount,
    spreadsheetId: (process.env.SHEETS_SPREADSHEET_ID ?? '').trim(),
    enabled: Boolean(serviceAccount && (process.env.SHEETS_SPREADSHEET_ID ?? '').trim()),
  },

  /** Local currency, used for formatting only. */
  currency: process.env.CURRENCY ?? 'EUR',
  locale: process.env.LOCALE ?? 'en-IE',
};

if (env.isProduction && !env.passwordHash && !env.google.enabled) {
  throw new Error(
    'Set APP_PASSWORD_HASH, or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + ALLOWED_EMAIL, in production',
  );
}

if (googleClientId && googleClientSecret && allowedEmails.length === 0) {
  // Loud, because the failure mode is silent and total: a working sign-in
  // button that lets in the entire internet.
  console.warn(
    '[auth] Google credentials are set but ALLOWED_EMAIL is empty — Google sign-in stays disabled.',
  );
}
