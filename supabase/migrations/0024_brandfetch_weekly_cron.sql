select cron.schedule(
  'brandfetch-lookup-weekly',
  '0 3 * * 1',
  $$
  select net.http_post(
    url := 'https://ehvspjuxugvhdjxdevkh.supabase.co/functions/v1/brandfetch-lookup',
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
