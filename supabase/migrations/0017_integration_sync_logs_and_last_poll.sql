create table public.integration_sync_logs (
  id uuid primary key default gen_random_uuid(),
  integration text not null check (integration in ('broadsign','grassfish')),
  synced_at timestamptz not null default now(),
  pulled_count integer,
  matched_count integer,
  failed_count integer,
  locations_updated integer,
  missing_ids jsonb,
  summary text,
  error text
);

create index integration_sync_logs_integration_synced_at_idx
  on public.integration_sync_logs (integration, synced_at desc);

alter table public.integration_sync_logs enable row level security;

-- Readable by anyone who can see the network console pages (same area as `locations`), written
-- only by the sync Edge Functions (service role, bypasses RLS).
create policy "integration_sync_logs_select" on public.integration_sync_logs
  for select using (public.has_permission('locations', 'view'));

alter table public.asset_inventory add column if not exists last_poll_utc timestamptz;
alter table public.asset_inventory add column if not exists last_monitor_status text;
