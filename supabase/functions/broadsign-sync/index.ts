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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authHeader = req.headers.get('Authorization') || '';

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) throw new Error('Not authenticated');

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient.from('profiles').select('role, active').eq('id', caller.id).single();
    if (!profile?.active) throw new Error('Inactive account');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'broadsignApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey || !cfg.domainId) {
      throw new Error('Broadsign integration is not fully configured (Base URL, API Key, Domain ID, Enabled).');
    }

    // Step 1: pull the Broadsign IDs from inventory, up front, before ever calling the API.
    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, player_box_id')
      .eq('player_type', 'Broadsign')
      .not('player_box_id', 'is', null);
    const inventoryIndex = new Map((inventory || [])
      .filter((r) => String(r.player_box_id).trim())
      .map((r) => [String(r.player_box_id).trim(), r]));
    if (!inventoryIndex.size) {
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
    // ours; everything else belongs to other screens on this Broadsign domain and is ignored. Also
    // track the reverse gap: inventory IDs the API never mentioned at all.
    const matchedRows: { asset: { id: string; name: string; venue: string | null }; row: any }[] = [];
    const seenIds = new Set<string>();
    for (const row of pollRows) {
      const key = String(row.client_resource_id).trim();
      const asset = inventoryIndex.get(key);
      if (asset) { matchedRows.push({ asset, row }); seenIds.add(key); }
    }
    const missingFromApi = [...inventoryIndex.keys()].filter((id) => !seenIds.has(id));
    const pulledLine = `Pulled ${inventoryIndex.size} Broadsign ID(s) from Asset Inventory; the API returned data for ${matchedRows.length} of them${missingFromApi.length ? `, ${missingFromApi.length} had no data back (check Domain ID, or the box may be retired/never polled)` : ''}.`;

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

      const rowsByLocation = new Map<string, { assetName: string; clientResourceId: string; offline: boolean }[]>();
      let unmatchedLocation = 0;
      for (const { asset, row } of matchedRows) {
        const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
        if (!locId) { unmatchedLocation++; continue; }
        const offline = offlineSet.has(String(row.monitor_status));
        if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
        rowsByLocation.get(locId).push({ assetName: asset.name, clientResourceId: String(row.client_resource_id), offline });
      }

      for (const [locId, rows] of rowsByLocation.entries()) {
        const offlineRows = rows.filter((r) => r.offline);
        await adminClient.from('location_sub_assets').delete().eq('location_id', locId).eq('source', 'broadsign');
        if (offlineRows.length) {
          await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
            location_id: locId, name: r.assetName, status: 'Offline', source: 'broadsign',
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
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastRawStatusCounts: rawCounts, lastMissingFromApi: missingFromApi },
      updated_at: nowIso,
    }).eq('key', 'broadsignApi');

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
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
