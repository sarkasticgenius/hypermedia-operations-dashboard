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
// status.state ("Idle"/"Ready"/"Tracking"/etc) is the device's last self-reported ANALYTICS mode,
// not connectivity - confirmed against real data that a device offline for 16+ hours still
// reports whatever state it was in when it went dark (state never actually contains "Offline" in
// practice: 0 of 559 real devices did, across every state ever observed). status.age also isn't
// staleness - confirmed against the vendor's own console (a device it showed "Up-Time: 16h 9m" /
// "Last seen: 12h 47m ago" for had status.age === 58141s, matching Up-Time almost exactly, not
// Last Seen) - it's process uptime, and a LARGER age can mean a healthier, longer-running device.
// The real connectivity signal is status.ts (last update timestamp) compared to now: real data
// shows a clean bimodal split with no devices in between - 487 devices last updated 76-140s ago
// (genuinely online) vs. a separate cluster starting at ~11 hours stale (genuinely down, some for
// months). "Stale After (minutes)" in Settings controls where that line is drawn - defaults to 30
// minutes, comfortably inside that real gap, so this works correctly with zero calibration.
//
// app_settings.iotApi.excludedDeviceIds is a persistent user-managed list (set from the IoT
// Panel's device table, not by this sync) of device_id values to leave out of every count -
// devices retired/removed on the admin's side that the vendor API still happily returns. This
// sync reads it every run and filters BEFORE computing deviceBreakdown/matching to Locations, so
// re-syncing never silently brings an excluded device back into the numbers. It never writes to
// this field itself (that would risk clobbering an in-flight UI edit) - only the frontend's
// toggle action does, via a direct app_settings update.
//
// Three outputs from the same pull:
//   - lastDevices: a trimmed copy of every device the API returned (excluded or not), so the IoT
//     Panel can show a full checkable list without needing a live device pull just to render it.
//     Each device is matched to Asset Inventory by boxIdField (unconditionally, not gated behind
//     anything) purely to attach a Venue name for the table/search. Devices without a friendly
//     name set on the vendor's side have their MAC address in display_name instead - that gets
//     split out into its own macAddress field rather than shown to look like a real name.
//   - deviceBreakdown: a fleet-wide count by platform/state/camera type/version/connectivity over
//     the non-excluded devices only. Always computed - nothing here needs calibration.
//   - Per-location online/offline rollup (location_sub_assets + locations.iot_healthy_count),
//     same shape as Broadsign/Grassfish but driven by the computed `online` (staleness) flag
//     instead of a raw-state allowlist - matched to a Location by venue name first, falling back
//     to manual_asset_inventory_ids. Excludes soft-deleted locations from that lookup (see
//     broadsign-sync for why that matters).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const PAGE_SIZE = 1000;
const DEFAULT_DEVICE_PATH = '/aioo_iot_admin_console/web_api/api/v1/device';
const DEFAULT_BOX_ID_FIELD = 'device_id';
const DEFAULT_STATUS_FIELD = 'status.state';
const DEFAULT_STALE_AFTER_MINUTES = 30;

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

