-- Per-device agent-update control, so a rollout can be aimed at specific machines instead of being
-- all-or-nothing. The existing canary/stable split answers "which build", but not "which PCs are
-- allowed to move at all" - and on a fleet where most PCs drive signage in malls nobody can walk up
-- to, being able to hold an individual machine still is the difference between a safe rollout and a
-- gamble.
alter table public.workspace_devices
  -- While true, workspace-directory-agent-shell serves this device its pinned version and an empty
  -- script, so its own version check matches and it never downloads anything. Re-enabling does NOT
  -- replay the versions it missed: the agent only ever compares "what I have" against "what is
  -- published now" and fetches that single current build, so a device that sat out five publishes
  -- jumps straight to the newest one.
  add column if not exists updates_disabled boolean not null default false,
  -- Captured when updates are disabled: the version that device's channel was serving at that
  -- moment, which is what it is running. Held separately from the channel's own version so the pin
  -- does not drift when someone publishes again - that drift is exactly what a "hold this machine
  -- still" switch has to prevent.
  add column if not exists updates_pinned_version integer;
