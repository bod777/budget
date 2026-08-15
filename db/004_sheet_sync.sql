-- Records the last mirror to Google Sheets, so the app can say when the backup
-- last succeeded rather than leaving it to be assumed.
create table if not exists sheet_sync (
  id          int primary key default 1,
  last_run_at timestamptz,
  status      text not null default 'never' check (status in ('never', 'ok', 'failed')),
  detail      text,
  constraint sheet_sync_single_row check (id = 1)
);

insert into sheet_sync (id, status) values (1, 'never')
on conflict (id) do nothing;
