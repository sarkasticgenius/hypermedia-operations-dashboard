// Syncs live player status from Grassfish's locationlist/init API into location_sub_assets/
// locations, ported from the original app's syncGrassfishApiDirect() - built from a working
// request the user supplied from their own integration, not published Grassfish docs (which sit
// behind a login wall). Runs server-side (service role) so the Grassfish API key never reaches
// the browser; the key itself is configured separately in Settings > Integrations, not here.
//
// Request (confirmed working shape):
//   POST {baseUrl}/GV2/Webservices/rest/gui/api/locations/locationlist/init
//   Header: X-ApiKey: <apiKey>
//   Body: {SearchItem:'', LocationCategoryID:0, AttributeList:[], SortingCriteria:[{Field:'name',
//          Direction:'Asc'}], OptionalFilters:[{Key:'IsCanceled',Value:false}]}
//   (SearchItem left blank deliberately - this wants every location back, then matches locally by
//   Player Box ID, the same "pull inventory IDs first, then match" shape as broadsign-sync.)
//
// Two things this can NOT assume, unlike Broadsign (whose monitor_poll/v2 shape is documented):
//   1. The exact response shape (which key holds the location array) - handled by scanning the
//      response for the first array-valued key it finds (findLocationArrayInResponse).
//   2. Which field on a matched item is the Player Box ID match key, and which field represents
//      online/offline status, and what its values mean - handled the same two-stage calibration
//      way as Broadsign's undocumented monitor_status: a sync first logs a raw sample of one
//      matched item's fields (lastRawSample) so the field names can be read off directly, then
//      Status Field Name is set, then a raw histogram of that field's values is logged
//      (lastRawStatusCounts) so Offline Status Values can be set from real data - never guessed.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Grassfish's response shape isn't documented anywhere this app can read, so rather than assume a
// wrapper key, this looks for the first array the response actually contains.
function findLocationArray(data: any): any[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const preferredKeys = ['Items', 'Data', 'Result', 'Results', 'Locations', 'List', 'Rows', 'd'];
    for (const k of preferredKeys) if (Array.isArray(data[k])) return data[k];
    for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
  }
  return null;
}

