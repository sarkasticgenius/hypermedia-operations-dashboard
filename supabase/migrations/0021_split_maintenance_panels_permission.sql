-- Splits the Broadsign/Grassfish/IoT "Maintenance Panels" out of the 'locations' permission area,
-- which previously gated both the Locations page AND all three network console pages together -
-- an admin could not grant one without the other. New area: 'maintenancePanels'.
--
-- Rollout choice: every existing user's 'maintenancePanels' permission is backfilled to exactly
-- mirror whatever their 'locations' permission is today, so nobody loses access to a page they
-- already use on the day this ships - admins can diverge the two afterward.
--
-- RLS: the Locations page and the network panels both read the same locations/location_sub_assets
-- tables (the panels never write to them directly - Broadsign/Grassfish sync writes go through the
-- service-role edge functions, bypassing RLS entirely), so the SELECT policies accept EITHER area.
-- INSERT/UPDATE/DELETE stay scoped to 'locations' only - that's genuinely Locations-page-only
-- functionality (adding/editing venues, editing manual sub-assets), never done from a panel.

alter table public.user_permissions drop constraint user_permissions_area_check;
alter table public.user_permissions add constraint user_permissions_area_check
  check (area in ('assets','assetsInventory','orders','locations','maintenancePanels','campaigns','staticCampaigns','permits','metroPic','tickets','simCards','pdooh','dashboards'));

insert into public.user_permissions (user_id, area, can_view, can_add, can_edit, can_delete, can_export)
select user_id, 'maintenancePanels', can_view, can_add, can_edit, can_delete, can_export
from public.user_permissions
where area = 'locations'
on conflict (user_id, area) do nothing;

drop policy "locations_select" on public.locations;
create policy "locations_select" on public.locations
  for select using (public.has_permission('locations','view') or public.has_permission('maintenancePanels','view'));

drop policy "location_sub_assets_select" on public.location_sub_assets;
create policy "location_sub_assets_select" on public.location_sub_assets
  for select using (public.has_permission('locations','view') or public.has_permission('maintenancePanels','view'));
