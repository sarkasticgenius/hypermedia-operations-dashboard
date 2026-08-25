-- One row per device per Dubai calendar day, capturing that day's DU cycle-to-date snapshot.
-- workspace_devices.du_data_used_gb etc. are overwritten on every scrape, so nothing kept
-- yesterday's number - this table exists purely so day-over-day and month-over-month usage can be
-- computed later (the digest, a future chart) instead of only ever seeing "so far this cycle".
create table if not exists workspace_device_du_usage_daily (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references workspace_devices(id) on delete cascade,
  hostname text not null,
  usage_date date not null,
  used_gb numeric,
  total_gb numeric,
  left_gb numeric,
  scraped_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (device_id, usage_date)
);

create index if not exists workspace_device_du_usage_daily_device_date_idx
  on workspace_device_du_usage_daily (device_id, usage_date desc);

alter table workspace_device_du_usage_daily enable row level security;

-- Read-only from the dashboard, same permission gate as the devices table itself; only the
-- checkin edge function (service role, bypasses RLS) ever writes to it.
create policy "workspace_device_du_usage_daily_select"
  on workspace_device_du_usage_daily for select
  using (public.has_permission('workspace_directory', 'view'));
