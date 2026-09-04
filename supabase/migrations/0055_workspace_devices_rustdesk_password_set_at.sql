-- Mirrors anydesk_password_set_at: stamped by workspace-directory-force-status once the agent
-- confirms it applied a RustDesk password sent from the dashboard (see Set-RustDeskPassword in
-- the agent script). Never stores the password itself, same as the AnyDesk column.
alter table public.workspace_devices add column rustdesk_password_set_at timestamptz;
