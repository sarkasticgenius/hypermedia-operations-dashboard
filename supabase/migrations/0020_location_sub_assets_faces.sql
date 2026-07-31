-- Lets an offline screen row carry how many physical faces it represents, so "Offline Faces" can
-- be a real sum instead of a fragile name-match back to asset_inventory.faces at read time.
-- Populated going forward by broadsign-sync/grassfish-sync (asset.faces || 1) when they insert
-- offline rows; existing historical rows are left null and treated as 1 face by readers.
alter table public.location_sub_assets add column faces integer;
