# Budget

Replacement for the Google Forms + Sheets budget workflow: a mobile-first PWA
with history-driven autocomplete, a monthly dashboard, and auto-logged
recurring items.

**Live:** https://<your-app>.up.railway.app

## Why it exists

Entry was batched, not live — 20 expenses logged in an 18-minute sitting was
typical, worked out from a bank statement days after the fact. That is where
the errors came from: `Flex Gym` vs `Felx Gym`, `Anthropic` vs `Antrophic`, the
same brunch payback entered twice, an Aldi shop filed under Eating Out.

So the design goal is not "a nicer form" but **type as little as possible, and
catch mistakes at the moment of entry**:

- Picking a suggestion fills description, payee, amount, category and channel
  at once, because almost every entry repeats something already logged.
- Focus then lands on the amount if it historically varies, or on Save if it
  does not — so a gym payment is two taps and a grocery shop is two taps plus
  a number.
- After saving, the date is kept and focus returns to the description, so a
  batch flows without re-selecting anything.
- A duplicate warning appears live, before saving, for anything matching on
  amount and payee within three days.
- Truly fixed items (rent, phone, subscriptions) can be automated entirely and
  just need confirming.

## Architecture

Single Node service serving both the API and the built frontend, with Postgres
behind it.

```
web/          React + Vite PWA (built to web/dist, served by the API)
src/          Fastify API, session auth, migration runner
src/lib/      Pure logic: recurrence maths, text normalisation
db/           Numbered SQL migrations, applied in order at start-up
scripts/      CSV import, dev seed, icon generation
tests/        Node test runner over the pure logic
```

Expenses and income share one `entries` table: both forms collected the same
six fields, so keeping them together makes autocomplete, duplicate detection
and the monthly rollup one query each rather than two.

### Budget periods

Periods run **payday to payday**, not across the calendar month, matching the
spreadsheets. A period is named for the month it ends in, and its end is
exclusive, so the payday that opens a period is counted once — in the period it
funds.

Payday is the nominal day moved back to the previous working day when it lands
on a weekend or an Irish bank holiday. The nominal day is stored in
`pay_schedule` and has already changed once:

| From | Rule | |
|---|---|---|
| 2000-01 | 28th of the month | Employer A |
| 2026-07 | last day of the month | Employer B |

So the July 2026 period ran 26 Jun – 30 Jul: the 28th of June was a Sunday, so
pay landed on Friday the 26th. August ran 31 Jul – 30 Aug.

Bank holidays are computed rather than listed (`src/lib/irish-holidays.ts`),
including Easter and the substitute weekdays taken when a fixed-date holiday
falls at a weekend — which matters, because a Saturday Christmas pushes a
bank holiday onto 28 December.

Getting this wrong is not cosmetic: with calendar months the salary paid on
31 July lands in July, and August shows €120.00 of income instead of €4,000.00.

The schedule is editable in the app under **Settings** (the gear in the top
bar): add a rule when your pay date changes, and a preview shows the periods it
produces before anything depends on them.

Periods already started keep the boundaries stored on `budget_months`, so
editing the schedule cannot retroactively move a period you have already closed
off. "Recalculate past periods" in Settings drops those pinned dates when you
do want history to follow the current rules.

### The surplus chain

Reproduced from the workbook and verified against August 2026, where an
opening surplus of €300.00 plus €1,700.00 gives €2,000.00:

```
incomeSurplus    = income actual − expense actual
thisMonthSurplus = incomeSurplus − savings actual
closingSurplus   = openingSurplus + thisMonthSurplus
```

Opening surplus is stored per month rather than recomputed recursively, so
correcting an old month does not silently rewrite every month after it.

## Local development

```sh
npm install
createdb budget_dev
npm run migrate
npm run dev-seed && npm run import   # synthetic data shaped like the real thing
npm run dev                          # http://localhost:3000
```

Auth is disabled locally whenever `APP_PASSWORD_HASH` is empty, so there is no
login to clear on every restart.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | API + built frontend on :3000 |
| `npm run build` | Compile the API and build the PWA |
| `npm test` | Recurrence and import-coercion tests |
| `npm run migrate` | Apply `db/*.sql` in order |
| `npm run import` | Import `data/raw/{expenses,income}.csv`; add `-- --dry-run` to preview |
| `npm run import:prod` | Same, against the deployed database |
| `npm run dev-seed` | Write synthetic CSVs for local development |
| `npm run set-password -- 'pw'` | Print a bcrypt hash for `APP_PASSWORD_HASH` |

