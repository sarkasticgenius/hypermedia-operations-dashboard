// Generic, vendor-agnostic Asset Inventory sync: fetches a configured JSON API endpoint
// server-side (so any auth stays out of the browser, same rationale as
// broadsign-sync/grassfish-sync), applies an admin-configured field mapping, and upserts into
// asset_inventory keyed on source_asset_id (falls back to name+venue when the source has no
// numeric id). Config lives in app_settings.assetInventoryApi:
//   { baseUrl, dataPath, authHeaderName, authHeaderValue,
//     clientId, clientSecret, tokenPath,
//     fieldMapping: {ourColumn: "source.field.path"}, enabled, lastSync, lastSyncSummary, lastError }
// fieldMapping values support simple dot-paths (e.g. "attributes.venue") into each item of the
// response array (or response.data / response.items / response.results if the top level is an
// object rather than a bare array).
// Auth: if clientId + clientSecret are set, does an OAuth2 client-credentials style handshake -
// POST {baseUrl}{tokenPath || /identity/oauth2} with {client_id, client_secret} JSON body,
// reads response.access_token, sends it as "Authorization: Bearer <token>" on the data request.
// Otherwise falls back to a single static header (authHeaderName/authHeaderValue), or no auth.
// The data request hits {baseUrl}{dataPath} (dataPath defaults to '', i.e. baseUrl itself).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function getPath(obj: any, path: string) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function joinUrl(base: string, path?: string) {
  if (!path) return base;
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

const ALLOWED_COLUMNS = new Set([
  'source_asset_id', 'name', 'venue', 'location', 'category', 'pdooh_ready', 'format',
  'width', 'height', 'screens', 'faces', 'special_render', 'anydesk_id', 'teamviewer_id',
  'sensor_id', 'lat', 'lng', 'multiplier', 'position', 'player_box_id', 'ad_duration',
  'player_type', 'managed_by_hm',
]);

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

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'assetInventoryApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl) {
      throw new Error('Asset Inventory API sync is not configured (baseUrl, enabled).');
    }
    const mapping = cfg.fieldMapping && typeof cfg.fieldMapping === 'object' ? cfg.fieldMapping : {};
    if (!mapping.name && !mapping.source_asset_id) {
      throw new Error('fieldMapping must map at least "name" or "source_asset_id" to a source field.');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.clientId && cfg.clientSecret) {
      const tokenUrl = joinUrl(cfg.baseUrl, cfg.tokenPath || '/identity/oauth2');
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
      });
      if (!tokenRes.ok) throw new Error(`OAuth token request failed: ${tokenRes.status}`);
      const tokenBody = await tokenRes.json();
      if (!tokenBody.access_token) throw new Error('OAuth token response had no access_token field.');
      headers.Authorization = `Bearer ${tokenBody.access_token}`;
    } else if (cfg.authHeaderName && cfg.authHeaderValue) {
      headers[cfg.authHeaderName] = cfg.authHeaderValue;
    }

    const res = await fetch(joinUrl(cfg.baseUrl, cfg.dataPath), { headers });
    if (!res.ok) throw new Error(`Source API returned ${res.status}`);
    const body = await res.json();
    const items: any[] = Array.isArray(body) ? body : (body.data || body.items || body.results || []);
    if (!Array.isArray(items)) throw new Error('Response was not an array (or data/items/results array).');

    const mappedRows = items.map((item) => {
      const row: Record<string, unknown> = { source: 'api-sync' };
      for (const [column, sourcePath] of Object.entries(mapping)) {
        if (!ALLOWED_COLUMNS.has(column)) continue;
        const value = getPath(item, sourcePath as string);
        if (value !== undefined) row[column] = value;
      }
      return row;
    }).filter((r) => r.name || r.source_asset_id);

    let inserted = 0;
    let updated = 0;
    for (const row of mappedRows) {
      let existing = null;
      if (row.source_asset_id != null) {
        const { data } = await adminClient.from('asset_inventory').select('id').eq('source_asset_id', row.source_asset_id).maybeSingle();
        existing = data;
      }
      if (!existing && row.name && row.venue) {
        const { data } = await adminClient.from('asset_inventory').select('id').eq('name', row.name).eq('venue', row.venue).maybeSingle();
        existing = data;
      }
      if (existing) {
        await adminClient.from('asset_inventory').update(row).eq('id', existing.id);
        updated++;
      } else {
        await adminClient.from('asset_inventory').insert(row);
        inserted++;
      }
    }

    const nowIso = new Date().toISOString();
    const summary = `Synced ${mappedRows.length} row(s): ${inserted} new, ${updated} updated.`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'assetInventoryApi');

    return new Response(JSON.stringify({ summary, inserted, updated, total: mappedRows.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'assetInventoryApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'assetInventoryApi');
      }
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
