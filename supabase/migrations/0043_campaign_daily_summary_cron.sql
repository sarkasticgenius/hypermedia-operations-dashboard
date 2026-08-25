-- Daily campaign digest to Slack at 19:00 Dubai time.
--
-- pg_cron schedules in UTC, so 19:00 Asia/Dubai (UTC+4) is 15:00 UTC. Written as a fixed 15:00
-- rather than anything timezone-aware because the UAE does not observe daylight saving - the offset
-- is +4 year round, so this stays correct without a re-schedule. Any region that DID shift would
-- need this revisited twice a year.
select cron.unschedule('campaign-daily-summary-1900') where exists (
  select 1 from cron.job where jobname = 'campaign-daily-summary-1900'
);

select cron.schedule(
  'campaign-daily-summary-1900',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://ehvspjuxugvhdjxdevkh.supabase.co/functions/v1/campaign-daily-summary',
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
