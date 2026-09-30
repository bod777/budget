-- A few app-wide preferences that are not reference data and not per-period.
--
-- Key/value rather than columns because there are only a handful and they are
-- read together; a typed table would be mostly nulls.
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- How much to keep in the day-to-day accounts rather than sweep into savings.
-- Seeded at zero: what someone wants to hold back is personal, so the default
-- is "no floor" and the figure is set in the app.
insert into settings (key, value) values ('liquid_floor', '0')
on conflict (key) do nothing;