## Importing the Google Sheets history

Export each response sheet with **File → Download → Comma Separated Values**
and save them as:

```
data/raw/expenses.csv     from the "Expenses Record" sheet
data/raw/income.csv       from the income sheet
```

Then preview, review, and import:

```sh
npm run import -- --dry-run    # writes data/import-report.md, touches nothing
cat data/import-report.md
npm run import:prod            # against the live database
```

The importer merges payee spelling variants and drops exact duplicate rows, but
**never rewrites a category or an amount**. Anything that is a judgement call —
near-duplicates, unparseable rows — is listed in the report for review rather
than silently changed.

## Deployment

Railway project `budget`, with two services:

| Service | Notes |
|---|---|
| `budget-app` | This repo. Builds with Railpack, runs migrations then the server. |
| `Postgres` | Managed database, plus a TCP proxy so one-off imports can run locally. |

Deploy with:

```sh
railway up --service budget-app
```

Migrations run on every boot and are tracked in `schema_migrations`, so
deploying a new `db/*.sql` file applies it automatically.

### Changing the password

```sh
npm run set-password -- 'a new password'
railway variable set 'APP_PASSWORD_HASH=<the printed hash>' --service budget-app
```

Existing sessions survive a password change; delete rows from `sessions` to
force a sign-out everywhere.

### Google sign-in

Optional, and off until all three variables are set. Password sign-in stays
available alongside it, so a misconfigured OAuth client cannot lock you out.

**1. Create the OAuth client** at
[console.cloud.google.com](https://console.cloud.google.com) → APIs & Services:

- **OAuth consent screen** → **External**. Leave it in **Testing** and add your
  own address as a test user; that avoids Google's verification review. The
  usual Testing-mode drawback (refresh tokens expiring after 7 days) does not
  apply here, because Google is used once at sign-in to mint a local session
  and no Google token is retained.
- **Credentials → Create credentials → OAuth client ID → Web application**.

**2. Register both redirect URIs**, exactly:

```
https://<your-app>.up.railway.app/api/auth/google/callback
http://localhost:3000/api/auth/google/callback
```

**3. Set the variables:**

```sh
railway variable set 'GOOGLE_CLIENT_ID=<client id>' --service budget-app
railway variable set 'GOOGLE_CLIENT_SECRET=<client secret>' --service budget-app
railway variable set 'ALLOWED_EMAIL=you@gmail.com' --service budget-app
railway variable set 'PUBLIC_URL=https://<your-app>.up.railway.app' --service budget-app
```

`ALLOWED_EMAIL` is a comma-separated allow-list and is **not optional**. An
OAuth client establishes who someone is; it says nothing about whether they may
read this data. Without the list, the sign-in button would admit anyone with a
Google account, so sign-in stays disabled until it is set.

`PUBLIC_URL` fixes the redirect URI rather than deriving it from proxy headers,
because Google matches it against the registered value character for character.

## Security notes

- Single password, bcrypt-hashed, checked against a rate-limited endpoint
  (8 attempts per 10 minutes).
- Google sign-in uses the authorisation-code flow with PKCE. `state` is bound
  to a short-lived signed, httpOnly cookie so a callback the user did not
  initiate cannot be replayed at them, and the verified email is checked
  against `ALLOWED_EMAIL` before any session is created. ID token claims
  (issuer, audience, expiry, `email_verified`) are validated in
  `src/lib/google-claims.ts`, which is directly covered by tests.
- Session tokens are random 32-byte values stored server-side, sent as
  `httpOnly` + `secure` + `SameSite=Lax` cookies, expiring after 60 days.
- Every `/api/*` route except `/api/health` and `/api/session` requires a
  valid session.
- The Postgres TCP proxy is a public endpoint guarded only by its password. If
  you would rather not leave it open, remove it after importing:
  `railway tcp-proxy delete --service Postgres` — and recreate it when needed.
