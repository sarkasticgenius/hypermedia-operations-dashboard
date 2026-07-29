insert into public.categories (name, is_rental) values
  ('SCREENS', false),
  ('PCs', false),
  ('Edge PC''s', false),
  ('IoT Cameras', false),
  ('Routers', false),
  ('Tools', false),
  ('Consumables', false),
  ('Scaffolding', true),
  ('Spider Lift', true)
on conflict (name) do nothing;

insert into public.dashboard_sections (name, locked, lock_key, nav_group, sort_order) values
  ('Maintenance Panel', true, 'maintenance', 'dashboards', 0),
  ('Digital Campaigns Panel', true, 'campaign', 'campaigns', 1),
  ('pDOOH Campaign Panel', true, 'pdooh', 'pdooh', 2)
on conflict (lock_key) do nothing;

insert into public.app_settings (key, value) values
  ('ticketNotifyEmail', '""'::jsonb),
  ('broadsignApi', '{"baseUrl":"","apiKey":"","username":"","password":"","authMethod":"apiKey","enabled":false,"lastSync":"","domainId":"","offlineStatusValues":"","lastError":"","lastRawStatusCounts":null,"lastSyncSummary":"","lastMissingFromApi":null}'::jsonb),
  ('grassfishApi', '{"baseUrl":"","apiKey":"","username":"","password":"","authMethod":"apiKey","enabled":false,"lastSync":"","statusFieldName":"","offlineStatusValues":"","lastError":"","lastRawStatusCounts":null,"lastRawSample":null,"lastSyncSummary":"","lastMissingFromApi":null}'::jsonb),
  ('campaignFeed', '{"sheetUrl":"","autoRefreshMinutes":0,"lastSync":"","lastSyncCount":0}'::jsonb),
  ('glpiApi', '{"baseUrl":"","appToken":"","userToken":"","enabled":false,"lastSync":""}'::jsonb),
  ('glpiFeed', '{"csvUrl":"","autoRefreshMinutes":0,"lastSync":"","lastSyncCount":0,"lastSyncUpdated":0}'::jsonb),
  ('broadsignFeed', '{"csvUrl":"","autoRefreshMinutes":120,"lastSync":"","lastSyncCount":0,"notifyDesktop":false}'::jsonb),
  ('staticReminders', '{"notifyDesktop":false,"lastCheckedDate":""}'::jsonb),
  ('whatsappFeed', '{"feedUrl":"","autoRefreshMinutes":0,"lastSync":"","lastSyncCount":0}'::jsonb),
  ('closingRelay', '{"webhookUrl":"","pullUrl":"","autoRefreshMinutes":0,"lastSync":"","lastSyncCount":0}'::jsonb),
  ('venueTileOrder', '[]'::jsonb),
  ('workspaceLabels', '{}'::jsonb)
on conflict (key) do nothing;
