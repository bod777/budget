-- Budget periods run payday to payday rather than across the calendar month,
-- so the schedule of paydays is data, not a constant: it has already changed
-- once with a change of job, and will change again.
--
-- `day_rule` is either 'last' (last day of the month) or a day number. Either
-- way the actual payday moves back to the previous working day when it lands
-- on a weekend or an Irish bank holiday.

create table if not exists pay_schedule (
  id             serial primary key,
  effective_from date not null unique,
  day_rule       text not null,
  note           text,
  created_at     timestamptz not null default now(),
  constraint day_rule_valid check (day_rule = 'last' or day_rule ~ '^[0-9]{1,2}$')
);

insert into pay_schedule (effective_from, day_rule, note) values
  -- Employer A: the 28th. Verified against June 2026, where the 28th was a Sunday and
  -- the period began on Friday the 26th.
  ('2000-01-01', '28', 'Employer A — 28th of the month'),
  -- Employer B: the last day of the month, from the first full month in the new job.
  ('2026-07-01', 'last', 'Employer B — last day of the month')
on conflict (effective_from) do nothing;

-- Periods are stored per budget month so a historical boundary stays put even
-- if the schedule is edited later.
alter table budget_months add column if not exists period_start date;
alter table budget_months add column if not exists period_end date;
