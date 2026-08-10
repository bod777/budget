#!/usr/bin/env bash
# Prints a DATABASE_URL for the deployed Postgres, routed through its TCP proxy.
#
# Railway only exposes the database on the private network by default, so the
# proxy is what makes one-off jobs (the history import) runnable from a laptop.
# Nothing is stored on disk; the URL is derived fresh each time.
set -euo pipefail

export RAILWAY_CALLER="${RAILWAY_CALLER:-skill:use-railway@1.3.7}"

vars=$(railway variable list --service Postgres --json)
proxy=$(railway tcp-proxy list --service Postgres --json)

password=$(node -e "
  const v = JSON.parse(process.argv[1]);
  process.stdout.write(v.PGPASSWORD ?? '');
" "$vars")

endpoint=$(node -e "
  const p = JSON.parse(process.argv[1]);
  const list = Array.isArray(p) ? p : (p.proxies ?? []);
  const first = list[0];
  if (!first) { console.error('No TCP proxy on the Postgres service.'); process.exit(1); }
  process.stdout.write(first.endpoint ?? \`\${first.domain}:\${first.proxyPort}\`);
" "$proxy")

if [ -z "$password" ] || [ -z "$endpoint" ]; then
  echo "Could not resolve the production database URL." >&2
  exit 1
fi

echo "postgresql://postgres:${password}@${endpoint}/railway"
