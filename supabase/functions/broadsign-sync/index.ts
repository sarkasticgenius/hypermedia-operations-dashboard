// Syncs live player health from Broadsign's monitor_poll/v2 API into asset_inventory-linked
// locations. Runs server-side (service role) so the Broadsign API key never reaches the browser -
// the original app called this directly from client-side fetch() with the raw key in a Bearer
// header, which is exactly what this function replaces.
//
// Matching: joins Broadsign's client_resource_id to asset_inventory.player_box_id (the primary
// "asset-link precedence" rule from the original refresh_broadsign_snapshot.py), then rolls
// healthy/total counts up to whichever locations.name case-insensitively matches that asset's
// venue. The original script also had a hand-maintained folder-fallback list (~40 venues with no
// Asset Inventory rows, matched by Broadsign's folder hierarchy instead) and a venue-name alias
// table - neither is ported here; venues that only exist in that fallback list won't get a
// health count until that mapping is added to this function.
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
      throw new Error('Broadsign integration is not fully configured (baseUrl, apiKey, domainId, enabled).');
    }

    const url = `${cfg.baseUrl.replace(/\/$/, '')}/rest/monitor_poll/v2?domain_id=${encodeURIComponent(cfg.domainId)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.apiKey}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Broadsign API returned ${res.status}`);
    const players = await res.json();
    const playerList = Array.isArray(players) ? players : (players.players || players.data || []);

    const offlineValues = (cfg.offlineStatusValues || 'offline,error,unknown')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

    const { data: inventory } = await adminClient
      .from('asset_inventory')
      .select('id, venue, player_box_id')
      .not('player_box_id', 'is', null);

    const byBoxId = new Map((inventory || []).map((r) => [String(r.player_box_id), r]));
    const venueCounts = new Map();

    for (const p of playerList) {
      const boxId = String(p.client_resource_id ?? p.clientResourceId ?? p.resource_id ?? '');
      const match = byBoxId.get(boxId);
      if (!match || !match.venue) continue;
      const statusRaw = String(p.status ?? p.state ?? '').toLowerCase();
      const healthy = !offlineValues.includes(statusRaw);
      const entry = venueCounts.get(match.venue) || { healthy: 0, total: 0 };
      entry.total += 1;
      if (healthy) entry.healthy += 1;
      venueCounts.set(match.venue, entry);
    }

    const nowIso = new Date().toISOString();
    let updatedLocations = 0;
    for (const [venue, counts] of venueCounts.entries()) {
      const { data: updated, error } = await adminClient
        .from('locations')
        .update({ broadsign_healthy_count: counts.healthy, broadsign_as_of: nowIso })
        .ilike('name', venue)
        .select('id');
      if (!error && updated) updatedLocations += updated.length;
    }

    const summary = `Matched ${venueCounts.size} venue(s), updated ${updatedLocations} location row(s) from ${playerList.length} players.`;
    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'broadsignApi');

    return new Response(JSON.stringify({ summary, venuesMatched: venueCounts.size, updatedLocations }), {
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
