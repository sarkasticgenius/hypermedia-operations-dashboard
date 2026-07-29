insert into public.app_settings (key, value) values
  ('assetInventoryApi', '{"baseUrl":"","authHeaderName":"","authHeaderValue":"","fieldMapping":{"source_asset_id":"id","name":"name","venue":"venue","location":"location","category":"category"},"enabled":false,"lastSync":"","lastSyncSummary":"","lastError":""}'::jsonb)
on conflict (key) do nothing;
