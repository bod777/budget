-- Pay does not always land where the rule says: an employer pays early before
-- Christmas, or a bank moves a run forward by a few days. That is a fact about
-- one month, not a change of schedule, so it is recorded per month rather than
-- by adding a rule that would apply to every month after it.
--
-- `paid_on` is the date pay actually arrived, taken literally -- no shifting
-- back to the previous working day, because the day is observed rather than
-- derived.

create table if not exists pay_overrides (
  month      date primary key,
  paid_on    date not null,
  note       text,
  created_at timestamptz not null default now(),
  constraint paid_on_near_month check (
    paid_on >= month - interval '15 days' and paid_on < month + interval '2 months'
  )
);

comment on table pay_overrides is
  'One-off actual paydays, overriding pay_schedule for a single month.';
