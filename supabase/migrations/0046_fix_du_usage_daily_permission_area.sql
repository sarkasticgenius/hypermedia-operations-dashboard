-- The area string used elsewhere for this table is 'workspaceDirectory' (camelCase), not
-- 'workspace_directory' - the first migration used the wrong string, which would have silently
-- denied every viewer since has_permission would never match.
drop policy if exists "workspace_device_du_usage_daily_select" on workspace_device_du_usage_daily;

create policy "workspace_device_du_usage_daily_select"
  on workspace_device_du_usage_daily for select
  using (has_permission('workspaceDirectory', 'view'));
