-- Budget tool schema.
--
-- Expenses and income share one table: both forms collect the same six fields
-- (date, description, counterparty, amount, category, channel), so keeping them
-- together makes autocomplete, duplicate detection and the dashboard one query
-- each instead of two.

create extension if not exists pg_trgm;

create table if not exists categories (
  id          serial primary key,
  kind        text not null check (kind in ('expense', 'income')),
  name        text not null,
  -- Expense categories split Fixed/Variable to mirror the budget workbook.
  bucket      text check (bucket in ('fixed', 'variable')),
  sort_order  int  not null default 0,
  archived    boolean not null default false,
  unique (kind, name)
);

create table if not exists channels (
  id          serial primary key,
  name        text not null unique,
  -- Income never lands on a credit card, so channels are filtered per kind.
  kinds       text[] not null default array['expense', 'income'],
  sort_order  int not null default 0,
  archived    boolean not null default false
);

-- Canonical payees/payers. The import folds spelling variants
-- (Anthropic/Antrophic, Tesco/Tescos) into one row so history aggregates correctly.
create table if not exists counterparties (
  id          serial primary key,
  name        text not null,
  normalized  text not null unique,
  archived    boolean not null default false
);

create table if not exists counterparty_aliases (
  alias       text primary key,
  counterparty_id int not null references counterparties(id) on delete cascade
);

create table if not exists recurring_rules (
  id              serial primary key,
  kind            text not null check (kind in ('expense', 'income')),
  description     text not null,
  counterparty_id int references counterparties(id),
  -- null amount means "varies" -- the rule prompts instead of prefilling.
  amount          numeric(12, 2),
  category_id     int not null references categories(id),
  channel_id      int references channels(id),
  cadence         text not null check (cadence in ('weekly', 'fortnightly', 'monthly', 'yearly')),
  -- Defines weekday for weekly/fortnightly, day-of-month for monthly,
  -- and month+day for yearly.
  anchor_date     date not null,
  active          boolean not null default true,
  last_generated_on date,
  created_at      timestamptz not null default now()
);

create table if not exists entries (
  id              bigserial primary key,
  kind            text not null check (kind in ('expense', 'income')),
  occurred_on     date not null,
  description     text not null,
  counterparty_id int references counterparties(id),
  amount          numeric(12, 2) not null check (amount >= 0),
  category_id     int not null references categories(id),
  channel_id      int references channels(id),
  note            text,
  source          text not null default 'manual'
                  check (source in ('manual', 'import', 'recurring')),
  recurring_rule_id int references recurring_rules(id) on delete set null,
  -- Preserved from the Google Form responses so imported rows keep their
  -- original entry time; that's what reveals the batch-entry pattern.
  logged_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists entries_occurred_idx on entries (occurred_on desc, id desc);
create index if not exists entries_kind_occurred_idx on entries (kind, occurred_on desc);
create index if not exists entries_category_idx on entries (category_id);
create index if not exists entries_counterparty_idx on entries (counterparty_id);
create index if not exists entries_description_trgm_idx on entries using gin (description gin_trgm_ops);

-- Auto-logged recurring items land here first. Nothing is written to `entries`
-- without a confirmation, so an unpaid month never silently becomes an expense.
create table if not exists pending_entries (
  id              bigserial primary key,
  recurring_rule_id int not null references recurring_rules(id) on delete cascade,
  due_on          date not null,
  kind            text not null check (kind in ('expense', 'income')),
  description     text not null,
  counterparty_id int references counterparties(id),
  amount          numeric(12, 2),
  category_id     int not null references categories(id),
  channel_id      int references channels(id),
  status          text not null default 'pending'
                  check (status in ('pending', 'confirmed', 'skipped')),
  entry_id        bigint references entries(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (recurring_rule_id, due_on)
);

create index if not exists pending_status_idx on pending_entries (status, due_on);

create table if not exists budget_months (
  month           date primary key,
  -- Carried forward from the previous month's closing surplus.
  opening_surplus numeric(12, 2) not null default 0,
  note            text,
  created_at      timestamptz not null default now()
);

create table if not exists budget_lines (
  month       date not null references budget_months(month) on delete cascade,
  category_id int not null references categories(id),
  amount      numeric(12, 2) not null default 0,
  note        text,
  primary key (month, category_id)
);

create table if not exists savings_lines (
  id          serial primary key,
  month       date not null references budget_months(month) on delete cascade,
  name        text not null,
  budget      numeric(12, 2) not null default 0,
  actual      numeric(12, 2) not null default 0,
  sort_order  int not null default 0,
  unique (month, name)
);

create table if not exists sessions (
  token       text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);

create index if not exists sessions_expiry_idx on sessions (expires_at);
