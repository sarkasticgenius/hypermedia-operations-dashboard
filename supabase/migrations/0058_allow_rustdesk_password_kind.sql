-- The RustDesk password feature (see Set-RustDeskPassword in settings.js, saveWorkspaceRustDeskPassword
-- in workspaceDirectory.js) inserts kind='rustdeskPassword' into agent_secret_deliveries, but this
-- constraint was never widened past the original AnyDesk-only value - every delivery attempt was
-- silently rejected by the database, meaning the "Set RustDesk Password" button never actually
-- worked for anyone. Caught by directly testing the delivery path against HM-OFFICE-TEST.
alter table public.agent_secret_deliveries drop constraint agent_secret_deliveries_kind_check;
alter table public.agent_secret_deliveries add constraint agent_secret_deliveries_kind_check
  check (kind in ('anydeskPassword', 'rustdeskPassword'));
