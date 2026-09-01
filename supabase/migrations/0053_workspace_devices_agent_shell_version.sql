-- Which published agent build a PC is ACTUALLY running, as opposed to which one the dashboard last
-- published. Those are different questions and nothing recorded the first one.
--
-- workspace_devices.agent_version is a different thing entirely: it is the agent's own internal
-- constant ("3.2"), bumped by hand when the script's shape changes, and it stayed identical across
-- v64 -> v71. So there was no way to answer "did the canary actually land?", "has this PC taken the
-- fix yet?", or "which PCs are still on the old build?" from the dashboard at all.
--
-- On 1 Sep 2026 that cost three separate Run Commands queued against test PCs purely to read
-- C:\ProgramData\WorkspaceDirectoryAgent\installed-shell-version.txt off the box - the file the
-- agent already maintains for its own self-update comparison. This stores what that file says on
-- every check-in, so the answer is a column instead of a remote command.
--
-- Text, not an integer: it mirrors the published version value verbatim, and a build that has never
-- self-updated (a fresh install running whatever shipped in its installer) legitimately has nothing
-- to report, which stays NULL rather than being coerced to 0 and read as "version zero".
alter table public.workspace_devices
  add column if not exists agent_shell_version text;

comment on column public.workspace_devices.agent_shell_version is
  'The published agent shell version this PC is actually running, read from its own installed-shell-version.txt on each check-in. Compare against app_settings.workspaceDirectoryAgentShell (or ...ShellCanary for a test PC) to see whether it has taken the latest publish. NULL means it has never self-updated. Distinct from agent_version, which is the script''s own hand-maintained internal constant.';
