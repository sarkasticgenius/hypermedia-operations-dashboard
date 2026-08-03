// Syncs live player health from Broadsign's real monitor_poll/v2 API into
// location_sub_assets/locations, ported from the original app's syncBroadsignApiDirect() (its
// direct-API sync, not the CSV/NSR-based fallback). Runs server-side (service role) so the
// Broadsign API key never reaches the browser.
//
// Actual response shape (confirmed against Broadsign's own docs, not guessed):
//   GET {baseUrl}/rest/monitor_poll/v2?domain_id=<domainId>
//   Header: authorization: Bearer <apiKey>
//   Response: {"monitor_poll":[{client_resource_id, domain_id, id, monitor_status, poll_last_utc,
//              poll_next_expected_utc, private_ip, product_version, public_ip}], "not_modified_since"}
// poll_last_utc/monitor_status are stored on every MATCHED asset_inventory row (last_poll_utc,
// last_monitor_status), not just offline ones, so "when was this screen last heard from" is
// always visible regardless of online/offline calibration state.
//
// monitor_status meaning: Broadsign's docs show an example value but never publish what any
// integer code means. Guessing that mapping wrong would silently invert every screen's status, so
// this never assumes one. Instead: every sync records the raw monitor_status histogram seen among
// matched screens (app_settings.broadsignApi.lastRawStatusCounts) and only classifies online/
// offline once app_settings.broadsignApi.offlineStatusValues (comma-separated raw codes) has been
// set - compare the histogram against screens you know the real state of, then set that field from
// Settings > Integrations. Until it's set, this sync reports the histogram and does not touch any
// location/location_sub_assets rows, so it can never write out a wrong guess.
//
// Matching: joins Broadsign's client_resource_id to asset_inventory.player_box_id, scoped to
// player_type = 'Broadsign' specifically (so a Grassfish/Custom row reusing the same box id text
// never gets matched by accident) - same "asset-link precedence" rule as the original's
// broadsignInventoryIndex(). Matched, currently-offline players become location_sub_assets rows
// (source='broadsign'); the online count rolls up to locations.broadsign_healthy_count instead of
// being stored per-row, matching the original's loc.subAssets/broadsignHealthyCount split.
//
// player_box_id is NOT unique in Asset Inventory - 224 Box IDs are currently shared across 2+ rows
// (up to 28 rows sharing one Box ID, 554 "extra" rows total), most likely multi-screen video walls
// or duplicate manual entries. Broadsign's monitor_poll only reports ONE status per
// client_resource_id (= one per physical player/box), so every asset_inventory row sharing that
// box id gets the SAME status applied - the index below is Map<boxId, Asset[]>, not Map<boxId,
// Asset>, specifically so none of those sibling rows get silently dropped. An earlier version keyed
// the index by a single Asset per box id, which collapsed all but the last row per duplicate box id
// - this was the real cause of the Broadsign Console under-reporting online screens (1591 tagged
// rows in Asset Inventory, but only 1037 ever made it into the online/offline count).
//
// The asset_inventory pull is paginated (PAGE_SIZE-based .range() loop) - Supabase's project-wide
// "Max Rows" setting silently caps any single unpaginated select, which is exactly why this used
// to only ever pull ~716 of 1591+ tagged rows without ever surfacing an error. The loop also needs
// an explicit .order('id') - PostgREST's range/offset pagination has no defined row order without
// one, so two separate page requests (each its own query execution) can silently disagree on which
// rows count as "page 1" vs "page 2", under-collecting the union across pages.
//
// Every run writes a row to integration_sync_logs (pruned to the most recent 100 per integration)
// so mismatches/failures can be reviewed over time from the console page's "View Sync Log", not
// just the single most recent summary. Runs two ways:
//   1. Settings > Integrations > Broadsign API "Test / Sync Now" - authenticated admin JWT.
//   2. A pg_cron job every 15 minutes (see migration 0018) - sends a shared secret in
//      x-cron-secret instead of a user session (pg_cron can't hold one).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const PAGE_SIZE = 1000;

