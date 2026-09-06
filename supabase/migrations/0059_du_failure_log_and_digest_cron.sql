-- One row per device per Dubai calendar day it showed up in the Digital Directory's "Data Check
-- Failed" tab (see dataCheckFailedToday in workspaceDirectory.js, mirrored server-side in
-- workspace-directory-du-failure-digest). workspace_devices itself only ever holds the LATEST
-- attempt's outcome - there is nowhere to ask "has this PC failed on 3 of the last 7 days?" without
-- a day-by-day trail, which is exactly what let a chronic offender look identical to a one-off
-- flake every single day.
create table if not exists workspace_du_failure_log (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references workspace_devices(id) on delete cascade,
  -- Denormalized rather than joined on every read: a device can be renamed or removed between the
  -- day it failed and the day someone reads this history, and the digest should still be able to
  -- name it without the join silently going blank.
  hostname text not null,
  fail_date date not null,
  outcome text,
  created_at timestamptz not null default now(),
  unique (device_id, fail_date)
);
create index if not exists workspace_du_failure_log_fail_date_idx on workspace_du_failure_log(fail_date);

alter table workspace_du_failure_log enable row level security;
create policy "workspace_du_failure_log_select"
  on workspace_du_failure_log for select
  using (has_permission('workspaceDirectory', 'view'));

-- Runs once a day, after the DU scrape window (see campaign-daily-summary's own 09:00 Dubai
-- reasoning) - the digest logs today's failures AND reads back the trailing week, so it has to run
-- after every device's own 3-8 AM jittered slot has had a chance to report, same as the 09:00
-- summary. Offset 10 minutes past it (05:10 vs 05:00 UTC) purely so the two daily digests don't
-- land in Slack in the same breath.
select cron.schedule(
  'workspace-directory-du-failure-digest-daily',
  '10 5 * * *',
  $$
  select net.http_post(
    url := 'https://ehvspjuxugvhdjxdevkh.supabase.co/functions/v1/workspace-directory-du-failure-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodnNwanV4dWd2aGRqeGRldmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyMDY4ODUsImV4cCI6MjEwMDc4Mjg4NX0.XhRYXD_YadLjh05qGccMQmiITabJvxFhNUQB2ezd38w',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodnNwanV4dWd2aGRqeGRldmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyMDY4ODUsImV4cCI6MjEwMDc4Mjg4NX0.XhRYXD_YadLjh05qGccMQmiITabJvxFhNUQB2ezd38w',
      'x-cron-secret', (select value->>'secret' from public.app_settings where key = '_cronSecret')
    ),
    body := '{}'::jsonb
  );
  $$
);
