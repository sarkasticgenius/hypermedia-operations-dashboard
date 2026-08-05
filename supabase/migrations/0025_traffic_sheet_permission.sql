-- New 'trafficSheet' permission area for the Traffic Sheet workspace (campaign schedule report
-- proxied live from the AdLive Center API, see supabase/functions/traffic-sheet-proxy). No
-- backfill from an existing area - this is brand-new functionality, so every existing non-admin
-- team member starts at PERM_NONE for it (admins already get every area implicitly) and gets
-- granted access explicitly via Admin > Edit User, same as any newly added permission area.

alter table public.user_permissions drop constraint user_permissions_area_check;
alter table public.user_permissions add constraint user_permissions_area_check
  check (area in ('assets','assetsInventory','orders','locations','maintenancePanels','campaigns','staticCampaigns','permits','metroPic','tickets','simCards','pdooh','dashboards','trafficSheet'));
