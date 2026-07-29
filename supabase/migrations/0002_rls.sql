-- ============================= HELPER FUNCTIONS =============================
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  )
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.profiles where id = auth.uid() and active
  )
$$;

create or replace function public.has_permission(p_area text, p_action text)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    case
      when public.is_admin() then true
      else exists (
        select 1
        from public.user_permissions up
        join public.profiles p on p.id = up.user_id
        where up.user_id = auth.uid()
          and p.active
          and up.area = p_area
          and (
            (p_action = 'view' and up.can_view) or
            (p_action = 'add' and up.can_add) or
            (p_action = 'edit' and up.can_edit) or
            (p_action = 'delete' and up.can_delete) or
            (p_action = 'export' and up.can_export)
          )
      )
    end
$$;

-- ============================= PROFILES / PERMISSIONS =============================
alter table public.profiles enable row level security;

create policy "profiles_select" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

create policy "profiles_update" on public.profiles
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.active := old.active;
    new.username := old.username;
  end if;
  return new;
end;
$$;

create trigger trg_protect_profile_fields
before update on public.profiles
for each row execute function public.protect_profile_fields();

alter table public.user_permissions enable row level security;

create policy "user_permissions_select" on public.user_permissions
  for select using (user_id = auth.uid() or public.is_admin());

create policy "user_permissions_admin_write" on public.user_permissions
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================= REFERENCE DATA =============================
alter table public.categories enable row level security;
create policy "categories_select" on public.categories for select using (public.is_active_user());
create policy "categories_admin_write" on public.categories for all using (public.is_admin()) with check (public.is_admin());

alter table public.contractors enable row level security;
create policy "contractors_select" on public.contractors for select using (public.is_active_user());
create policy "contractors_admin_write" on public.contractors for all using (public.is_admin()) with check (public.is_admin());

alter table public.networks enable row level security;
create policy "networks_select" on public.networks for select using (public.is_active_user());
create policy "networks_admin_write" on public.networks for all using (public.is_admin()) with check (public.is_admin());

-- ============================= AREA-GATED TABLES =============================
-- assets (Hardware Inventory)
alter table public.assets enable row level security;
create policy "assets_select" on public.assets for select using (public.has_permission('assets','view'));
create policy "assets_insert" on public.assets for insert with check (public.has_permission('assets','add'));
create policy "assets_update" on public.assets for update using (public.has_permission('assets','edit')) with check (public.has_permission('assets','edit'));
create policy "assets_delete" on public.assets for delete using (public.has_permission('assets','delete'));

alter table public.asset_locations enable row level security;
create policy "asset_locations_select" on public.asset_locations for select using (public.has_permission('assets','view'));
create policy "asset_locations_insert" on public.asset_locations for insert with check (public.has_permission('assets','add') or public.has_permission('assets','edit'));
create policy "asset_locations_update" on public.asset_locations for update using (public.has_permission('assets','edit')) with check (public.has_permission('assets','edit'));
create policy "asset_locations_delete" on public.asset_locations for delete using (public.has_permission('assets','delete') or public.has_permission('assets','edit'));

alter table public.asset_assignments enable row level security;
create policy "asset_assignments_select" on public.asset_assignments for select using (public.has_permission('assets','view'));
create policy "asset_assignments_insert" on public.asset_assignments for insert with check (public.has_permission('assets','edit') or public.has_permission('assets','add'));

-- asset_inventory
alter table public.asset_inventory enable row level security;
create policy "asset_inventory_select" on public.asset_inventory for select using (public.has_permission('assetsInventory','view'));
create policy "asset_inventory_insert" on public.asset_inventory for insert with check (public.has_permission('assetsInventory','add'));
create policy "asset_inventory_update" on public.asset_inventory for update using (public.has_permission('assetsInventory','edit')) with check (public.has_permission('assetsInventory','edit'));
create policy "asset_inventory_delete" on public.asset_inventory for delete using (public.has_permission('assetsInventory','delete'));

alter table public.asset_inventory_networks enable row level security;
create policy "asset_inventory_networks_select" on public.asset_inventory_networks for select using (public.has_permission('assetsInventory','view'));
create policy "asset_inventory_networks_write" on public.asset_inventory_networks for all using (public.has_permission('assetsInventory','edit')) with check (public.has_permission('assetsInventory','edit'));

-- orders (procurement)
alter table public.orders enable row level security;
create policy "orders_select" on public.orders for select using (public.has_permission('orders','view'));
create policy "orders_insert" on public.orders for insert with check (public.has_permission('orders','add'));
create policy "orders_update" on public.orders for update using (public.has_permission('orders','edit')) with check (public.has_permission('orders','edit'));
create policy "orders_delete" on public.orders for delete using (public.has_permission('orders','delete'));

-- locations
alter table public.locations enable row level security;
create policy "locations_select" on public.locations for select using (public.has_permission('locations','view'));
create policy "locations_insert" on public.locations for insert with check (public.has_permission('locations','add'));
create policy "locations_update" on public.locations for update using (public.has_permission('locations','edit')) with check (public.has_permission('locations','edit'));
create policy "locations_delete" on public.locations for delete using (public.has_permission('locations','delete'));

alter table public.location_sub_assets enable row level security;
create policy "location_sub_assets_select" on public.location_sub_assets for select using (public.has_permission('locations','view'));
create policy "location_sub_assets_write" on public.location_sub_assets for all using (public.has_permission('locations','edit')) with check (public.has_permission('locations','edit'));

