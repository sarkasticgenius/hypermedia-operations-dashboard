-- Separate "used in the last check-in cycle" figure from the running data_used_mb_period total.
-- Check-ins are once a day, so this doubles as "data used in roughly the last 24h" for the SIM
-- Data Usage tiles, without the dashboard needing to recompute it from history.
alter table public.workspace_devices add column if not exists data_used_mb_last_24h numeric not null default 0;
