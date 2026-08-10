# Budget

Replacement for the Google Forms + Sheets budget workflow: a mobile-first PWA
with history-driven autocomplete, a monthly dashboard, and auto-logged
recurring items.

## Why it exists

Entry was batched, not live — 20 expenses logged in an 18-minute sitting was
typical. That is where the transcription errors came from (`Flex Gym` vs
`Felx Gym`, the same brunch payback entered twice). So the design goal is not
"a nicer form" but "type as little as possible, and catch mistakes at entry".

## Setup

```sh
npm install
createdb budget_dev
npm run migrate
npm run dev-seed && npm run import   # synthetic data for local development
npm run dev
```

Point `DATABASE_URL` at the real database and drop the real CSV exports into
`data/raw/` to import actual history instead.

## Scripts

| Script | Purpose |
|---|---|
| `npm run migrate` | Apply `db/*.sql` in order |
| `npm run import` | Import `data/raw/{expenses,income}.csv`; `-- --dry-run` to preview |
| `npm run dev-seed` | Write synthetic CSVs for local development |
| `npm run set-password -- 'pw'` | Print the bcrypt hash for `APP_PASSWORD_HASH` |

## Importing real data

Export each response sheet with **File → Download → Comma Separated Values**
and save as `data/raw/expenses.csv` and `data/raw/income.csv`. Then:

```sh
npm run import -- --dry-run   # writes data/import-report.md, touches nothing
npm run import
```

The importer merges payee spelling variants and drops exact duplicate rows, but
never rewrites a category or an amount — judgement calls are listed in the
report for review instead.
