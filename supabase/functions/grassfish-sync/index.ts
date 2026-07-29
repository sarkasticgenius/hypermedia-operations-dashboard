// Syncs live player status from Grassfish's locationlist/init API. Same rationale as
// broadsign-sync: runs server-side with the service role so the Grassfish API key never reaches
// the browser (the original app POSTed directly from client-side fetch() with X-ApiKey set to
// the raw key).
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
    const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
    if (!profile?.active) throw new Error('Inactive account');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'grassfishApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
      throw new Error('Grassfish integration is not fully configured (baseUrl, apiKey, enabled).');
    }

    const url = `${cfg.baseUrl.replace(/\/$/, '')}/GV2/Webservices/rest/gui/api/locations/locationlist/init`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-ApiKey': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Grassfish API returned ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.locations || body.data || []);

    const statusField = cfg.statusFieldName || 'status';
    const offlineValues = (cfg.offlineStatusValues || 'offline,error,unknown')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, name, player_type')
      .eq('player_type', 'Grassfish');
    const byName = new Map((inventory || []).map((r) => [String(r.name).toLowerCase(), r]));

    let matched = 0;
    let healthy = 0;
    for (const row of rows) {
      const name = String(row.name ?? row.locationName ?? '').toLowerCase();
      if (!byName.has(name)) continue;
      matched += 1;
      const statusRaw = String(row[statusField] ?? '').toLowerCase();
      if (!offlineValues.includes(statusRaw)) healthy += 1;
    }

    const nowIso = new Date().toISOString();
    const summary = `Matched ${matched} of ${rows.length} Grassfish rows to Asset Inventory, ${healthy} healthy.`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastRawSample: rows.slice(0, 3), lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'grassfishApi');

    return new Response(JSON.stringify({ summary, matched, healthy, total: rows.length }), {
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
