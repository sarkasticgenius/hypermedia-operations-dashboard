// Live proxy for two AdLive Center endpoints, both authenticated with the same static X-API-KEY
// (same account, same key - confirmed live against the creatives endpoint with the existing
// trafficSheetApi.apiKey before adding this, nothing new to configure). Neither persists data into
// a table - both are live reports scoped to whatever the caller asked for, proxied straight through
// and handed back to the browser as-is. The API key never reaches the browser either way: read
// server-side from app_settings.trafficSheetApi (service role) and attached here, same "config
// lives in app_settings, secret never leaves the edge function" shape as every other integration.
//
// Runs two ways, same pattern as brandfetch-lookup/iot-sync:
//   1. Traffic Sheet page - authenticated user JWT, browser supplies startMonth/endMonth/network
//      (campaign list) or contract (creatives for one campaign - see CREATIVES_ENDPOINT below).
//   2. Settings > Integrations > "Test" button - authenticated admin JWT, no body (defaults to
//      the campaign list API's own current-month default). Never exercises the creatives path.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const TRAFFIC_SHEET_ENDPOINT = 'https://adlivecenter.adlive.io/api/traffic-sheet';
// GET /api/campaigns/{contract}/creatives - one campaign's creative assets (approval status, date
// range, matched venues, and the actual file list with dimensions/duration/CDN url per file).
// {contract} is the exact same vendor contract ID already used throughout this page (campaign.contract
// - see toggleFocMarketingOverride and friends), just against a different AdLive endpoint than the
// bulk campaign list.
const CREATIVES_ENDPOINT = 'https://adlivecenter.adlive.io/api/campaigns';

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

    // Creatives mode - a completely separate endpoint/shape, so kept as its own branch rather than
    // threaded through the campaign-list querystring building below. Deliberately does NOT touch
    // trafficSheetApi.lastSync/lastSyncSummary/lastError: those reflect the OVERALL integration's
    // health for the Settings card and the "Test" button, and a per-campaign creatives lookup
    // failing (a typo'd contract, one campaign with nothing uploaded yet) is not that - it would
    // stomp a perfectly good "Fetched N campaigns..." summary with an unrelated one-off result, or
    // flag the whole integration as broken over a single bad contract ID.
    if (body.contract) {
      const url = `${CREATIVES_ENDPOINT}/${encodeURIComponent(String(body.contract))}/creatives`;
      const res = await fetch(url, { headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' } });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
      }
      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

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
