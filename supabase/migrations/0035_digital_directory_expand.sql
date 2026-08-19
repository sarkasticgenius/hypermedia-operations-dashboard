-- Expands workspace_devices for the Digital Directory (display name only - table/permission-area/
-- edge function names stay workspace_devices/workspaceDirectory/workspace-directory-* to avoid a
-- risky rename of already-live infrastructure that PCs are actively checking into):
--   - teamviewer_id + other_remote_ids (jsonb [{tool,id}]) - AnyDesk was the only remote-access ID
--     collected before; some PCs also/instead run TeamViewer or another tool.
--   - volumes (jsonb [{drive,label,sizeGb,freeGb}]), components (jsonb {cpu,ramGb,gpu,disks:[...]}),
--     antivirus (jsonb [{name,enabled}]), problems (jsonb [string]) - the new inventory categories
--     requested (disk volumes/sizes, hardware components, AV status, detected problems).
-- All of these come from the remotely-updatable collector script (see
-- app_settings.workspaceDirectoryCollector, fetched by every agent each run from the new
-- workspace-directory-collector edge function) rather than a fixed shape baked into the installed
-- agent - so adding another data point later is a Settings edit, not a re-deploy to every PC.
--
-- Also adds: a SIM Cards link (many of these PCs drive a screen over a metered cellular SIM, not
-- broadband - data_used_mb_period vs. the linked sim_cards.data_allocation_gb feeds the Digital
-- Directory's data-usage tiles) and a single-slot remote command (admin queues one PowerShell
-- command from the dashboard; the agent runs it and reports output back on its next check-in -
-- covers both "install this on the PC" and "show me this log file" without a full package-
-- management system). Both run on the same 6-hour check-in cadence as everything else - kept
-- deliberately infrequent since several of these PCs are on metered SIM data.
alter table public.workspace_devices
  add column teamviewer_id text,
  add column other_remote_ids jsonb not null default '[]'::jsonb,
  add column volumes jsonb not null default '[]'::jsonb,
  add column components jsonb not null default '{}'::jsonb,
  add column antivirus jsonb not null default '[]'::jsonb,
  add column problems jsonb not null default '[]'::jsonb,
  add column sim_card_id uuid references public.sim_cards(id) on delete set null,
  add column network_bytes_total bigint,
  add column data_used_mb_period numeric not null default 0,
  add column pending_command text,
  add column last_command_output text,
  add column last_command_at timestamptz;
