// Syncs live device status from the aioo IoT Admin Console into location_sub_assets/locations,
// matched to Asset Inventory rows tagged Player Type "IoT" by Player Box ID - same shape as
// broadsign-sync/grassfish-sync. Runs server-side (service role) so the username/password/token
// never reach the browser.
//
// Both endpoints are now confirmed live against the real tenant (iotadmin.eu.aiootech.com), so
// this no longer needs the old dynamic findArray()/getPath() field-guessing this file used to
// have before the device-list endpoint and response shape were known:
//   1. POST {baseUrl}/aioo_iot_admin_console/web_api/api/v1/auth
//      Body: {"username": "...", "password": "..."}
//      Response: {expires_at, role, status, token}
//   2. GET {baseUrl}{devicePath}  (defaults to /aioo_iot_admin_console/web_api/api/v1/device)
//      Header: User-Token: <token>   (a bare custom header, NOT "Authorization: Bearer")
//      Response: {"result": [{device_id, display_name, location:{asset,asset_id,entrance,
//        entrance_id,store,store_id}, status:{age,app_version,available_cameras,camera_mode,
//        core_version,errors,logger_status,monitoring_status,network,platform,state,
//        task_version,tracking_status,ts,warnings}, store_id, store_name}, ...]}
// "Box ID Field"/"Status Field Name" in Settings still work as overrides (dot-path into the
// device object) for if the vendor ever changes field names, but default to the confirmed
// device_id/status.state so this works out of the box without any calibration step.
//
// Two independent outputs from the same pull:
//   - deviceBreakdown: a fleet-wide count by platform/state/camera type/version, stored on
//     app_settings.iotApi and rendered as the "Devices by ..." donut cards on the IoT Panel.
//     Always computed - platform/state/camera/version are plain labels, not undocumented codes,
//     so there's nothing to calibrate before showing them.
//   - Per-location online/offline rollup (location_sub_assets + locations.iot_healthy_count),
//     same as Broadsign/Grassfish: gated behind an admin-set "Offline Status Values" (which raw
//     status.state values - TRACKING/OFFLINE/READY/IDLE/UNKNOWN/etc - actually mean "down" is a
//     judgment call, not something to guess), matched to a Location by venue name first, falling
//     back to manual_asset_inventory_ids for venues that don't text-match a Location name.
//     Excludes soft-deleted locations from that lookup (see broadsign-sync for why that matters).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const PAGE_SIZE = 1000;
const DEFAULT_DEVICE_PATH = '/aioo_iot_admin_console/web_api/api/v1/device';
const DEFAULT_BOX_ID_FIELD = 'device_id';
const DEFAULT_STATUS_FIELD = 'status.state';

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

function getPath(obj: any, path: string) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
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