// Same "which field is the identifier" problem as the status field - tries the field names most
// likely to hold the code/reference matching Asset Inventory's Player Box ID.
function matchValue(item: any): string {
  const candidateKeys = ['Reference', 'Ref', 'Code', 'Name', 'ExternalReference', 'ExternalId', 'LocationName', 'ScreenName'];
  for (const k of candidateKeys) {
    if (item[k] !== undefined && item[k] !== null) return String(item[k]).trim().toLowerCase();
  }
  return '';
}

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
    const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
    if (!profile?.active) throw new Error('Inactive account');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'grassfishApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
      throw new Error('Grassfish integration is not fully configured (Base URL, API Key, Enabled).');
    }

    // Step 1: pull the Grassfish Player Box IDs from inventory, up front.
    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, player_box_id')
      .eq('player_type', 'Grassfish')
      .not('player_box_id', 'is', null);
    const inventoryIndex = new Map((inventory || [])
      .filter((r) => String(r.player_box_id).trim())
      .map((r) => [String(r.player_box_id).trim().toLowerCase(), r]));
    if (!inventoryIndex.size) {
      throw new Error('No Asset Inventory rows are tagged Player Type "Grassfish" with a Player Box ID set - there is nothing to match against.');
    }

    // Step 2: the exact working request shape - SearchItem left blank on purpose (wants every
    // location back, then matches locally).
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/GV2/Webservices/rest/gui/api/locations/locationlist/init`;
    const body = {
      SearchItem: '', LocationCategoryID: 0, AttributeList: [],
      SortingCriteria: [{ Field: 'name', Direction: 'Asc' }],
      OptionalFilters: [{ Key: 'IsCanceled', Value: false }],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-ApiKey': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (auth rejected - check the API Key)' : ''}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    const items = findLocationArray(data);
    const nowIso = new Date().toISOString();

    if (!items) {
      const lastRawSample = JSON.stringify(data, null, 2).slice(0, 3000);
      const summary = 'Connected, but could not find an array of locations anywhere in the response. Raw response logged below - check it to see the actual shape.';
      await adminClient.from('app_settings').update({
        value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastRawSample, lastError: '' }, updated_at: nowIso,
      }).eq('key', 'grassfishApi');
      return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    // Step 3: match every Grassfish inventory Player Box ID against whichever field on each item
    // looks like its identifier.
    const matchedRows: { asset: { id: string; name: string; venue: string | null; player_box_id: string }; item: any }[] = [];
    const seenIds = new Set<string>();
    for (const item of items) {
      const val = matchValue(item);
      if (!val) continue;
      const asset = inventoryIndex.get(val);
      if (asset) { matchedRows.push({ asset, item }); seenIds.add(val); }
    }
    const missingFromApi = [...inventoryIndex.keys()].filter((id) => !seenIds.has(id));
    const pulledLine = `Pulled ${inventoryIndex.size} Grassfish ID(s) from Asset Inventory; matched ${matchedRows.length} of them against the API response${missingFromApi.length ? `, ${missingFromApi.length} had no match (check spelling/case, or the box may be retired)` : ''}.`;
    const lastRawSample = matchedRows.length ? JSON.stringify(matchedRows[0].item, null, 2).slice(0, 3000) : (cfg.lastRawSample || null);

    const statusField = String(cfg.statusFieldName || '').trim();
    let summary: string;
    let rawCounts: Record<string, number> = cfg.lastRawStatusCounts || {};
    let locationsUpdated = 0;

    if (!statusField) {
      summary = `${pulledLine} A sample matched location's raw fields are logged below - find the one that represents online/offline, then set "Status Field Name" to it and Sync Now again.`;
    } else {
      rawCounts = {};
      for (const { item } of matchedRows) {
        const k = String(item[statusField]);
        rawCounts[k] = (rawCounts[k] || 0) + 1;
      }
      const offlineSet = new Set(String(cfg.offlineStatusValues || '').split(',').map((s) => s.trim()).filter(Boolean));

      if (!offlineSet.size) {
        summary = `${pulledLine} Raw "${statusField}" values seen among matched screens: ${Object.keys(rawCounts).map((k) => `${k} (${rawCounts[k]}x)`).join(', ') || 'none'}. Set "Offline Status Values" below (comparing against screens you know are down) to start applying online/offline status.`;
      } else {
        const { data: locations } = await adminClient.from('locations').select('id, name');
        const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));

        const rowsByLocation = new Map<string, { assetName: string; playerBoxId: string; offline: boolean }[]>();
        let unmatchedLocation = 0;
        for (const { asset, item } of matchedRows) {
          const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
          if (!locId) { unmatchedLocation++; continue; }
          const offline = offlineSet.has(String(item[statusField]));
          if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
          rowsByLocation.get(locId).push({ assetName: asset.name, playerBoxId: String(asset.player_box_id), offline });
        }

        for (const [locId, rows] of rowsByLocation.entries()) {
          const offlineRows = rows.filter((r) => r.offline);
          await adminClient.from('location_sub_assets').delete().eq('location_id', locId).eq('source', 'grassfish');
          if (offlineRows.length) {
            await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
              location_id: locId, name: r.assetName, status: 'Offline', source: 'grassfish',
              notes: `Grassfish Player ID: ${r.playerBoxId} - raw ${statusField} logged in Settings`,
            })));
          }
          await adminClient.from('locations').update({
            grassfish_healthy_count: rows.length - offlineRows.length, grassfish_as_of: nowIso,
          }).eq('id', locId);
          locationsUpdated++;
        }

        summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched screen(s) had no matching Location by venue name.` : ''}`;
      }
    }

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastRawSample, lastRawStatusCounts: rawCounts, lastMissingFromApi: missingFromApi },
      updated_at: nowIso,
    }).eq('key', 'grassfishApi');

    return new Response(JSON.stringify({ summary, matched: matchedRows.length, locationsUpdated }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'grassfishApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'grassfishApi');
      }
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
