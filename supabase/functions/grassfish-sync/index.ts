// Syncs live player status from Grassfish into location_sub_assets/locations, matched to Asset
// Inventory rows tagged Player Type "Grassfish" by Player Box ID.
//
// Reverse-engineered live against the real tenant (digitall.grassfish.tv) via curl, since
// Grassfish's GV2 client webservices aren't publicly documented (docs.grassfish.com only covers
// the newer IXM/Ad Booking APIs). Two earlier attempts were wrong:
//   1. POST .../locationlist/init alone - returns {FilterResultID, TotalItemCount, HasError} but
//      never followed up on the FilterResultID, so nothing ever synced.
//   2. GET .../v1/player/{boxId} with X-Session-Id - 404s for every box ID on this tenant; that
//      path doesn't exist here.
// The real three-step flow, confirmed by hitting the live API directly:
//   1. POST {baseUrl}/GV2/Webservices/rest/gui/api/locations/locationlist/init
//      Header: X-ApiKey: <apiKey>
//      Body: {SearchItem:'', LocationCategoryID:0, AttributeList:[], SortingCriteria:[...],
//             OptionalFilters:[{Key:'IsCanceled',Value:false}]}
//      Response: {FilterResultID, TotalItemCount, HasError} - just starts a server-side cached
//      filter, doesn't return items.
//   2. GET {baseUrl}/GV2/Webservices/rest/gui/api/locations/list?FilterResultID=<id>
//      Response: [{Id, Name, BoxId, CustomerCode?, Edition?, LicenseType}, ...] - the full
//      registry (876 items on this tenant), confirmed to match TotalItemCount. No status field
//      here - this step is only for resolving BoxId -> internal numeric Id.
//   3. GET {baseUrl}/GV2/Webservices/rest/gui/api/locations/<Id>  (one call per matched item)
//      Response: full location detail including "BoxIsOnline": bool and "LastBoxAccess": string.
//      This is the real online/offline signal - no ambiguous field-name guessing needed, unlike
//      Broadsign's undocumented monitor_status codes.
//
// Runs server-side (service role) so the API key never reaches the browser. Called two ways:
//   1. Settings > Integrations > Grassfish API "Test / Sync Now" - authenticated admin JWT.
//   2. A pg_cron job every 15 minutes (see migration 0018) - sends a shared secret in
//      x-cron-secret instead of a user session (pg_cron can't hold one).
// Every run writes a row to integration_sync_logs (pruned to the most recent 100 per integration)
// for the console page's "View Sync Log", and the asset_inventory pull is paginated - Supabase's
// project-wide "Max Rows" setting silently caps any single unpaginated select once row counts grow
// past it (this bit Broadsign for real; Grassfish's count is small enough today to not have hit it
// yet, but this avoids the same silent-truncation bug down the line).
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

