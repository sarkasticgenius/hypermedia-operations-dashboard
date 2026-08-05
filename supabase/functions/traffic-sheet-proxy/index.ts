// Live proxy for the AdLive Center Traffic Sheet API (GET /api/traffic-sheet), authenticated with
// a static X-API-KEY header. Unlike broadsign-sync/grassfish-sync/iot-sync this does NOT persist
// campaign data into a table - the Traffic Sheet page is a live report scoped to whatever
// startMonth/endMonth/network the user has picked, so each request is proxied straight through
// and the response is handed back to the browser as-is (with the campaign count folded in). The
// API key still never reaches the browser: it's read server-side from app_settings.trafficSheetApi
// (service role) and attached here, same "config lives in app_settings, secret never leaves the
// edge function" shape as every other integration in this codebase.
//
// Runs two ways, same pattern as brandfetch-lookup/iot-sync:
//   1. Traffic Sheet page - authenticated user JWT, browser supplies startMonth/endMonth/network.
//   2. Settings > Integrations > "Test" button - authenticated admin JWT, no body (defaults to
//      the API's own current-month default).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const TRAFFIC_SHEET_ENDPOINT = 'https://adlivecenter.adlive.io/api/traffic-sheet';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'trafficSheetApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error('Traffic Sheet integration is not fully configured (API Key, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    const params = new URLSearchParams();
    if (body.startMonth) params.set('startMonth', String(body.startMonth));
    if (body.endMonth) params.set('endMonth', String(body.endMonth));
    if (body.network) params.set('network', String(body.network));
    const url = params.toString() ? `${TRAFFIC_SHEET_ENDPOINT}?${params.toString()}` : TRAFFIC_SHEET_ENDPOINT;

    const res = await fetch(url, { headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' } });
    const nowIso = new Date().toISOString();
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const message = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`;
      await adminClient.from('app_settings').update({ value: { ...cfg, lastError: message } }).eq('key', 'trafficSheetApi');
      throw new Error(message);
    }
    const data = await res.json();
    const campaignCount = Array.isArray(data.campaigns) ? data.campaigns.length : 0;
    const summary = `Fetched ${campaignCount} campaign(s) for ${data.period?.startDate || '?'} to ${data.period?.endDate || '?'}.`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'trafficSheetApi');

    return new Response(JSON.stringify({ ...data, summary }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