-- permits
alter table public.permits enable row level security;
create policy "permits_select" on public.permits for select using (public.has_permission('permits','view'));
create policy "permits_insert" on public.permits for insert with check (public.has_permission('permits','add'));
create policy "permits_update" on public.permits for update using (public.has_permission('permits','edit')) with check (public.has_permission('permits','edit'));
create policy "permits_delete" on public.permits for delete using (public.has_permission('permits','delete'));

-- metro pic
alter table public.metro_pics enable row level security;
create policy "metro_pics_select" on public.metro_pics for select using (public.has_permission('metroPic','view'));
create policy "metro_pics_insert" on public.metro_pics for insert with check (public.has_permission('metroPic','add'));
create policy "metro_pics_update" on public.metro_pics for update using (public.has_permission('metroPic','edit')) with check (public.has_permission('metroPic','edit'));
create policy "metro_pics_delete" on public.metro_pics for delete using (public.has_permission('metroPic','delete'));

alter table public.metro_pic_renewals enable row level security;
create policy "metro_pic_renewals_select" on public.metro_pic_renewals for select using (public.has_permission('metroPic','view'));
create policy "metro_pic_renewals_write" on public.metro_pic_renewals for all using (public.has_permission('metroPic','edit')) with check (public.has_permission('metroPic','edit'));

-- tickets
alter table public.tickets enable row level security;
create policy "tickets_select" on public.tickets for select using (public.has_permission('tickets','view'));
create policy "tickets_insert" on public.tickets for insert with check (public.has_permission('tickets','add'));
create policy "tickets_update" on public.tickets for update using (public.has_permission('tickets','edit')) with check (public.has_permission('tickets','edit'));
create policy "tickets_delete" on public.tickets for delete using (public.has_permission('tickets','delete'));

-- sim cards
alter table public.sim_cards enable row level security;
create policy "sim_cards_select" on public.sim_cards for select using (public.has_permission('simCards','view'));
create policy "sim_cards_insert" on public.sim_cards for insert with check (public.has_permission('simCards','add'));
create policy "sim_cards_update" on public.sim_cards for update using (public.has_permission('simCards','edit')) with check (public.has_permission('simCards','edit'));
create policy "sim_cards_delete" on public.sim_cards for delete using (public.has_permission('simCards','delete'));

-- campaigns
alter table public.campaigns enable row level security;
create policy "campaigns_select" on public.campaigns for select using (public.has_permission('campaigns','view'));
create policy "campaigns_insert" on public.campaigns for insert with check (public.has_permission('campaigns','add'));
create policy "campaigns_update" on public.campaigns for update using (public.has_permission('campaigns','edit')) with check (public.has_permission('campaigns','edit'));
create policy "campaigns_delete" on public.campaigns for delete using (public.has_permission('campaigns','delete'));

-- static campaigns family
alter table public.static_campaigns enable row level security;
create policy "static_campaigns_select" on public.static_campaigns for select using (public.has_permission('staticCampaigns','view'));
create policy "static_campaigns_insert" on public.static_campaigns for insert with check (public.has_permission('staticCampaigns','add'));
create policy "static_campaigns_update" on public.static_campaigns for update using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));
create policy "static_campaigns_delete" on public.static_campaigns for delete using (public.has_permission('staticCampaigns','delete'));

alter table public.static_installations enable row level security;
create policy "static_installations_select" on public.static_installations for select using (public.has_permission('staticCampaigns','view'));
create policy "static_installations_write" on public.static_installations for all using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));

alter table public.static_machines enable row level security;
create policy "static_machines_select" on public.static_machines for select using (public.has_permission('staticCampaigns','view'));
create policy "static_machines_write" on public.static_machines for all using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));

alter table public.static_bookings enable row level security;
create policy "static_bookings_select" on public.static_bookings for select using (public.has_permission('staticCampaigns','view'));
create policy "static_bookings_write" on public.static_bookings for all using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));

-- dashboards
alter table public.dashboard_sections enable row level security;
create policy "dashboard_sections_select" on public.dashboard_sections for select using (public.has_permission('dashboards','view'));
create policy "dashboard_sections_write" on public.dashboard_sections for all using (public.has_permission('dashboards','edit') or public.is_admin()) with check (public.has_permission('dashboards','edit') or public.is_admin());

alter table public.dashboards enable row level security;
create policy "dashboards_select" on public.dashboards for select using (public.has_permission('dashboards','view'));
create policy "dashboards_write" on public.dashboards for all using (public.has_permission('dashboards','edit') or public.is_admin()) with check (public.has_permission('dashboards','edit') or public.is_admin());

-- ============================= ADMIN-ONLY TABLES =============================
alter table public.audit_log enable row level security;
create policy "audit_log_select_admin" on public.audit_log for select using (public.is_admin());
create policy "audit_log_insert_active" on public.audit_log for insert with check (public.is_active_user());

alter table public.app_settings enable row level security;
create policy "app_settings_admin_all" on public.app_settings for all using (public.is_admin()) with check (public.is_admin());

-- ============================= STORAGE =============================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy "attachments_select_authenticated" on storage.objects
  for select using (bucket_id = 'attachments' and auth.role() = 'authenticated');
create policy "attachments_insert_authenticated" on storage.objects
  for insert with check (bucket_id = 'attachments' and auth.role() = 'authenticated');
create policy "attachments_update_authenticated" on storage.objects
  for update using (bucket_id = 'attachments' and auth.role() = 'authenticated');
create policy "attachments_delete_authenticated" on storage.objects
  for delete using (bucket_id = 'attachments' and auth.role() = 'authenticated');