async function fetchDetail(base: string, apiKey: string, id: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${base}/GV2/Webservices/rest/gui/api/locations/${id}`, {
      headers: { 'X-ApiKey': apiKey, Accept: 'application/json' }, signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { id, error: `HTTP ${res.status}` };
    const detail = await res.json();
    return { id, isOnline: !!detail.BoxIsOnline, lastAccess: detail.LastBoxAccess ?? null };
  } catch (err) {
    clearTimeout(timer);
    return { id, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runBatched<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
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

    // Map<boxId, Asset[]>, not Map<boxId, Asset> - player_box_id isn't guaranteed unique (a handful
    // of Grassfish rows share a box id, same as Broadsign's much larger duplicate-box-id gap), so a
    // single-Asset map would silently drop every sibling row past the first for a shared box id.
    const inventory = await fetchAllInventory(adminClient, 'Grassfish');
    const inventoryIndex = new Map<string, any[]>();
    for (const r of inventory) {
      const key = String(r.player_box_id).trim().toLowerCase();
      if (!key) continue;
      if (!inventoryIndex.has(key)) inventoryIndex.set(key, []);
      inventoryIndex.get(key)!.push(r);
    }
    const totalScreens = [...inventoryIndex.values()].reduce((sum, arr) => sum + arr.length, 0);
    if (!totalScreens) {
      throw new Error('No Asset Inventory rows are tagged Player Type "Grassfish" with a Player Box ID set - there is nothing to match against.');
    }

    const base = cfg.baseUrl.replace(/\/+$/, '');
    const headers = { 'X-ApiKey': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };

    // Step 1: init a filtered search.
    const initRes = await fetch(`${base}/GV2/Webservices/rest/gui/api/locations/locationlist/init`, {
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
    if (!initData.FilterResultID) throw new Error('locationlist/init did not return a FilterResultID - unexpected response shape.');

    // Step 2: resolve the registry (BoxId -> internal numeric Id) for this filter.
    const listRes = await fetch(`${base}/GV2/Webservices/rest/gui/api/locations/list?FilterResultID=${encodeURIComponent(initData.FilterResultID)}`, {
      headers: { 'X-ApiKey': apiKey, Accept: 'application/json' },
    });
    if (!listRes.ok) {
      const bodyText = await listRes.text().catch(() => '');
      throw new Error(`locations/list failed: HTTP ${listRes.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    const registry = await listRes.json();
    if (!Array.isArray(registry)) throw new Error('locations/list did not return an array - unexpected response shape.');

    const matchedRegistry = registry.filter((r: any) => r.BoxId && inventoryIndex.has(String(r.BoxId).trim().toLowerCase()));
    const pulledLine = `Pulled ${totalScreens} Grassfish screen(s) from Asset Inventory (${inventoryIndex.size} distinct Box ID${inventoryIndex.size === 1 ? '' : 's'}); matched ${matchedRegistry.length} of them against ${registry.length} location(s) in Grassfish's registry.`;

    // Step 3: fetch per-item detail (BoxIsOnline/LastBoxAccess) for every matched item, batched.
    const details = await runBatched(matchedRegistry, (r: any) => fetchDetail(base, apiKey, r.Id), 10);

    // A matched box id fans out to every asset_inventory row sharing it (see the inventoryIndex note
    // above) - so one Grassfish registry item can produce several `matched` entries.
    const matched: { asset: any; isOnline: boolean; lastAccess: string | null }[] = [];
    const failed: { boxId: string; error: string }[] = [];
    for (let i = 0; i < matchedRegistry.length; i++) {
      const r = matchedRegistry[i];
      const d: any = details[i];
      const assets = inventoryIndex.get(String(r.BoxId).trim().toLowerCase()) || [];
      if (d.error) failed.push({ boxId: r.BoxId, error: d.error });
      else for (const asset of assets) matched.push({ asset, isOnline: d.isOnline, lastAccess: d.lastAccess });
    }

    const { data: locations } = await adminClient.from('locations').select('id, name');
    const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));

    const rowsByLocation = new Map<string, { assetName: string; boxId: string; offline: boolean; lastAccess: string | null; faces: number }[]>();
    let unmatchedLocation = 0;
    for (const { asset, isOnline, lastAccess } of matched) {
      const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
      if (!locId) { unmatchedLocation++; continue; }
      if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
      rowsByLocation.get(locId).push({ assetName: asset.name, boxId: String(asset.player_box_id), offline: !isOnline, lastAccess, faces: asset.faces || 1 });
    }

    const nowIso = new Date().toISOString();
    let locationsUpdated = 0;

    // Same fix as broadsign-sync: wipe every existing grassfish-sourced offline row and healthy-
    // count up front, once, instead of per-location inside the loop - a per-location delete/update
    // never touched a location that dropped out of the matched set entirely, leaving stale offline
    // rows and healthy_count behind indefinitely.
    await adminClient.from('location_sub_assets').delete().eq('source', 'grassfish');
    await adminClient.from('locations').update({ grassfish_healthy_count: null, grassfish_as_of: null }).not('grassfish_healthy_count', 'is', null);

    for (const [locId, rows] of rowsByLocation.entries()) {
      const offlineRows = rows.filter((r) => r.offline);
      if (offlineRows.length) {
        await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
          location_id: locId, name: r.assetName, status: 'Offline', source: 'grassfish', faces: r.faces,
          notes: `Grassfish Box ID: ${r.boxId}${r.lastAccess && r.lastAccess !== '0001-01-01T00:00:00Z' ? ` - Last Access: ${r.lastAccess}` : ''}`,
        })));
      }
      await adminClient.from('locations').update({
        grassfish_healthy_count: rows.length - offlineRows.length, grassfish_as_of: nowIso,
      }).eq('id', locId);
      locationsUpdated++;
    }

    const summary = `${pulledLine} ${matched.length} responded, ${failed.length} failed${failed.length ? ` (e.g. ${failed[0].boxId}: ${failed[0].error})` : ''}. Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched screen(s) had no matching Location by venue name.` : ''}`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastMissingFromApi: failed.map((f) => f.boxId), lastRawSample: null, lastRawStatusCounts: null, statusFieldName: null, offlineStatusValues: null, lastPulledCount: totalScreens, lastMatchedCount: matched.length, lastLocationsUpdated: locationsUpdated },
      updated_at: nowIso,
    }).eq('key', 'grassfishApi');

    await logSync(adminClient, {
      integration: 'grassfish', synced_at: nowIso, pulled_count: totalScreens,
      matched_count: matched.length, failed_count: failed.length, locations_updated: locationsUpdated,
      missing_ids: failed.map((f) => f.boxId), summary, error: null,
    });

    return new Response(JSON.stringify({ summary, matched: matched.length, locationsUpdated }), {
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
      await logSync(adminClient, { integration: 'grassfish', synced_at: new Date().toISOString(), error: message });
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
