-- Tracks which Broadsign/Grassfish screens are already known to be offline, so a real-time Slack
-- alert can fire only on a NEWLY offline screen. location_sub_assets itself can't carry this state:
-- broadsign-sync/grassfish-sync wipe and fully reinsert their source's rows on every 20-minute sync
-- (confirmed in broadsign-sync's own code), so no row id survives from one sync to the next. Keyed
-- by (source, location_id, screen name) instead - that identity IS stable sync to sync, since it
-- comes from Asset Inventory, not from the resync itself.
create table if not exists workspace_offline_screens (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  location_id uuid not null references locations(id) on delete cascade,
  screen_key text not null,
  first_seen_at timestamptz not null default now(),
  unique (source, location_id, screen_key)
);
create index if not exists workspace_offline_screens_source_idx on workspace_offline_screens(source);

alter table workspace_offline_screens enable row level security;
create policy "workspace_offline_screens_select"
  on workspace_offline_screens for select
  using (has_permission('workspaceDirectory', 'view'));

-- Seed with EVERY screen currently offline right now, so the first real-time scan sees nothing new
-- and doesn't blast today's already-known offline screens as if they all just dropped
-- simultaneously. Only screens offline AFTER this seed will ever alert.
insert into workspace_offline_screens (source, location_id, screen_key)
select source, location_id, name
from location_sub_assets
where status = 'Offline' and location_id is not null
on conflict (source, location_id, screen_key) do nothing;

-- Baseline for the Digital Directory "new issue" alert: what each device's problems list looked
-- like the last time an alert was (or would have been) sent. Seeded with each device's CURRENT
-- problems so the day-one issues already sitting on the dashboard (e.g. "No antivirus product
-- detected") don't fire as if they just appeared - only a problem that shows up AFTER this seed is
-- "new" relative to this baseline.
alter table workspace_devices add column if not exists problems_last_alerted jsonb not null default '[]'::jsonb;
update workspace_devices set problems_last_alerted = coalesce(problems, '[]'::jsonb) where problems_last_alerted = '[]'::jsonb;