async function isAuthorized(req: Request, adminClient: any, supabaseUrl: string, anonKey: string): Promise<boolean> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    const { data: secretRow } = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
    return !!(secretRow?.value?.secret && cronSecret === secretRow.value.secret);
  }
  const authHeader = req.headers.get('Authorization') || '';
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return false;
  const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
  return !!profile?.active;
}

async function fetchAllInventory(adminClient: any, playerType: string) {
  const all: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, player_box_id, faces')
      .eq('player_type', playerType)
      .not('player_box_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all;
}

async function logSync(adminClient: any, row: Record<string, unknown>) {
  await adminClient.from('integration_sync_logs').insert(row);
  const { data: old } = await adminClient
    .from('integration_sync_logs').select('id').eq('integration', row.integration)
    .order('synced_at', { ascending: false }).range(100, 100000);
  if (old?.length) await adminClient.from('integration_sync_logs').delete().in('id', old.map((r: any) => r.id));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'broadsignApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey || !cfg.domainId) {
      throw new Error('Broadsign integration is not fully configured (Base URL, API Key, Domain ID, Enabled).');
    }

    // Step 1: pull EVERY Broadsign screen from inventory, paginated (not capped at Max Rows).
    // inventoryIndex is Map<boxId, Asset[]> - see the top-of-file note on why box ids aren't unique.
    const inventory = await fetchAllInventory(adminClient, 'Broadsign');
    const inventoryIndex = new Map<string, any[]>();
    for (const r of inventory) {
      const key = String(r.player_box_id).trim();
      if (!key) continue;
      if (!inventoryIndex.has(key)) inventoryIndex.set(key, []);
      inventoryIndex.get(key)!.push(r);
    }
    const totalScreens = [...inventoryIndex.values()].reduce((sum, arr) => sum + arr.length, 0);
    if (!totalScreens) {
      throw new Error('No Asset Inventory rows are tagged Player Type "Broadsign" with a Player Box ID set - there is nothing to match against.');
    }

    // Step 2: fetch the domain's full poll status in one call - Broadsign's API has no "give me
    // just these IDs" bulk filter, only "all" or one-at-a-time.
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/rest/monitor_poll/v2?domain_id=${encodeURIComponent(cfg.domainId)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json' } });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (auth rejected - check the API Key and Domain ID)' : ''}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const pollRows = Array.isArray(data.monitor_poll) ? data.monitor_poll : null;
    if (!pollRows) throw new Error('Response did not contain a "monitor_poll" array - unexpected shape, check the Base URL/Domain ID.');

    // Step 3: match - every poll row whose client_resource_id is in the inventory index is one of
    // ours; everything else belongs to other screens on this Broadsign domain and is ignored. A
    // matched box id fans out to every asset_inventory row sharing it (see note above). Also track
    // the reverse gap: inventory box ids the API never mentioned at all.
    const matchedRows: { asset: { id: string; name: string; venue: string | null }; row: any }[] = [];
    const seenIds = new Set<string>();
    for (const row of pollRows) {
      const key = String(row.client_resource_id).trim();
      const assets = inventoryIndex.get(key);
      if (assets) {
        for (const asset of assets) matchedRows.push({ asset, row });
        seenIds.add(key);
      }
    }
    const missingBoxIds = [...inventoryIndex.keys()].filter((id) => !seenIds.has(id));
    const missingFromApi = missingBoxIds.flatMap((id) => inventoryIndex.get(id)!.map((a) => a.id));
    const pulledLine = `Pulled ${totalScreens} Broadsign screen(s) from Asset Inventory (${inventoryIndex.size} distinct Box ID${inventoryIndex.size === 1 ? '' : 's'}); the API returned data for ${matchedRows.length} screen(s)${missingFromApi.length ? `, ${missingFromApi.length} had no data back (check Domain ID, or the box may be retired/never polled)` : ''}.`;

    // Store poll_last_utc/monitor_status on every matched asset row, online or offline - this is
    // "last heard from" data, independent of whether offline calibration has been set yet.
    if (matchedRows.length) {
      const updates = matchedRows.map(({ asset, row }) => ({
        id: asset.id, last_poll_utc: row.poll_last_utc || null, last_monitor_status: String(row.monitor_status),
      }));
      for (let i = 0; i < updates.length; i += 200) {
        const chunk = updates.slice(i, i + 200);
        await Promise.all(chunk.map((u) => adminClient.from('asset_inventory').update({
          last_poll_utc: u.last_poll_utc, last_monitor_status: u.last_monitor_status,
        }).eq('id', u.id)));
      }
    }

    // Raw status histogram scoped to OUR matched screens only, not domain-wide noise from other
    // players sharing this Broadsign domain that this app doesn't track.
    const rawCounts: Record<string, number> = {};
    for (const { row } of matchedRows) {
      const k = String(row.monitor_status);
      rawCounts[k] = (rawCounts[k] || 0) + 1;
    }

    const offlineSet = new Set(String(cfg.offlineStatusValues || '').split(',').map((s) => s.trim()).filter(Boolean));
    const nowIso = new Date().toISOString();
    let summary: string;
    let locationsUpdated = 0;

    if (!offlineSet.size) {
      summary = `${pulledLine} Raw monitor_status values seen among matched screens: ${Object.keys(rawCounts).map((k) => `${k} (${rawCounts[k]}x)`).join(', ') || 'none'}. Set "Offline Status Values" below (comparing against screens you know are down) to start applying online/offline status.`;
    } else {
      const { data: locations } = await adminClient.from('locations').select('id, name');
      const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));

      const rowsByLocation = new Map<string, { assetName: string; clientResourceId: string; offline: boolean; faces: number }[]>();
      let unmatchedLocation = 0;
      for (const { asset, row } of matchedRows) {
        const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
        if (!locId) { unmatchedLocation++; continue; }
        const offline = offlineSet.has(String(row.monitor_status));
        if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
        rowsByLocation.get(locId).push({ assetName: asset.name, clientResourceId: String(row.client_resource_id), offline, faces: asset.faces || 1 });
      }

      // Wipe every existing broadsign-sourced offline row and healthy-count FIRST, once, rather
      // than per-location inside the loop below. A per-location delete/update only ever touched
      // locations present in rowsByLocation THIS run - a location that previously had matched
      // screens but has none this run (venue text stopped matching, screens retired, etc.) never
      // got touched again, so its old offline rows and healthy_count sat there stale forever. This
      // was confirmed live: 14 offline rows still carrying pre-rewrite note text, from locations
      // that haven't matched anything in the current sync for a while.
      await adminClient.from('location_sub_assets').delete().eq('source', 'broadsign');
      await adminClient.from('locations').update({ broadsign_healthy_count: null, broadsign_as_of: null }).not('broadsign_healthy_count', 'is', null);

      for (const [locId, rows] of rowsByLocation.entries()) {
        const offlineRows = rows.filter((r) => r.offline);
        if (offlineRows.length) {
          await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
            location_id: locId, name: r.assetName, status: 'Offline', source: 'broadsign', faces: r.faces,
            notes: `Broadsign ID: ${r.clientResourceId} - raw monitor_status logged in Settings`,
          })));
        }
        await adminClient.from('locations').update({
          broadsign_healthy_count: rows.length - offlineRows.length, broadsign_as_of: nowIso,
        }).eq('id', locId);
        locationsUpdated++;
      }

      summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched screen(s) had no matching Location by venue name.` : ''}`;
    }

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastRawStatusCounts: rawCounts, lastMissingFromApi: missingFromApi, lastPulledCount: totalScreens, lastMatchedCount: matchedRows.length, lastLocationsUpdated: locationsUpdated },
      updated_at: nowIso,
    }).eq('key', 'broadsignApi');

    await logSync(adminClient, {
      integration: 'broadsign', synced_at: nowIso, pulled_count: totalScreens,
      matched_count: matchedRows.length, failed_count: missingFromApi.length,
      locations_updated: locationsUpdated, missing_ids: missingBoxIds, summary, error: null,
    });

    return new Response(JSON.stringify({ summary, matched: matchedRows.length, locationsUpdated }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'broadsignApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'broadsignApi');
      }
      await logSync(adminClient, { integration: 'broadsign', synced_at: new Date().toISOString(), error: message });
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
