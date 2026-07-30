create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Shared secret cron uses to authenticate its call into the grassfish-sync Edge Function, since
-- pg_cron has no user session to present. Generated server-side so the literal value never
-- appears in this migration file / the committed repo. app_settings is already admin-only via
-- RLS (app_settings_admin_all), so this stays as protected as every other integration credential.
insert into public.app_settings (key, value, updated_at)
values ('_cronSecret', jsonb_build_object('secret', encode(gen_random_bytes(24), 'hex')), now())
on conflict (key) do nothing;

-- The anon key below is the project's public/publishable key (same one already embedded in the
-- client bundle's .env) - safe to commit. It only gets the request past the Edge Function
-- gateway's JWT check; the actual authorization decision inside grassfish-sync is the
-- x-cron-secret comparison against the admin-only app_settings row above.
select cron.schedule(
  'grassfish-sync-20min',
  '*/20 * * * *',
  $$
  select net.http_post(
    url := 'https://ehvspjuxugvhdjxdevkh.supabase.co/functions/v1/grassfish-sync',
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
