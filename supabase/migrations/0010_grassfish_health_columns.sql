-- Grassfish never had a live health-count column (only Broadsign did) - the Grassfish Console
-- fell back to an Asset Inventory-by-venue view instead. Adding the same shape Broadsign already
-- has now that grassfish-sync writes real online/offline data from the locationlist/init API.
alter table public.locations add column if not exists grassfish_healthy_count integer;
alter table public.locations add column if not exists grassfish_as_of text;
