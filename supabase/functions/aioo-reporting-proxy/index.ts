// Live proxy for the AiOO Reporting API (https://ads.aiootech.com/docs/api#tag/Reporting) -
// primarily GET /stats-ads (daily ad stats broken down by advertiser/campaign/ad/creative/site/
// placement), but generically supports every Reporting endpoint (stats-dsps, stats-placements,
// last-playouts, avails, placements-status-report) since they all share the same OAuth2 auth.
//
// IMPORTANT: the base URL is https://ads.aiootech.com/api/v1, NOT the bare domain - confirmed
// from the OpenAPI spec's `servers` block (the rendered docs UI's own URL bar doesn't show this,
// easy to miss). Every path below, /auth included, is relative to that - hitting the bare domain
// 404s on literally every call (including the token exchange itself), which is exactly what
// produced "Edge Function returned a non-2xx status code" for every request through this proxy.
//
// Auth is OAuth2 client_credentials, not a static API key like Traffic Sheet/Brandfetch/etc:
//   1. POST {API_BASE}/auth (form-urlencoded: grant_type=client_credentials, client_id,
//      client_secret) -> { access_token, token_type, expires_in, expires }.
//   2. Every actual API call sends that as `Authorization: Bearer <access_token>`.
// The token is cached in app_settings.reportingApi.cachedToken/cachedTokenExpiry (server-side
// only, never reaches the browser) and reused until it's within 60s of expiring, instead of
// re-authenticating on every single request - client_id/client_secret themselves stay in
// app_settings too, read fresh each call so a credential change takes effect immediately.
//
// Runs two ways, same pattern as traffic-sheet-proxy/brandfetch-lookup:
//   1. Reporting page - authenticated user JWT, browser always supplies an explicit
//      endpoint/start/end, so it gets the raw upstream response shape back untouched.
//   2. Settings > Integrations > "Test" button - authenticated admin JWT, no body at all. This used
//      to default to GET /me (cheap, no date range needed), but AiOO's /me handler 500s for
//      client_credentials tokens (confirmed live - the OAuth token exchange itself succeeds, only
//      the follow-up /me call fails, with an empty response body, which is consistent with an
//      unhandled server-side exception rather than an auth problem). /me appears to only work for
//      user-scoped tokens from the authorization_code flow, not service-account tokens. So the
//      no-endpoint fallback now hits GET /stats-ads for a single day instead - the endpoint this
//      integration actually exists for, and one we know works with a client_credentials token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const API_BASE = 'https://ads.aiootech.com/api/v1';

// /placements-status-report only offers text/csv (no JSON option per the spec) - parsed here so
// the frontend can treat every endpoint the same way (array of row objects). Simple RFC4180-style
// parser: handles quoted fields (with embedded commas/quotes/newlines) since the report is a
// live export and not guaranteed to be quote-free.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      // skip - \n (handled below) ends the row
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const filtered = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!filtered.length) return [];
  const header = filtered[0];
  return filtered.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

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

// Returns a valid Bearer token, reusing the cached one when it's not within 60s of expiring -
// re-authenticates and re-caches otherwise. Throws with the API's own error_description on a
// genuine credential failure (invalid client_id/client_secret) rather than swallowing it, since
// every caller needs to know configuration is broken, not just get an empty result.
async function getAccessToken(adminClient: any, cfg: any): Promise<string> {
  const now = Date.now();
  if (cfg.cachedToken && cfg.cachedTokenExpiry && now < cfg.cachedTokenExpiry - 60_000) {
    return cfg.cachedToken;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(cfg.clientId || ''),
    client_secret: String(cfg.clientSecret || ''),
  });
  const res = await fetch(`${API_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Authentication failed (HTTP ${res.status})`);
  }
  const cachedTokenExpiry = now + (Number(data.expires_in) || 3600) * 1000;
  await adminClient.from('app_settings').update({
    value: { ...cfg, cachedToken: data.access_token, cachedTokenExpiry },
  }).eq('key', 'reportingApi');
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'reportingApi').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.clientId || !cfg.clientSecret) {
      throw new Error('Reporting API is not fully configured (Client ID, Client Secret, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    const token = await getAccessToken(adminClient, cfg);

    // See file header - no explicit endpoint means this is the Settings "Test" button, which
    // falls back to a cheap single-day /stats-ads pull instead of the broken /me.
    const isTestCall = !(typeof body.endpoint === 'string' && body.endpoint);
    const endpoint = isTestCall ? '/stats-ads' : body.endpoint;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const params = new URLSearchParams();
    if (body.start) params.set('start', String(body.start));
    else if (isTestCall) params.set('start', yesterday);
    if (body.end) params.set('end', String(body.end));
    else if (isTestCall) params.set('end', yesterday);
    if (body.placement_ids) params.set('placement_ids', String(body.placement_ids));
    if (body.ad_id) params.set('ad_id', String(body.ad_id));
    if (body.site_id) params.set('site_id', String(body.site_id));
    if (body.since) params.set('since', String(body.since));
    if (body.retailers != null) params.set('retailers', String(body.retailers));
    // Only used by GET /campaigns (name filter, substring match) - looked up by the Reporting page
    // to show a selected campaign's real flight dates (Campaign start/end), since the Reporting
    // stats endpoints (stats-ads etc) only ever return daily rows, never campaign metadata.
    if (body.name) params.set('name', String(body.name));
    // Every stats endpoint defaults to CSV - this proxy always asks for JSON since the frontend
    // needs structured data, regardless of what (if anything) the browser itself passed.
    if (endpoint.startsWith('/stats-')) params.set('format', 'json');

    // /placements-status-report has no JSON option (text/csv only, per the spec) - fetched and
    // parsed into row objects here so every endpoint looks the same to the frontend.
    const isCsvEndpoint = endpoint === '/placements-status-report';
    const url = params.toString() ? `${API_BASE}${endpoint}?${params.toString()}` : `${API_BASE}${endpoint}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: isCsvEndpoint ? 'text/csv' : 'application/json' } });
    const nowIso = new Date().toISOString();
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const message = `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`;
      await adminClient.from('app_settings').update({ value: { ...cfg, lastError: message } }).eq('key', 'reportingApi');
      throw new Error(message);
    }
    const data = isCsvEndpoint ? parseCsv(await res.text()) : await res.json();
    const rowCount = Array.isArray(data) ? data.length : null;
    const summary = endpoint === '/me'
      ? `Connected as ${data.name || data.email || 'unknown user'} (${data.role || 'no role'}).`
      : rowCount != null ? `Connected - ${rowCount} row(s) from ${endpoint} for ${yesterday}.`
      : `Fetched ${endpoint}.`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastSync: nowIso, lastSyncSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'reportingApi');

    // The Reporting page always passes an explicit endpoint and expects the raw upstream shape
    // back untouched (extractRows handles array/rows/data wrappers itself) - summary is only
    // folded into the response for the Settings "Test" button's fallback call, where there's no
    // real caller depending on an exact shape and testIntegration's generic handler expects
    // data.summary. Never spread an array response into an object either way (stats-ads etc
    // return an array of rows; spreading would silently turn it into {0: ..., 1: ..., summary}
    // and break the frontend's Array.isArray(data) check).
    const responseBody = !isTestCall ? data
      : Array.isArray(data) ? { summary, rows: data }
      : { ...data, summary };
    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'reportingApi').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'reportingApi');
      }
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
