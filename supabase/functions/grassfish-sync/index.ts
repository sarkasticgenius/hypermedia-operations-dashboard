// Syncs live player status from Grassfish's real per-box endpoint into location_sub_assets/
// locations. Replaces the earlier locationlist/init-based sync (undocumented bulk endpoint,
// needed two-stage field/value calibration) now that a real, documented endpoint has been
// confirmed:
//   GET {baseUrl}/v1/player/{boxId}
//   Header: X-Session-Id: <sessionId>
//   Response: {"IsOnline": bool, "LastAccess": "<timestamp>", ...}
// No calibration needed - IsOnline is a real boolean, unlike Broadsign's undocumented
// monitor_status codes or the old Grassfish bulk endpoint's unknown field names.
//
// Runs server-side (service role) so the Session ID never reaches the browser. Called two ways:
//   1. Settings > Integrations > Grassfish API "Test / Sync Now" button - authenticated admin
//      user JWT in the Authorization header.
//   2. A pg_cron job (see migration 0014) every 20 minutes - pg_cron can't hold a user session, so
//      it instead sends a shared secret (generated at migration time, stored in the admin-only
//      app_settings row '_cronSecret', never committed to the repo) in an `x-cron-secret` header.
//      Both paths are checked in isAuthorized() below.
//
// Since there's one HTTP call per box id (no bulk endpoint), matched box ids are polled in
// small concurrent batches rather than one at a time, so a sync across hundreds of screens
// finishes well inside the function's execution window.
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

async function fetchPlayer(baseUrl: string, sessionId: string, boxId: string) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/player/${encodeURIComponent(boxId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'X-Session-Id': sessionId, Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { boxId, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { boxId, isOnline: !!data.IsOnline, lastAccess: data.LastAccess ?? null };
  } catch (err) {
    clearTimeout(timer);
    return { boxId, error: err instanceof Error ? err.message : String(err) };
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
    const sessionId = cfg.sessionId || cfg.apiKey;
    if (!cfg.enabled || !cfg.baseUrl || !sessionId) {
      throw new Error('Grassfish integration is not fully configured (Base URL, Session ID, Enabled).');
    }

    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, name, venue, player_box_id')
      .eq('player_type', 'Grassfish')
      .not('player_box_id', 'is', null);
    const inventoryIndex = new Map((inventory || [])
      .filter((r) => String(r.player_box_id).trim())
      .map((r) => [String(r.player_box_id).trim(), r]));
    if (!inventoryIndex.size) {
      throw new Error('No Asset Inventory rows are tagged Player Type "Grassfish" with a Player Box ID set - there is nothing to poll.');
    }

    const boxIds = [...inventoryIndex.keys()];
    const pollResults = await runBatched(boxIds, (id) => fetchPlayer(cfg.baseUrl, sessionId, id), 10);

    const matched: { asset: any; isOnline: boolean; lastAccess: string | null }[] = [];
    const failed: { boxId: string; error: string }[] = [];
    for (const r of pollResults) {
      if ('error' in r && r.error) failed.push({ boxId: r.boxId, error: r.error });
      else matched.push({ asset: inventoryIndex.get(r.boxId), isOnline: r.isOnline, lastAccess: r.lastAccess });
    }
    const pulledLine = `Polled ${boxIds.length} Grassfish box ID(s) from Asset Inventory; ${matched.length} responded, ${failed.length} failed${failed.length ? ` (e.g. ${failed[0].boxId}: ${failed[0].error})` : ''}.`;

    const { data: locations } = await adminClient.from('locations').select('id, name');
    const locByName = new Map((locations || []).map((l) => [l.name.toLowerCase(), l.id]));

    const rowsByLocation = new Map<string, { assetName: string; boxId: string; offline: boolean; lastAccess: string | null }[]>();
    let unmatchedLocation = 0;
    for (const { asset, isOnline, lastAccess } of matched) {
      const locId = asset.venue ? locByName.get(String(asset.venue).toLowerCase()) : null;
      if (!locId) { unmatchedLocation++; continue; }
      if (!rowsByLocation.has(locId)) rowsByLocation.set(locId, []);
      rowsByLocation.get(locId).push({ assetName: asset.name, boxId: String(asset.player_box_id), offline: !isOnline, lastAccess });
    }

    const nowIso = new Date().toISOString();
    let locationsUpdated = 0;
    for (const [locId, rows] of rowsByLocation.entries()) {
      const offlineRows = rows.filter((r) => r.offline);
      await adminClient.from('location_sub_assets').delete().eq('location_id', locId).eq('source', 'grassfish');
      if (offlineRows.length) {
        await adminClient.from('location_sub_assets').insert(offlineRows.map((r) => ({
          location_id: locId, name: r.assetName, status: 'Offline', source: 'grassfish',
          notes: `Grassfish Player ID: ${r.boxId}${r.lastAccess ? ` - Last Access: ${r.lastAccess}` : ''}`,
        })));
      }
      await adminClient.from('locations').update({
        grassfish_healthy_count: rows.length - offlineRows.length, grassfish_as_of: nowIso,
      }).eq('id', locId);
      locationsUpdated++;
    }

    const summary = `${pulledLine} Synced live: ${locationsUpdated} location(s) updated.${unmatchedLocation ? ` ${unmatchedLocation} matched screen(s) had no matching Location by venue name.` : ''}`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '', lastMissingFromApi: failed.map((f) => f.boxId) },
      updated_at: nowIso,
    }).eq('key', 'grassfishApi');

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
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
