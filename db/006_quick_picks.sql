-- Choices about which one-tap buttons appear.
--
-- The buttons are derived from what actually repeats, which is right by
-- default but wrong at the edges: something logged often can still be a
-- nuisance to see, and something you want on hand may not qualify yet. This
-- table records only the deviations, so the automatic behaviour keeps working
-- for everything not mentioned here.
--
-- The key identifies a template the same way the suggestion query groups them:
-- description, counterparty and category. Account is deliberately not part of
-- it, matching the grouping used for suggestions.

create table if not exists quick_picks (
  template_key text primary key,
  kind         text not null check (kind in ('expense', 'income')),
  -- Always show, even if it would not qualify on its own.
  pinned       boolean not null default false,
  -- Never show, however often it repeats.
  hidden       boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  constraint quick_picks_not_both check (not (pinned and hidden))
);