// Groups devices by a field into a label->count map - kept small/plain so it's cheap to store on
// app_settings.iotApi and read straight into the donut cards on the frontend.
function countBy(devices: any[], getLabel: (d: any) => string) {
  const counts: Record<string, number> = {};
  for (const d of devices) {
    const label = getLabel(d) || 'Unknown';
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'iotApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl || !cfg.username || !cfg.password) {
      throw new Error('IoT Admin Console integration is not fully configured (Base URL, Username, Password, Enabled).');
    }
    const base = cfg.baseUrl.replace(/\/+$/, '');

    // Step 1: log in.
    const authRes = await fetch(`${base}/aioo_iot_admin_console/web_api/api/v1/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    });
    if (!authRes.ok) {
      const bodyText = await authRes.text().catch(() => '');
      throw new Error(`Login failed: HTTP ${authRes.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const authData = await authRes.json();
    if (!authData.status || !authData.token) throw new Error('Login did not return a token - unexpected response shape.');

    // Step 2: pull the device list. Token goes in a bare "User-Token" header, not Authorization.
    const devicePath = cfg.devicePath || DEFAULT_DEVICE_PATH;
    const listRes = await fetch(`${base}${devicePath.startsWith('/') ? devicePath : `/${devicePath}`}`, {
      headers: { 'User-Token': authData.token, Accept: 'application/json' },
    });
    if (!listRes.ok) {
      const bodyText = await listRes.text().catch(() => '');
      throw new Error(`Device list request failed: HTTP ${listRes.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const listData = await listRes.json();
    const devices = Array.isArray(listData.result) ? listData.result : null;
    if (!devices) throw new Error('Response did not contain a "result" array - unexpected shape, check the Device List Path.');

    const boxIdField = cfg.boxIdField || DEFAULT_BOX_ID_FIELD;
    const statusField = cfg.statusFieldName || DEFAULT_STATUS_FIELD;

    // Fleet-wide breakdown - always computed, no calibration needed (these are plain labels, not
    // undocumented codes).
    const deviceBreakdown = {
      totalDevices: devices.length,
      byPlatform: countBy(devices, (d) => String(d.status?.platform || 'Unknown').toUpperCase()),
      byState: countBy(devices, (d) => {
        const s = getPath(d, statusField);
        return s ? String(s).charAt(0) + String(s).slice(1).toLowerCase() : 'Unknown';
      }),
      byCameraType: countBy(devices, (d) => d.status?.available_cameras || d.status?.camera_mode || 'Unknown'),
      byVersion: countBy(devices, (d) => `${d.status?.task_version || '?'} - ${d.status?.core_version || '?'}`),
    };

    const pulledLine = `Logged in and pulled ${devices.length} device(s) from the IoT Admin Console.`;
    const nowIso = new Date().toISOString();
    let summary: string;
    let locationsUpdated = 0;
    let matchedCount = 0;

    // Per-location online/offline rollup - gated behind admin-calibrated Offline Status Values,
    // same "never write out a wrong guess" rule as broadsign-sync. Until set, this reports the raw
    // state histogram (already computed above as deviceBreakdown.byState) instead of touching
    // Locations.
    const offlineSet = new Set(String(cfg.offlineStatusValues || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

    if (!offlineSet.size) {
      summary = `${pulledLine} Raw device states seen: ${Object.entries(deviceBreakdown.byState).map(([k, v]) => `${k} (${v}x)`).join(', ') || 'none'}. Set "Offline Status Values" below (comparing against devices you know are down) to start applying online/offline status to Locations.`;
    } else {
      const inventory = await fetchAllInventory(adminClient, 'IoT');
      const inventoryIndex = new Map<string, any[]>();
      for (const r of inventory) {
        const key = String(r.player_box_id).trim();
        if (!key) continue;
        if (!inventoryIndex.has(key)) inventoryIndex.set(key, []);
        inventoryIndex.get(key)!.push(r);
      }

      // Excludes soft-deleted locations - see broadsign-sync for why this matters (a deleted
      // wrapper location's stale manual links would otherwise compete with real locations for the
      // same asset id and win non-deterministically).
      const { data: locations } = await adminClient.from('locations').select('id, name, manual_asset_inventory_ids').is('deleted_at', null);
      const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));
      const locIdByManualAssetId = new Map<string, string>();
      for (const l of locations || []) {
        for (const assetId of l.manual_asset_inventory_ids || []) locIdByManualAssetId.set(assetId, l.id);
      }

      const matchedRows: { asset: any; device: any }[] = [];
      for (const device of devices) {
        const key = String(getPath(device, boxIdField) ?? '').trim();
        if (!key) continue;
        const assets = inventoryIndex.get(key);
        if (assets) for (const asset of assets) matchedRows.push({ asset, device });
      }
      matchedCount = matchedRows.length;

      const rowsByLocation = new Map<string, { assetName: string; deviceId: string; offline: boolean; faces: number; pollLastUtc: string | null }[]>();
      let unmatchedLocation = 0;
      for (const { asset, device } of matchedRows) {
        const locId = (asset.venue && locByName.get(String(asset.venue).toLowerCase())) || locIdByManualAssetId.get(asset.id) || null;
        if (!locId) { unmatchedLocation++; continue; }
        const offline = offlineSet.has(String(getPath(device, statusField) || '').toLowerCase());
        if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
        rowsByLocation.get(locId).push({
          assetName: asset.name, deviceId: String(getPath(device, boxIdField)), offline, faces: asset.faces || 1,
          pollLastUtc: device.status?.ts || null,
        });
      }

      await adminClient.from('location_sub_assets').delete().eq('source', 'iot');
      await adminClient.from('locations').update({ iot_healthy_count: null, iot_as_of: null }).not('iot_healthy_count', 'is', null);

      for (const [locId, rows] of rowsByLocation.entries()) {
        const offlineRows = rows.filter((r) => r.offline);
        if (offlineRows.length) {
          await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
            location_id: locId, name: r.assetName, status: 'Offline', source: 'iot', faces: r.faces,
            poll_last_utc: r.pollLastUtc, status_label: 'Offline',
            notes: `IoT Device ID: ${r.deviceId}`,
          })));
        }
        await adminClient.from('locations').update({
          iot_healthy_count: rows.length - offlineRows.length, iot_as_of: nowIso,
        }).eq('id', locId);
        locationsUpdated++;
      }

      summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched device(s) had no matching Location by venue name.` : ''}`;
    }

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', deviceBreakdown, lastPulledCount: devices.length, lastMatchedCount: matchedCount, lastLocationsUpdated: locationsUpdated },
      updated_at: nowIso,
    }).eq('key', 'iotApi');

    await logSync(adminClient, {
      integration: 'iot', synced_at: nowIso, pulled_count: devices.length,
      matched_count: matchedCount, failed_count: 0,
      locations_updated: locationsUpdated, missing_ids: [], summary, error: null,
    });

    return new Response(JSON.stringify({ summary, matched: matchedCount, locationsUpdated, deviceBreakdown }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'iotApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'iotApi');
      }
      await logSync(adminClient, { integration: 'iot', synced_at: new Date().toISOString(), error: message });
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
