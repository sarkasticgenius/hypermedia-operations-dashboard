-- Index every FK column (Postgres does not auto-index these; flagged by the performance advisor)
create index if not exists idx_asset_assignments_asset_id on public.asset_assignments(asset_id);
create index if not exists idx_asset_inventory_contractor_id on public.asset_inventory(contractor_id);
create index if not exists idx_asset_inventory_networks_network_id on public.asset_inventory_networks(network_id);
create index if not exists idx_asset_locations_asset_id on public.asset_locations(asset_id);
create index if not exists idx_audit_log_user_id on public.audit_log(user_id);
create index if not exists idx_dashboards_section_id on public.dashboards(section_id);
create index if not exists idx_location_sub_assets_location_id on public.location_sub_assets(location_id);
create index if not exists idx_metro_pic_renewals_metro_pic_id on public.metro_pic_renewals(metro_pic_id);
create index if not exists idx_orders_asset_id on public.orders(asset_id);
create index if not exists idx_sim_cards_deployed_location_id on public.sim_cards(deployed_location_id);
create index if not exists idx_sim_cards_deployed_asset_inv_id on public.sim_cards(deployed_asset_inv_id);
create index if not exists idx_static_bookings_machine_id on public.static_bookings(machine_id);
create index if not exists idx_static_bookings_campaign_id on public.static_bookings(campaign_id);
create index if not exists idx_static_bookings_installation_id on public.static_bookings(installation_id);
create index if not exists idx_static_installations_static_campaign_id on public.static_installations(static_campaign_id);
create index if not exists idx_static_machines_contractor_id on public.static_machines(contractor_id);
create index if not exists idx_tickets_asset_id on public.tickets(asset_id);
create index if not exists idx_tickets_asset_inv_id on public.tickets(asset_inv_id);
create index if not exists idx_user_permissions_user_id on public.user_permissions(user_id);

-- Also useful for common lookups/filters not driven by FKs
create index if not exists idx_asset_inventory_source_asset_id on public.asset_inventory(source_asset_id);
create index if not exists idx_asset_inventory_player_box_id on public.asset_inventory(player_box_id);
create index if not exists idx_locations_name on public.locations(name);
create index if not exists idx_tickets_status on public.tickets(status);

-- auth_rls_initplan: wrap auth.uid() in a scalar subselect so it's evaluated once per
-- statement instead of once per row.
drop policy "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (id = (select auth.uid()) or public.is_admin());

drop policy "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (id = (select auth.uid()) or public.is_admin())
  with check (id = (select auth.uid()) or public.is_admin());

drop policy "user_permissions_select" on public.user_permissions;
create policy "user_permissions_select" on public.user_permissions
  for select using (user_id = (select auth.uid()) or public.is_admin());
