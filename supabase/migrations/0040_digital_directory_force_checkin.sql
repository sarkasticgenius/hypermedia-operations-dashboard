-- Set true by the dashboard's "Force Inventory Pull" button, polled for by Jstar (not the 6-hourly
-- scheduled task itself - that would defeat the point of a fast, on-demand check) every ~2 minutes
-- via workspace-directory-force-status, then cleared by workspace-directory-checkin once a real
-- check-in actually lands. See buildTrayScript in src/pages/settings.js for the polling loop.
alter table public.workspace_devices add column if not exists force_checkin_requested boolean not null default false;
