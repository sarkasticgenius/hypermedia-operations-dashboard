-- One-shot delivery of a secret value to a single agent (currently: setting a PC's AnyDesk
-- password from the dashboard).
--
-- WHY THIS TABLE EXISTS AT ALL, rather than reusing pending_command
-- The obvious implementation is to queue "echo <password> | anydesk.exe --set-password" as an
-- ordinary Run Command. That would put a live remote-access credential in THREE places in clear
-- text, all of them long-lived and readable by anyone with dashboard or database access:
-- workspace_devices.pending_command, the audit_log detail for queuing it, and afterwards
-- last_command_output. A password that leaks into audit history forever is worse than no feature.
--
-- So the value travels here instead, and this table is deliberately write-only from the browser's
-- point of view: there is a policy for INSERT and none for SELECT, so an admin can send a password
-- but nobody - including the person who set it - can ever read one back through PostgREST. Only the
-- checkin edge function (service role, which bypasses RLS) can read it, and it deletes the row the
-- moment it hands the value to the agent.
create table if not exists public.agent_secret_deliveries (
  id uuid primary key default gen_random_uuid(),
  hostname text not null,
  -- What the agent should do with the value. A column rather than an assumption, so a second kind
  -- of secret (a Wi-Fi key, a service account) does not need a second table and a second protocol.
  kind text not null check (kind in ('anydeskPassword')),
  secret text not null,
  created_at timestamptz not null default now(),
  -- Delivered rows are deleted outright rather than flagged, so a consumed secret leaves no copy
  -- behind. This column exists only so a delivery that is picked up but never confirmed can be
  -- reaped by age instead of lingering.
  claimed_at timestamptz
);

create index if not exists agent_secret_deliveries_hostname_idx on public.agent_secret_deliveries (hostname);

alter table public.agent_secret_deliveries enable row level security;

-- INSERT only. Deliberately NO select policy: the browser can send a secret and can never read one.
create policy "agent_secret_deliveries_insert" on public.agent_secret_deliveries
  for insert with check (public.has_permission('workspaceDirectory','edit'));

-- Lets an admin cancel a delivery that has not been picked up yet - useful if it was sent to the
-- wrong PC. Still grants no ability to READ the value.
create policy "agent_secret_deliveries_delete" on public.agent_secret_deliveries
  for delete using (public.has_permission('workspaceDirectory','edit'));
