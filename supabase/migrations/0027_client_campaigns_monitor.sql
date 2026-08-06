-- Client Campaigns Monitor: real restricted client logins that see only campaigns matching the
-- Traffic Sheet venues an admin has assigned to them, can approve one (Slack-notifying Ops), and
-- Ops can mark it live once it's actually turned on in Broadsign/Grassfish. Traffic Sheet
-- campaigns themselves are never stored (live external API, see traffic-sheet-proxy) - this only
-- persists the client-mapping and the approval workflow state layered on top of them.

-- Which venues (exact Traffic Sheet venue names, matched case-insensitively client-side) belong
-- to which client.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  venue_names text[] not null default '{}',
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- Per-campaign approval state, keyed by AdLive's `contract` id - already used app-wide as the
-- de-facto unique campaign identifier (see trafficSheet.js/gantt.js/opsOverview.js), though it's a
-- third-party value we don't mint or guarantee unique ourselves.
create table public.campaign_approvals (
  id uuid primary key default gen_random_uuid(),
  contract text not null unique,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'live')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  marked_live_by uuid references public.profiles(id),
  marked_live_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaign_approvals_client_id_idx on public.campaign_approvals(client_id);

-- profiles gets a nullable client_id (null = internal staff/admin, set = restricted client login)
-- and a new 'client' role alongside the existing 'admin'/'team'.
alter table public.profiles add column client_id uuid references public.clients(id);
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'team', 'client'));

-- New permission area for INTERNAL staff (team role) managing Clients / previewing monitors /
-- marking campaigns live. Admins bypass this as always (has_permission() already short-circuits
-- true for is_admin()); actual client-role users bypass the area-permission system entirely -
-- they're gated by client_id match via is_own_client() below instead, since they hold no
-- user_permissions rows at all.
alter table public.user_permissions drop constraint user_permissions_area_check;
alter table public.user_permissions add constraint user_permissions_area_check
  check (area in (
    'assets', 'assetsInventory', 'orders', 'locations', 'maintenancePanels', 'campaigns', 'staticCampaigns',
    'permits', 'metroPic', 'tickets', 'simCards', 'pdooh', 'dashboards', 'trafficSheet', 'clientCampaigns'
  ));

create or replace function public.is_own_client(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and client_id = p_client_id and active
  )
$$;

alter table public.clients enable row level security;
create policy "clients_select" on public.clients for select
  using (public.is_admin() or public.has_permission('clientCampaigns', 'view') or public.is_own_client(id));
create policy "clients_write" on public.clients for all
  using (public.is_admin() or public.has_permission('clientCampaigns', 'edit'))
  with check (public.is_admin() or public.has_permission('clientCampaigns', 'edit'));

alter table public.campaign_approvals enable row level security;
create policy "campaign_approvals_select" on public.campaign_approvals for select
  using (public.is_admin() or public.has_permission('clientCampaigns', 'view') or public.is_own_client(client_id));
-- Staff/admin: full write (create pending rows for any client, approve, mark live).
create policy "campaign_approvals_staff_write" on public.campaign_approvals for all
  using (public.is_admin() or public.has_permission('clientCampaigns', 'edit'))
  with check (public.is_admin() or public.has_permission('clientCampaigns', 'edit'));
-- Client: may create only their own client's PENDING rows, and may only ever move pending ->
-- approved - never approved -> live, never someone else's client_id. Enforced purely via
-- USING/WITH CHECK, no trigger needed: USING constrains which existing rows they can even attempt
-- to touch (must currently be pending), WITH CHECK constrains what the resulting row must become.
create policy "campaign_approvals_client_insert" on public.campaign_approvals for insert
  with check (public.is_own_client(client_id) and status = 'pending');
create policy "campaign_approvals_client_approve" on public.campaign_approvals for update
  using (public.is_own_client(client_id) and status = 'pending')
  with check (public.is_own_client(client_id) and status = 'approved' and approved_by = auth.uid());
