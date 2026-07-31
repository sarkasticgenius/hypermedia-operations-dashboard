-- Soft delete / Recycle Bin: every user-facing "delete" becomes a soft delete
-- (deleted_at/deleted_by set) instead of a real row removal, restorable from
-- a new admin-only Recycle Bin page. A real DELETE (used only by "Delete
-- Permanently" in that page) is tightened to admin-only at the RLS layer for
-- every one of these tables, closing the gap where a non-admin with area
-- `delete` permission could otherwise hard-delete via a raw API call.

-- ============================= COLUMNS + INDEXES =============================
do $$
declare
  t text;
begin
  foreach t in array array[
    'assets','asset_inventory','campaigns','categories','contractors','dashboards',
    'locations','metro_pics','networks','orders','permits','sim_cards',
    'static_campaigns','static_machines','static_bookings','tickets'
  ]
  loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    execute format('alter table public.%I add column if not exists deleted_by uuid references public.profiles(id) on delete set null', t);
    execute format('create index if not exists %I on public.%I (deleted_at) where deleted_at is not null', t || '_deleted_at_idx', t);
  end loop;
end $$;

-- ============================= TIGHTEN HARD-DELETE TO ADMIN-ONLY =============================
-- Tables with a standalone `<t>_delete` policy: just tighten it.
drop policy "assets_delete" on public.assets;
create policy "assets_delete" on public.assets for delete using (public.is_admin());

drop policy "asset_inventory_delete" on public.asset_inventory;
create policy "asset_inventory_delete" on public.asset_inventory for delete using (public.is_admin());

drop policy "campaigns_delete" on public.campaigns;
create policy "campaigns_delete" on public.campaigns for delete using (public.is_admin());

drop policy "locations_delete" on public.locations;
create policy "locations_delete" on public.locations for delete using (public.is_admin());

drop policy "metro_pics_delete" on public.metro_pics;
create policy "metro_pics_delete" on public.metro_pics for delete using (public.is_admin());

drop policy "orders_delete" on public.orders;
create policy "orders_delete" on public.orders for delete using (public.is_admin());

drop policy "permits_delete" on public.permits;
create policy "permits_delete" on public.permits for delete using (public.is_admin());

drop policy "sim_cards_delete" on public.sim_cards;
create policy "sim_cards_delete" on public.sim_cards for delete using (public.is_admin());

drop policy "static_campaigns_delete" on public.static_campaigns;
create policy "static_campaigns_delete" on public.static_campaigns for delete using (public.is_admin());

drop policy "tickets_delete" on public.tickets;
create policy "tickets_delete" on public.tickets for delete using (public.is_admin());

-- Tables that previously used one combined `for all` write policy: split into
-- insert/update (unchanged permission check) + a new admin-only delete policy.
drop policy "dashboards_write" on public.dashboards;
create policy "dashboards_insert" on public.dashboards for insert with check (public.has_permission('dashboards','edit') or public.is_admin());
create policy "dashboards_update" on public.dashboards for update using (public.has_permission('dashboards','edit') or public.is_admin()) with check (public.has_permission('dashboards','edit') or public.is_admin());
create policy "dashboards_delete" on public.dashboards for delete using (public.is_admin());

drop policy "static_machines_write" on public.static_machines;
create policy "static_machines_insert" on public.static_machines for insert with check (public.has_permission('staticCampaigns','edit'));
create policy "static_machines_update" on public.static_machines for update using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));
create policy "static_machines_delete" on public.static_machines for delete using (public.is_admin());

drop policy "static_bookings_write" on public.static_bookings;
create policy "static_bookings_insert" on public.static_bookings for insert with check (public.has_permission('staticCampaigns','edit'));
create policy "static_bookings_update" on public.static_bookings for update using (public.has_permission('staticCampaigns','edit')) with check (public.has_permission('staticCampaigns','edit'));
create policy "static_bookings_delete" on public.static_bookings for delete using (public.is_admin());

-- categories/contractors/networks already use a single is_admin()-gated
-- `for all` policy covering insert/update/delete - no change needed, hard
-- delete on those is already admin-only.
