# Budget

Replacement for the Google Forms + Sheets budget workflow: a mobile-first PWA
with history-driven autocomplete, a monthly dashboard, and auto-logged
recurring items.

## Why it exists

Entry was batched, not live — 20 expenses logged in an 18-minute sitting was
typical, worked out from a bank statement days after the fact. That is where
the errors came from: `Tesco` vs `Tescos`, `Anthropic` vs `Antrophic`, the
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
`pay_schedule`, and can change over time — with a new job, say:

| From | Rule |
|---|---|
| 2000-01 | 28th of the month |
| 2026-07 | last day of the month |

With that schedule the July 2026 period ran 26 Jun – 30 Jul: the 28th of June
was a Sunday, so pay landed on Friday the 26th. August ran 31 Jul – 30 Aug.
A fresh database starts with a single "last day of the month" rule.

Bank holidays are computed rather than listed (`src/lib/irish-holidays.ts`),
including Easter and the substitute weekdays taken when a fixed-date holiday
falls at a weekend — which matters, because a Saturday Christmas pushes a
bank holiday onto 28 December.

Getting this wrong is not cosmetic: with calendar months the salary paid on
31 July lands in July, and August shows almost no income at all.

The schedule is editable in the app under **Settings** (the gear in the top
bar): add a rule when your pay date changes, and a preview shows the periods it
produces before anything depends on them.

Periods already started keep the boundaries stored on `budget_months`, so
editing the schedule cannot retroactively move a period you have already closed
off. "Recalculate past periods" in Settings drops those pinned dates when you
do want history to follow the current rules.

### Accounts

Every account carries a balance, derived from a starting figure plus everything
logged since, never stored. Accounts are added under **Settings → Accounts and
balances → Add an account**; nothing is seeded beyond the five the Google Forms
used, because which banks you hold money with is personal data and stays out of
the repo.

What an account may be picked for follows from its kind rather than being asked
about separately:

| Kind | Offered for |
|---|---|
| Current, Cash, Other | Expenses, income, transfers |
| Credit card | Expenses and transfers; its balance reads as what is owed |
| Savings | Transfers, and income so interest can be logged — never expenses |

Transfers accept any account regardless, since moving money between two of your
own accounts is neither spending nor earning. Changing an account's kind
re-derives this, so a current account turned into savings stops being offered as
somewhere money was spent.

A starting balance is optional, and an account without one reports its balance
as unknown rather than as zero. **Total saved** is the one figure that needs
them all: it reads as blank until every savings account has a starting balance,
rather than quietly understating what you have put away.

### Recurring items

Two ways in. Anything already repeating in the history gets offered on the
Recurring tab once it has happened four times, and one tap adopts it. Anything
that has not happened yet -- a standing order you have just set up with the
bank -- is entered by hand there under **Set one up**, as an expense, income or
transfer.

Nothing is ever written straight to `entries`. A due rule produces a
`pending_entries` row to confirm, because an item auto-logged but never
actually charged would quietly corrupt the month. Leaving the amount blank
marks it as varying, so it asks instead of prefilling.

Rules are anchored on the occurrence *before* the first one they should
generate, since adopting a pattern from history means the latest occurrence is
already recorded and re-logging it would duplicate it. Setting one up by hand
is the other way round -- what is known is when it next goes out -- so the form
asks for that and derives the anchor (`anchorForFirstDue`). Because month
lengths clamp the day, the form previews the actual dates rather than promising
a cadence: ask for the 31st and it will tell you it is going to fall on the
28th.

### What is spare

The Budget tab leads with what is actually available day to day: every account
that is not savings, with a credit card's debt counted against it. That figure
is derived from the same balances the accounts list shows, so the two cannot
disagree.

Against it sits a **floor** -- what to keep in those accounts rather than sweep
into savings -- set in Settings and stored in `settings.liquid_floor`. It is
seeded at zero, because how much someone wants to hold back is personal and
does not belong in the repository.

Two figures come out of that, and they answer different questions:

```
spare now  = available − floor
at payday  = available − budget not yet spent
                       + income not yet received
                       − savings budgeted but not yet moved
safe to move = at payday − floor
```

`spare now` is what is unclaimed this second. `safe to move` is what is still
unclaimed once the rest of the period is paid for, which is the one to act on:
moving the first and then meeting the rent lands you under the floor. Savings
already budgeted are subtracted because that money is spoken for, and offering
it twice would be the same mistake in a different place.

