-- Lets an offline row carry a real timestamp (when Broadsign/Grassfish last heard from the
-- player) and a human status label ('Missing in Action' | 'Offline'), instead of baking a
-- point-in-time-stale "X ago" string into `notes` at sync time. The UI formats the relative time
-- live at render time from poll_last_utc, so it's always accurate regardless of how long ago the
-- sync actually ran.
alter table public.location_sub_assets add column poll_last_utc timestamptz;
alter table public.location_sub_assets add column status_label text;
