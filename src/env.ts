function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: required('SESSION_SECRET'),
  // Absent in local dev, where auth is bypassed. Required in production.
  passwordHash: process.env.APP_PASSWORD_HASH ?? '',
  /** Local currency, used for formatting only. */
  currency: process.env.CURRENCY ?? 'EUR',
  locale: process.env.LOCALE ?? 'en-IE',
};

if (env.isProduction && !env.passwordHash) {
  throw new Error('APP_PASSWORD_HASH must be set in production');
}
