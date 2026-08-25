-- Tracks whether a Slack alert has already gone out for the CURRENT stale-DU-scrape streak on this
-- device, same edge-triggered pattern as offline_alerted_at: set when the alert fires, cleared back
-- to null the moment a fresh scrape actually lands - so a scrape that's been broken for two weeks
-- doesn't re-alert every 20 minutes, but a device that recovers and later breaks again alerts again.
alter table workspace_devices add column if not exists du_stale_alerted_at timestamptz;
