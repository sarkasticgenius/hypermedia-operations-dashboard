-- Workspace Digital Directory: a self-hosted equivalent of the external NSOC/GLPI PC inventory
-- dashboard, fed by our own lightweight agent (scripts/workspace-directory-agent.ps1) instead of
-- pulling from that third-party system. Each PC's agent POSTs a check-in (hostname, IP, AnyDesk
-- ID, OS, logged-in user, installed software) to the workspace-directory-checkin edge function,
-- authenticated by a shared secret (app_settings.workspaceDirectoryAgent.secret) rather than a
-- Supabase user session, since the agent runs unattended on each PC. `location` is a free-text
-- tag an admin assigns from the dashboard (not touched by the agent) so the directory can be
-- browsed grouped by site/room, tree-style, without needing a real Active Directory OU structure.
create table public.workspace_devices (
  id uuid primary key default gen_random_uuid(),
  hostname text not null unique,
  location text,
  ip_address text,
  anydesk_id text,
  os_name text,
  os_version text,
  logged_in_user text,
  software jsonb not null default '[]'::jsonb,
  agent_version text,
  notes text,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create index workspace_devices_location_idx on public.workspace_devices (location);

alter table public.workspace_devices enable row level security;
create policy "workspace_devices_select" on public.workspace_devices for select using (public.has_permission('workspaceDirectory','view'));
-- No insert policy for authenticated/anon roles - every row is created by the checkin edge
-- function using the service role key (which bypasses RLS), never directly by a browser session.
-- Only update (location/notes) and delete (decommissioned PCs) are ever done from the dashboard.
create policy "workspace_devices_update" on public.workspace_devices for update using (public.has_permission('workspaceDirectory','edit')) with check (public.has_permission('workspaceDirectory','edit'));
create policy "workspace_devices_delete" on public.workspace_devices for delete using (public.has_permission('workspaceDirectory','delete'));
