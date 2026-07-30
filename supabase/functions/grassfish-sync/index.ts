// Syncs live player status from Grassfish into location_sub_assets/locations, matched to Asset
// Inventory rows tagged Player Type "Grassfish" by Player Box ID.
//
// HISTORY (why this file has been rewritten twice):
//   1. Original: POST {baseUrl}/GV2/Webservices/rest/gui/api/locations/locationlist/init with
//      X-ApiKey auth - confirmed working against the real tenant (200 OK, real business data:
//      {"FilterResultID": "...", "TotalItemCount": 876, "HasError": false}) but the code never
//      followed up on the FilterResultID, so it always fell into the "no array found" branch and
//      never actually synced anything.
//   2. Rewrite attempt: switched to GET {baseUrl}/v1/player/{boxId} with X-Session-Id, based on a
//      generic sample snippet. Verified via Edge Function logs + Settings' lastSyncSummary this
//      404s for every single box ID against the real tenant - that path doesn't exist here.
//   3. This version: back to the PROVEN-working locationlist/init call, now completing the
//      two-step flow - init returns a FilterResultID (a server-side cached filter, not the data
//      itself), so a second call re-posts to the SAME endpoint with that FilterResultID plus
//      paging fields to actually fetch the matched items. This exact follow-up call shape is a
//      best-effort guess (Grassfish's GV2 client webservices aren't publicly documented - see
//      docs.grassfish.com, which only covers the newer IXM/Ad Booking APIs) - if it's wrong,
//      "Last raw sample" in Settings will show exactly what came back so it can be corrected in
//      one more round instead of guessed blind.
//
// Runs server-side (service role) so the API key never reaches the browser. Called two ways:
//   1. Settings > Integrations > Grassfish API "Test / Sync Now" - authenticated admin JWT.
//   2. A pg_cron job every 20 minutes (see migration 0014) - sends a shared secret in
//      x-cron-secret instead of a user session (pg_cron can't hold one).
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

// Response shape for the "list" step isn't confirmed yet (only "init" is proven), so this looks
// for the first array the response actually contains rather than assuming a wrapper key.
function findLocationArray(data: any): any[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const preferredKeys = ['Items', 'Data', 'Result', 'Results', 'Locations', 'List', 'Rows', 'd'];
    for (const k of preferredKeys) if (Array.isArray(data[k])) return data[k];
    for (const k of Object.keys(data)) if (Array.isArray(data[k])) return data[k];
  }
  return null;
}

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
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'grassfishApi').single();
    const cfg = settingsRow?.value || {};
    const apiKey = cfg.apiKey || cfg.sessionId;
    if (!cfg.enabled || !cfg.baseUrl || !apiKey) {
      throw new Error('Grassfish integration is not fully configured (Base URL, API Key, Enabled).');
    }

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

    const base = cfg.baseUrl.replace(/\/+$/, '');
    const initUrl = `${base}/GV2/Webservices/rest/gui/api/locations/locationlist/init`;
    const headers = { 'X-ApiKey': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };

    // Step 1: init - proven working, returns {FilterResultID, TotalItemCount, HasError}, not the
    // items themselves.
    const initRes = await fetch(initUrl, {
      method: 'POST', headers,
      body: JSON.stringify({
        SearchItem: '', LocationCategoryID: 0, AttributeList: [],
        SortingCriteria: [{ Field: 'name', Direction: 'Asc' }],
        OptionalFilters: [{ Key: 'IsCanceled', Value: false }],
      }),
    });
    if (!initRes.ok) {
      const bodyText = await initRes.text().catch(() => '');
      throw new Error(`locationlist/init failed: HTTP ${initRes.status}${initRes.status === 401 || initRes.status === 403 ? ' (auth rejected - check the API Key)' : ''}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const initData = await initRes.json();
    if (initData.HasError) throw new Error('Grassfish reported HasError on locationlist/init.');

    const nowIso = new Date().toISOString();
    let data: any = initData;
    let items = findLocationArray(initData);

    // Step 2: init didn't return items directly (the normal case - it returns a FilterResultID
    // pointing at a server-side cached result set) - re-post to the same endpoint with that ID
    // plus paging fields to actually fetch them. Best-effort shape; see header comment.
    if (!items && initData.FilterResultID) {
      const listRes = await fetch(initUrl, {
        method: 'POST', headers,
        body: JSON.stringify({
          FilterResultID: initData.FilterResultID, PageIndex: 0,
          PageSize: initData.TotalItemCount || 1000,
        }),
      });
      if (listRes.ok) {
        data = await listRes.json();
        items = findLocationArray(data);
      }
    }

    if (!items) {
      const lastRawSample = JSON.stringify(data, null, 2).slice(0, 3000);
      const summary = initData.FilterResultID
        ? `Connected - locationlist/init returned FilterResultID ${initData.FilterResultID} (${initData.TotalItemCount ?? '?'} total items), but the follow-up call to fetch those items didn't return a usable array. Raw response from that follow-up call is logged below - tell me the real "fetch results" endpoint/shape and I'll wire it in exactly.`
        : 'Connected, but could not find an array of locations anywhere in the response, and no FilterResultID was returned to follow up on. Raw response logged below.';
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
    const pulledLine = `Pulled ${inventoryIndex.size} Grassfish ID(s) from Asset Inventory; matched ${matchedRows.length} of them against ${items.length} item(s) returned${missingFromApi.length ? `, ${missingFromApi.length} had no match (check spelling/case, or the box may be retired)` : ''}.`;
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
