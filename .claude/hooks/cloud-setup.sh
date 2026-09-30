#!/bin/bash
# Cloud-session setup (claude.ai/code). No-op on the laptop: CLAUDE_CODE_REMOTE is only set in the cloud VM.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0

# Pre-installed Postgres 16, not running by default. Idempotent.
pg_db() {
  service postgresql start >/dev/null 2>&1
  runuser -u postgres -- psql -tAc "select 1 from pg_roles where rolname='dev'" | grep -q 1 \
    || runuser -u postgres -- psql -qc "create role dev login superuser password 'dev'"
  runuser -u postgres -- psql -tAc "select 1 from pg_database where datname='$1'" | grep -q 1 \
    || runuser -u postgres -- createdb -O dev "$1"
}

pg_db budget
[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error

# Dev-only values. Never put real credentials here.
[ -f .env ] || cat > .env <<EOF
DATABASE_URL=postgres://dev:dev@localhost:5432/budget
SESSION_SECRET=$(openssl rand -hex 32)
APP_PASSWORD_HASH=
PORT=3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAIL=dev@example.com
PUBLIC_URL=http://localhost:3000
GOOGLE_SERVICE_ACCOUNT_JSON=
SHEETS_SPREADSHEET_ID=
EOF
npm run migrate >/dev/null 2>&1 || echo "note: npm run migrate failed"

echo "Cloud setup: deps installed; local Postgres at postgres://dev:dev@localhost:5432/budget (migrated); dev .env written (APP_PASSWORD_HASH empty, use npm run set-password; Google/Sheets not configured). Never run import:prod here."
exit 0
