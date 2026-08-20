-- Fields populated by the agent's once-a-day incognito scrape of mydata.du.ae (see Get-DuDataUsage
-- in buildWorkspaceDirectoryAgentScript, src/pages/settings.js) - the SIM's own carrier-reported
-- figures, as an alternative/supplement to the network-adapter-counter estimate already tracked in
-- data_used_mb_period/data_used_mb_last_24h.
alter table public.workspace_devices
  add column if not exists du_phone_number text,
  add column if not exists du_data_used_gb numeric,
  add column if not exists du_data_left_gb numeric,
  add column if not exists du_data_total_gb numeric,
  add column if not exists du_scraped_at timestamptz;
