-- Removes the GLPI CSV Feed integration and its unused column. Confirmed dead before dropping:
--   - glpi_id: lives on public.assets (Hardware Inventory), NOT public.asset_inventory (the
--     Digital Directory's screen inventory) - easy to confuse since both tables render through a
--     page called "assets". Never read or written anywhere in src/ since 0001_schema.sql added it;
--     the Hardware Assets bulk-import mapping in bulkImport.js has no source/glpiId field either.
--     Confirmed live: 0 of 20 rows have glpi_id set, source is null on all of them.
--   - glpiFeed (app_settings): the settings card saved csvUrl/autoRefreshMinutes/enabled, but no
--     edge function, cron job, or client sync ever read them back - unlike broadsign-sync/
--     grassfish-sync, which actually run. Live values confirmed it was never configured: empty
--     csvUrl, autoRefreshMinutes 0, lastSync never set.
--   - The 'glpi' source badge in src/pages/assets.js checks this same assets.source column, so it
--     shares the same producer-less fate - nothing in the app ever writes 'glpi' into it.
-- GLPI itself (the third-party product) is untouched - this only removes the never-wired-up import
-- stub, not any reference to the real system.
alter table public.assets drop column if exists glpi_id;

delete from public.app_settings where key = 'glpiFeed';
