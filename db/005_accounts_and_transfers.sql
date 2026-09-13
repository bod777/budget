-- Channels become accounts that carry a balance, and transfers become a third
-- kind of entry.
--
-- A transfer to savings is neither income nor expense. Recording it as an
-- expense would wreck the spending figures; not recording it at all makes
-- money disappear. The same applies to taking out cash: the withdrawal moves
-- money, and the spending of that cash is the expense.
--
-- Balances are never stored, only derived, so they cannot drift out of step
-- with the entries that produce them:
--
--   balance = opening + income - expenses + transfers in - transfers out
--
-- A credit card is a liability, so its balance goes negative as it is used and
-- returns toward zero when paid off. Only the display differs; the arithmetic
-- is uniform.

create table if not exists accounts (
  id              serial primary key,
  name            text not null unique,
  kind            text not null default 'other'
                  check (kind in ('current', 'credit', 'cash', 'savings', 'other')),
  -- Null means nobody has told us what this account actually holds, which is
  -- shown as unknown rather than quietly treated as zero.
  opening_balance numeric(12, 2),
  opening_on      date,
  usable_for      text[] not null default array['expense', 'income'],
  sort_order      int not null default 0,
  archived        boolean not null default false
);

-- Ids are preserved so existing entries keep pointing at the right
-- account without touching a single row of history.
insert into accounts (id, name, kind, usable_for, sort_order, archived)
select
  c.id,
  c.name,
  case
    when c.name ilike '%credit card%' then 'credit'
    when c.name ilike '%current%'     then 'current'
    when c.name = 'Cash'              then 'cash'
    when c.name = 'Revolut'           then 'current'
    else 'other'
  end,
  c.kinds,
  c.sort_order,
  c.archived
from channels c
on conflict (id) do nothing;

select setval(
  pg_get_serial_sequence('accounts', 'id'),
  greatest((select coalesce(max(id), 1) from accounts), 1)
);

-- Entries ------------------------------------------------------------------

alter table entries rename column channel_id to account_id;
alter table entries add column if not exists to_account_id int references accounts(id);

alter table entries drop constraint if exists entries_channel_id_fkey;
alter table entries add constraint entries_account_id_fkey
  foreign key (account_id) references accounts(id);

alter table entries drop constraint if exists entries_kind_check;
alter table entries add constraint entries_kind_check
  check (kind in ('expense', 'income', 'transfer'));

-- A transfer has no category; everything else must have one.
alter table entries alter column category_id drop not null;
alter table entries add constraint entries_category_required
  check ((kind = 'transfer' and category_id is null) or (kind <> 'transfer' and category_id is not null));

-- A transfer needs both ends, and they must differ.
alter table entries add constraint entries_transfer_endpoints
  check (
    kind <> 'transfer'
    or (account_id is not null and to_account_id is not null and account_id <> to_account_id)
  );

create index if not exists entries_to_account_idx on entries (to_account_id);

-- Recurring rules and their pending items ----------------------------------

alter table recurring_rules rename column channel_id to account_id;
alter table recurring_rules add column if not exists to_account_id int references accounts(id);
alter table recurring_rules drop constraint if exists recurring_rules_channel_id_fkey;
alter table recurring_rules add constraint recurring_rules_account_id_fkey
  foreign key (account_id) references accounts(id);
alter table recurring_rules drop constraint if exists recurring_rules_kind_check;
alter table recurring_rules add constraint recurring_rules_kind_check
  check (kind in ('expense', 'income', 'transfer'));
alter table recurring_rules alter column category_id drop not null;

alter table pending_entries rename column channel_id to account_id;
alter table pending_entries add column if not exists to_account_id int references accounts(id);
alter table pending_entries drop constraint if exists pending_entries_channel_id_fkey;
alter table pending_entries add constraint pending_entries_account_id_fkey
  foreign key (account_id) references accounts(id);
alter table pending_entries drop constraint if exists pending_entries_kind_check;
alter table pending_entries add constraint pending_entries_kind_check
  check (kind in ('expense', 'income', 'transfer'));
alter table pending_entries alter column category_id drop not null;

-- Savings targets -----------------------------------------------------------

-- Actuals are no longer typed in: they come from real transfers into savings
-- accounts, so the savings section cannot disagree with the ledger.
create table if not exists savings_targets (
  month      date not null references budget_months(month) on delete cascade,
  account_id int not null references accounts(id),
  amount     numeric(12, 2) not null default 0,
  primary key (month, account_id)
);

drop table if exists savings_lines;

drop table if exists channels;