Both read as `—` when any day-to-day account is missing an opening balance. A
total that quietly leaves an account out still looks like a total.

### The surplus chain

Reproduced from the original budget workbook:

```
incomeSurplus    = income actual − expense actual
thisMonthSurplus = incomeSurplus − savings actual
closingSurplus   = openingSurplus + thisMonthSurplus
```

Opening surplus is stored per month rather than recomputed recursively, so
correcting an old month does not silently rewrite every month after it.

Savings sit in that chain as a *target* per account per period, edited under
**Edit budget** on the Budget tab alongside the category budgets. Only the
target is typed in; what actually went into the account is derived from real
transfers, so the savings section cannot disagree with the ledger. A period
with no target of its own inherits the last one set, and editing any figure
makes it that period's own.

## Local development

```sh
npm install
createdb budget_dev
npm run migrate
npm run dev-seed && npm run import   # synthetic data, no real history needed
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

Spelling variants the importer cannot work out on its own — transposed letters
in a friend's name, say — can be listed in `data/counterparty-aliases.json`:

```json
{ "pat muprhy": "Pat Murphy", "pat murphy": "Pat Murphy" }
```

Keys are the lowercased name with punctuation turned into spaces. Only public
businesses are aliased in code (`scripts/lib/normalise.ts`); anything naming a
person or place stays in that file.

The importer merges payee spelling variants and drops exact duplicate rows, but
**never rewrites a category or an amount**. Anything that is a judgement call —
near-duplicates, unparseable rows — is listed in the report for review rather
than silently changed.

## Private data

Everything personal stays out of the repository. The ledger itself lives only in
Postgres, and `data/` is gitignored in full, holding:

| Path | What |
|---|---|
| `data/raw/*.csv` | Google Form response exports, input to `npm run import` |
| `data/counterparty-aliases.json` | Optional extra payee aliases, see above |
| `data/budget-workbooks.json` | Workbooks for `npm run backfill-budgets`, see below |
| `data/*-report.md` | Reports the import and backfill write for review |

### Backfilling budgets from old workbooks

`npm run backfill-budgets -- --dry-run` reads monthly budget workbooks through
the service account described under Google Sheets backup (share the folder with
it), and takes the budgeted figures and opening surplus from each. List them in
`data/budget-workbooks.json`:

```json
{
  "workbooks": [
    { "id": "<spreadsheet id>", "title": "2026 Budget - 7 July" }
  ],
  "savingsAccounts": { "savings": "Savings Account" }
}
```

`title` must end in the month, as above. `savingsAccounts` maps each savings
label in the sheets (lowercased) to the name of an account in the app.

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

## Google Sheets backup

Optional one-way mirror of the database into a Google Sheet: three tabs
(`Expenses`, `Income`, `Periods`), rewritten in full once a day and on demand
from **Settings**.

**One-way on purpose.** Sheet rows have no stable identifier, so reconciling
edits made on both sides means matching on date, amount and description —
guesswork that loses data silently, and exactly the duplicate-prone situation
this app exists to escape. The database is the source of truth; nothing typed
into the sheet is ever read back.

Each entry carries a **Budget period** column, so the sheet can be pivoted by
payday-to-payday period rather than calendar month — which is the thing a plain
CSV export cannot give you.

### Setting it up

**1. Create a service account** — a robot account for the server, separate from
the OAuth client used for sign-in. A login credential should not also carry
data-writing powers, and adding a Sheets scope to the sign-in flow would drag it
into Google's verification review.

- [console.cloud.google.com](https://console.cloud.google.com) → IAM & Admin →
  Service Accounts → **Create service account**
- Then **Keys → Add key → Create new key → JSON**, and download it
- Enable the **Google Sheets API** for the project under APIs & Services

**2. Create a spreadsheet** and share it with the service account's email
(`something@project.iam.gserviceaccount.com`) as an **Editor**. Take the id from
its URL: `docs.google.com/spreadsheets/d/<THIS_PART>/edit`.

**3. Set the variables:**

```sh
# base64 avoids the private key's newlines being mangled in transit
railway variable set "GOOGLE_SERVICE_ACCOUNT_JSON=$(base64 -i key.json)" --service budget-app
railway variable set 'SHEETS_SPREADSHEET_ID=<the id>' --service budget-app
```

Raw JSON works too; escaped `\n` in the private key is handled either way. With
both set, Settings gains a "Mirror now" button and the nightly job starts.

`npm run preview-sheet` prints what would be written without contacting Google,
which is the quickest way to check the output before wiring credentials up.

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
