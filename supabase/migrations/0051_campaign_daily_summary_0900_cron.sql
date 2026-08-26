-- Moves the morning digest from 8:00 to 9:00 AM Dubai (04:00 -> 05:00 UTC).
--
-- The DU scrape now runs in each host's own slot between 3 and 8 AM (see Get-DuJitterMinutes in
-- src/pages/settings.js). 8:00 was the moment the LAST of those slots closed, so a device scraping
-- at 07:59 could still be mid-flight - its figures reach the server on the next check-in, up to
-- ~20 minutes later, not the instant the scrape finishes. Firing the digest at 08:00 would race
-- that tail. 9:00 clears the whole window plus a full poll cycle, so every device has not just
-- scraped but reported before the digest reads anything.
--
-- pg_cron schedules in UTC and the UAE does not observe daylight saving (+4 year round), so a
-- fixed 05:00 stays correct without a re-schedule - same reasoning as 0043/0047.
--
-- Unscheduled by its old name rather than re-scheduled in place: cron.schedule upserts by jobname,
-- so leaving 'campaign-daily-summary-0800' behind under a 09:00 expression would leave the job
-- named after a time it no longer runs at.
select cron.unschedule('campaign-daily-summary-0800') where exists (
  select 1 from cron.job where jobname = 'campaign-daily-summary-0800'
);

select cron.schedule(
  'campaign-daily-summary-0900',
  '0 5 * * *',
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