function titleCase(s: string) {
  return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : 'Unknown';
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
// app_settings.iotApi and read straight into the chart cards on the frontend.
function countBy(devices: any[], getLabel: (d: any) => string) {
  const counts: Record<string, number> = {};
  for (const d of devices) {
    const label = getLabel(d) || 'Unknown';
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

// Real connectivity, computed from status.ts vs now - see header comment for why this replaces
// both status.state (frozen analytics mode, never actually "Offline" in practice) and status.age
// (process uptime, not staleness). Returns null lastSeenUtc/isOnline=false for a device with no
// parseable ts at all (never reported in - can't call that "online").
function connectivityForDevice(d: any, staleAfterMinutes: number) {
  const rawTs = d.status?.ts;
  const parsed = rawTs ? new Date(rawTs) : null;
  const lastSeenUtc = parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : null;
  const staleMinutes = lastSeenUtc ? (Date.now() - new Date(lastSeenUtc).getTime()) / 60000 : null;
  const online = staleMinutes != null && staleMinutes <= staleAfterMinutes;
  return { lastSeenUtc, online };
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
    const staleAfterMinutes = Number(cfg.staleAfterMinutes) > 0 ? Number(cfg.staleAfterMinutes) : DEFAULT_STALE_AFTER_MINUTES;

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

    // User-managed, persisted across syncs - never written by this function, only by the IoT
    // Panel's per-device exclude toggle.
    const excludedSet = new Set<string>((cfg.excludedDeviceIds || []).map((id: any) => String(id)));
    const activeDevices = devices.filter((d: any) => !excludedSet.has(String(d.device_id)));

    // Matched to Asset Inventory by boxIdField unconditionally (not gated behind anything) so a
    // Venue name can be attached to every device for the IoT Panel's table/search.
    const inventoryForVenue = await fetchAllInventory(adminClient, 'IoT');
    const inventoryIndexByBoxId = new Map<string, any[]>();
    for (const r of inventoryForVenue) {
      const key = String(r.player_box_id).trim();
      if (!key) continue;
      if (!inventoryIndexByBoxId.has(key)) inventoryIndexByBoxId.set(key, []);
      inventoryIndexByBoxId.get(key)!.push(r);
    }
    function venueForDevice(d: any): string {
      const key = String(getPath(d, boxIdField) ?? '').trim();
      const assets = key ? inventoryIndexByBoxId.get(key) : null;
      return assets && assets.length ? String(assets[0].venue || '') : '';
    }

    // The vendor doesn't send a separate MAC address field - on devices without a friendly name
    // set on their side, display_name IS the device's MAC address (confirmed from real data), so
    // that's flagged here rather than shown to look like a real name.
    const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

    // Trimmed snapshot of every pulled device (excluded or not) - lets the IoT Panel render a full
    // checkable device table without a separate live pull, and lets a previously-excluded device
    // be found again to re-include it.
    const lastDevices = devices.map((d: any) => {
      const deviceIdStr = String(d.device_id);
      const venue = venueForDevice(d);
      const rawName = d.display_name ? String(d.display_name) : '';
      const isMac = !!rawName && MAC_RE.test(rawName.trim());
      // A missing display_name used to fall back to the device_id itself, making Name and Device ID
      // show the exact same value in the table - not useful, so this falls back to Venue (a real,
      // distinct piece of information) instead, same as when display_name turns out to be a MAC.
      const hasRealName = !!rawName && !isMac && rawName !== deviceIdStr;
      const { lastSeenUtc, online } = connectivityForDevice(d, staleAfterMinutes);
      return {
        deviceId: deviceIdStr,
        displayName: hasRealName ? rawName : venue,
        macAddress: isMac ? rawName : '',
        venue,
        storeName: d.store_name || d.location?.store || '',
        asset: d.location?.asset || '',
        entrance: d.location?.entrance || '',
        platform: String(d.status?.platform || 'Unknown').toUpperCase(),
        state: titleCase(String(getPath(d, statusField) || '')),
        cameraType: d.status?.available_cameras || d.status?.camera_mode || 'Unknown',
        version: `${d.status?.task_version || '?'} - ${d.status?.core_version || '?'}`,
        ts: d.status?.ts || null,
        lastSeenUtc,
        online,
      };
    });

    // Fleet-wide breakdown over ACTIVE devices only - excluded ones never count, including right
    // after a fresh pull that still contains them.
    const deviceBreakdown = {
      totalDevices: activeDevices.length,
      byPlatform: countBy(activeDevices, (d: any) => String(d.status?.platform || 'Unknown').toUpperCase()),
      byState: countBy(activeDevices, (d: any) => titleCase(String(getPath(d, statusField) || ''))),
      byCameraType: countBy(activeDevices, (d: any) => d.status?.available_cameras || d.status?.camera_mode || 'Unknown'),
      byVersion: countBy(activeDevices, (d: any) => `${d.status?.task_version || '?'} - ${d.status?.core_version || '?'}`),
      byConnectivity: countBy(activeDevices, (d: any) => (connectivityForDevice(d, staleAfterMinutes).online ? 'Online' : 'Offline')),
    };

    const excludedCount = devices.length - activeDevices.length;
    const pulledLine = `Logged in and pulled ${devices.length} device(s) from the IoT Admin Console${excludedCount ? ` (${excludedCount} excluded, ${activeDevices.length} counted)` : ''}.`;
    const nowIso = new Date().toISOString();

    // Per-location online/offline rollup, driven by the computed `online` staleness flag (see
    // connectivityForDevice) - always runs now, no calibration step needed.
    const { data: locations } = await adminClient.from('locations').select('id, name, manual_asset_inventory_ids').is('deleted_at', null);
    const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));
    const locIdByManualAssetId = new Map<string, string>();
    for (const l of locations || []) {
      for (const assetId of l.manual_asset_inventory_ids || []) locIdByManualAssetId.set(assetId, l.id);
    }

    const matchedRows: { asset: any; device: any }[] = [];
    for (const device of activeDevices) {
      const key = String(getPath(device, boxIdField) ?? '').trim();
      if (!key) continue;
      const assets = inventoryIndexByBoxId.get(key);
      if (assets) for (const asset of assets) matchedRows.push({ asset, device });
    }
    const matchedCount = matchedRows.length;

    const rowsByLocation = new Map<string, { assetName: string; deviceId: string; offline: boolean; faces: number; pollLastUtc: string | null; statusLabel: string }[]>();
    let unmatchedLocation = 0;
    for (const { asset, device } of matchedRows) {
      const locId = (asset.venue && locByName.get(String(asset.venue).toLowerCase())) || locIdByManualAssetId.get(asset.id) || null;
      if (!locId) { unmatchedLocation++; continue; }
      const { lastSeenUtc, online } = connectivityForDevice(device, staleAfterMinutes);
      if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
      rowsByLocation.get(locId).push({
        assetName: asset.name, deviceId: String(getPath(device, boxIdField)), offline: !online, faces: asset.faces || 1,
        pollLastUtc: lastSeenUtc, statusLabel: lastSeenUtc ? 'Offline' : 'Never reported in',
      });
    }

    await adminClient.from('location_sub_assets').delete().eq('source', 'iot');
    await adminClient.from('locations').update({ iot_healthy_count: null, iot_as_of: null }).not('iot_healthy_count', 'is', null);

    let locationsUpdated = 0;
    for (const [locId, rows] of rowsByLocation.entries()) {
      const offlineRows = rows.filter((r) => r.offline);
      if (offlineRows.length) {
        await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
          location_id: locId, name: r.assetName, status: 'Offline', source: 'iot', faces: r.faces,
          poll_last_utc: r.pollLastUtc, status_label: r.statusLabel,
          notes: `IoT Device ID: ${r.deviceId}`,
        })));
      }
      await adminClient.from('locations').update({
        iot_healthy_count: rows.length - offlineRows.length, iot_as_of: nowIso,
      }).eq('id', locId);
      locationsUpdated++;
    }

    const summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated (stale after ${staleAfterMinutes}m).${unmatchedLocation ? ` ${unmatchedLocation} matched device(s) had no matching Location by venue name.` : ''}`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', deviceBreakdown, lastDevices, lastPulledCount: devices.length, lastMatchedCount: matchedCount, lastLocationsUpdated: locationsUpdated },
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
