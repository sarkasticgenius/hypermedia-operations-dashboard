-- Real-time Slack alert for a NEW screen report (field-reported screen issue), same family as the
-- Digital Directory "new issue" alert being added alongside this. Unlike location_sub_assets or
-- workspace_devices, screen_reports rows are stable (never wiped/reinserted), so a plain
-- alerted_at-per-row flag is enough - no separate tracking table needed, same pattern as
-- offline_alerted_at on workspace_devices.
alter table screen_reports add column if not exists alerted_at timestamptz;

-- Seed: mark every EXISTING report as already alerted, so reports already sitting on the Screen
-- Reports page before this shipped don't all fire as "new" the moment the first scan runs.
update screen_reports set alerted_at = created_at where alerted_at is null;
