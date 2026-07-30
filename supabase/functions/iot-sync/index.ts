// Syncs device status from the aioo IoT Admin Console into location_sub_assets/locations,
// matched to Asset Inventory rows tagged Player Type "IoT" by Player Box ID - same shape as
// broadsign-sync/grassfish-sync.
//
// The only endpoint confirmed so far is login:
//   POST {baseUrl}/aioo_iot_admin_console/web_api/api/v1/auth
//   Body: {"username":"...", "password":"..."}
//   Response: {"expires_at","role","status","token"}
// The endpoint that actually lists devices was NOT provided, so it's a configurable field
// ("Device List Path" in Settings > Integrations > IoT Admin Console) rather than hardcoded -
// same reasoning as the generic Asset Inventory API Sync card: guessing a vendor path wrong
// (rather than asking) has already caused real bugs elsewhere in this project. Once the real
// path is confirmed, this function's calibration works exactly like Grassfish's old locationlist
// sync: raw response array shape is auto-detected, then a raw sample of one matched device is
// logged so "Box ID Field"/"Status Field Name" can be read off directly, then a raw value
// histogram once Status Field Name is set, so "Offline Status Values" can be set from real data.
//
// Runs server-side (service role) so the username/password/token never reach the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

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

// Response shape for the device-list endpoint is unknown (only login is confirmed), so this
// looks for the first array the response actually contains - same approach the old Grassfish
// sync used for its undocumented locationlist response.
function findArray(data: any): any[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const preferredKeys = ['Items', 'Data', 'Result', 'Results', 'Devices', 'devices', 'List', 'Rows', 'd'];
    for (const k of preferredKeys) if (Array.isArray(data[k])) return data[k];
    for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
  }
  return null;
}

function getPath(obj: any, path: string) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
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
    if (!cfg.enabled || !cfg.baseUrl || !cfg.username || !cfg.password || !cfg.devicePath) {
      throw new Error('IoT integration is not fully configured (Base URL, Username, Password, Device List Path, Enabled).');
    }

    const base = cfg.baseUrl.replace(/\/+$/, '');

    // Step 1: log in - this endpoint is confirmed exact, not guessed.
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
    if (!authData.token) throw new Error('Login response did not contain a "token" field - unexpected shape.');

    // Step 2: pull the IoT Box IDs from inventory.
    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, player_box_id')
      .eq('player_type', 'IoT')
      .not('player_box_id', 'is', null);
    const inventoryIndex = new Map((inventory || [])
      .filter((r) => String(r.player_box_id).trim())
      .map((r) => [String(r.player_box_id).trim().toLowerCase(), r]));
    if (!inventoryIndex.size) {
      throw new Error('No Asset Inventory rows are tagged Player Type "IoT" with a Player Box ID set - there is nothing to match against.');
    }

    // Step 3: fetch the device list from the configured (not guessed) path, token as Bearer auth.
    const devicePath = cfg.devicePath.startsWith('/') ? cfg.devicePath : `/${cfg.devicePath}`;
    const listRes = await fetch(`${base}${devicePath}`, {
      headers: { Authorization: `Bearer ${authData.token}`, Accept: 'application/json' },
    });
    if (!listRes.ok) {
      const bodyText = await listRes.text().catch(() => '');
      throw new Error(`Device list request failed: HTTP ${listRes.status}${listRes.status === 401 || listRes.status === 403 ? ' (token rejected - the API may expect the token in a different header; tell me the exact auth header it needs)' : ''}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const listData = await listRes.json();
    const items = findArray(listData);
    const nowIso = new Date().toISOString();

    if (!items) {
      const lastRawSample = JSON.stringify(listData, null, 2).slice(0, 3000);
      const summary = 'Logged in and called the Device List Path, but could not find an array of devices anywhere in the response. Raw response logged below - check it to see the actual shape, or confirm the Device List Path is correct.';
      await adminClient.from('app_settings').update({
        value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastRawSample, lastError: '' }, updated_at: nowIso,
      }).eq('key', 'iotApi');
      return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const boxIdField = cfg.boxIdField || 'box_id';
    const matchedRows: { asset: any; item: any }[] = [];
    const seenIds = new Set<string>();
    for (const item of items) {
      const raw = getPath(item, boxIdField);
      if (raw === undefined || raw === null) continue;
      const val = String(raw).trim().toLowerCase();
      const asset = inventoryIndex.get(val);
      if (asset) { matchedRows.push({ asset, item }); seenIds.add(val); }
    }
    const missingFromApi = [...inventoryIndex.keys()].filter((id) => !seenIds.has(id));
    const pulledLine = `Pulled ${inventoryIndex.size} IoT Box ID(s) from Asset Inventory; matched ${matchedRows.length} of them against the device list${missingFromApi.length ? `, ${missingFromApi.length} had no match (check "Box ID Field" is correct, or the device may be retired)` : ''}.`;
    const lastRawSample = matchedRows.length ? JSON.stringify(matchedRows[0].item, null, 2).slice(0, 3000) : (cfg.lastRawSample || null);

    const statusField = String(cfg.statusFieldName || '').trim();
    let summary: string;
    let rawCounts: Record<string, number> = cfg.lastRawStatusCounts || {};
    let locationsUpdated = 0;
    let missingList: string[] = missingFromApi;

    if (!statusField) {
      summary = `${pulledLine} A sample matched device's raw fields are logged below - find the one that represents online/offline, set "Status Field Name" to it, and Sync Now again.`;
    } else {
      rawCounts = {};
      for (const { item } of matchedRows) {
        const k = String(getPath(item, statusField));
        rawCounts[k] = (rawCounts[k] || 0) + 1;
      }
      const offlineSet = new Set(String(cfg.offlineStatusValues || '').split(',').map((s) => s.trim()).filter(Boolean));

      if (!offlineSet.size) {
        summary = `${pulledLine} Raw "${statusField}" values seen among matched devices: ${Object.keys(rawCounts).map((k) => `${k} (${rawCounts[k]}x)`).join(', ') || 'none'}. Set "Offline Status Values" below (comparing against devices you know are down) to start applying online/offline status.`;
      } else {
        const { data: locations } = await adminClient.from('locations').select('id, name');
        const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));

        const rowsByLocation = new Map<string, { assetName: string; boxId: string; offline: boolean }[]>();
        let unmatchedLocation = 0;
        for (const { asset, item } of matchedRows) {
          const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
          if (!locId) { unmatchedLocation++; continue; }
          const offline = offlineSet.has(String(getPath(item, statusField)));
          if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
          rowsByLocation.get(locId).push({ assetName: asset.name, boxId: String(asset.player_box_id), offline });
        }

        for (const [locId, rows] of rowsByLocation.entries()) {
          const offlineRows = rows.filter((r) => r.offline);
          await adminClient.from('location_sub_assets').delete().eq('location_id', locId).eq('source', 'iot');
          if (offlineRows.length) {
            await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
              location_id: locId, name: r.assetName, status: 'Offline', source: 'iot',
              notes: `IoT Box ID: ${r.boxId} - raw ${statusField} logged in Settings`,
            })));
          }
          await adminClient.from('locations').update({
            iot_healthy_count: rows.length - offlineRows.length, iot_as_of: nowIso,
          }).eq('id', locId);
          locationsUpdated++;
        }

        summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched device(s) had no matching Location by venue name.` : ''}`;
      }
    }

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastRawSample, lastRawStatusCounts: rawCounts, lastMissingFromApi: missingList },
      updated_at: nowIso,
    }).eq('key', 'iotApi');

    return new Response(JSON.stringify({ summary, matched: matchedRows.length, locationsUpdated }), {
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
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
