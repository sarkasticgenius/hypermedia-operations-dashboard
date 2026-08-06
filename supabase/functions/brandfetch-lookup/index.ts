// Looks up a brand's DOMAIN via Brandfetch's Search API (GET /v2/search/{name}?c={apiKey}) and
// caches a logo URL in brand_logos, keyed by the exact name we searched for (venue/contractor/
// client name). Runs server-side (service role) so the Brandfetch key never reaches the browser.
//
// IMPORTANT: the persisted logo_url is built from Google's favicon service
// (google.com/s2/favicons?domain={domain}), NOT from Brandfetch's own image hosting - discovered
// the hard way that neither of Brandfetch's own URL types are safe to cache long-term:
//   - Search's `icon` field is a signed, expiring URL (confirmed via real cached rows going
//     HTTP 410 Gone after about a week - fine for showing immediately, useless for storage).
//   - The Logo Link CDN (cdn.brandfetch.io/{domain}?c={clientId}, used below for domainOverrides)
//     started returning HTTP 403 for every URL account-wide, including ones confirmed working
//     days earlier - looks like an account-side issue with this Client ID specifically, not
//     anything wrong with any individual domain.
// Brandfetch is still genuinely useful here for resolving a fuzzy name ("Sobha") to the right
// domain (sobha.com) - it's just not used to host the final image. domainOverrides skips Search
// for names it can't resolve reliably (generic-sounding names, or known account-side failures).
//
// app_settings.brandfetch.domainOverrides is an optional {name: domain} map (set from Settings)
// for names the Search API can't reliably resolve to the right brand (e.g. "AL HAMRA MALL" - a
// generic-sounding name that search alone won't confidently match to alhamra.ae).
//
// Runs two ways, same pattern as broadsign-sync/grassfish-sync/iot-sync:
//   1. Settings > Integrations > "Fetch Missing Logos" - authenticated admin JWT, browser supplies
//      the exact names to look up (gathered client-side from Locations/Contractors/Campaigns/
//      Traffic Sheet venues).
//   2. A weekly pg_cron job (see migration) - sends a shared secret in x-cron-secret instead of a
//      user session (pg_cron can't hold one) and no request body, so this gathers the same
//      candidate names itself server-side rather than relying on a browser to supply them.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const BATCH_CAP = 25;

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
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

// Mirrors src/data/locationStats.js's brandNameForLocation() - Metro Rail station/bridge
// locations are individually meaningless as brand names ("Metro Station - Energy" matches
// nothing), so they all route to one shared lookup for the real-world brand instead.
const METRO_RAIL_CHAINS = new Set(['Red Line', 'Green Line', 'Metro Bridges', 'Expo Line']);
function brandNameForLocation(loc: { name: string; chain: string | null }): string {
  if (loc.chain && METRO_RAIL_CHAINS.has(loc.chain)) return 'Dubai Metro Rail';
  return loc.name;
}

// Same "gather candidate names" logic the frontend's runBrandfetchFetchMissing() uses, needed
// here too since a cron-triggered run has no browser to supply names.
async function gatherMissingNames(adminClient: any): Promise<string[]> {
  const [{ data: locations }, { data: contractors }, { data: campaigns }, { data: cached }] = await Promise.all([
    adminClient.from('locations').select('name, chain').is('deleted_at', null),
    adminClient.from('contractors').select('company, name').is('deleted_at', null),
    adminClient.from('campaigns').select('client').is('deleted_at', null),
    adminClient.from('brand_logos').select('name'),
  ]);
  const cachedNames = new Set((cached || []).map((r: any) => String(r.name).toLowerCase()));
  const candidates = new Set<string>();
  (locations || []).forEach((l: any) => { const n = brandNameForLocation(l); if (n) candidates.add(String(n).trim()); });
  (contractors || []).forEach((c: any) => (c.company || c.name) && candidates.add(String(c.company || c.name).trim()));
  (campaigns || []).forEach((c: any) => c.client && candidates.add(String(c.client).trim()));
  return [...candidates].filter((n) => n && !cachedNames.has(n.toLowerCase()));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'brandfetch').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error('Brandfetch integration is not fully configured (API Key, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    let names = Array.isArray(body.names)
      ? [...new Set(body.names.map((n: unknown) => String(n || '').trim()).filter(Boolean))]
      : [];
    if (!names.length) names = (await gatherMissingNames(adminClient)).slice(0, BATCH_CAP);
    if (!names.length) {
      const summary = 'No new brand names to look up - everything already cached.';
      await adminClient.from('app_settings').update({ value: { ...cfg, lastRun: new Date().toISOString(), lastSummary: summary, lastError: '' } }).eq('key', 'brandfetch');
      return new Response(JSON.stringify({ summary, results: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const domainOverrides: Record<string, string> = cfg.domainOverrides || {};
    const results: { name: string; logo_url: string | null; domain?: string | null; error?: string }[] = [];
    const nowIso = new Date().toISOString();

    for (const name of names) {
      try {
        const overrideDomain = domainOverrides[name];
        if (overrideDomain) {
          const logo_url = faviconUrl(overrideDomain);
          await adminClient.from('brand_logos').upsert({
            name, domain: overrideDomain, logo_url, fetched_at: nowIso, error: null,
          }, { onConflict: 'name' });
          results.push({ name, logo_url, domain: overrideDomain });
          continue;
        }

        const res = await fetch(`https://api.brandfetch.io/v2/search/${encodeURIComponent(name)}?c=${encodeURIComponent(cfg.apiKey)}`, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arr = await res.json();
        // Search only resolves the domain here - the logo itself always comes from the favicon
        // service (see file header), never from Search's own `icon` field, which expires.
        const best = Array.isArray(arr) ? arr.find((b: any) => b?.domain) : null;
        if (best?.domain) {
          const logo_url = faviconUrl(best.domain);
          await adminClient.from('brand_logos').upsert({
            name, domain: best.domain, logo_url, fetched_at: nowIso, error: null,
          }, { onConflict: 'name' });
          results.push({ name, logo_url, domain: best.domain });
        } else {
          await adminClient.from('brand_logos').upsert({
            name, domain: null, logo_url: null, fetched_at: nowIso, error: 'No match found',
          }, { onConflict: 'name' });
          results.push({ name, logo_url: null, error: 'No match found' });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await adminClient.from('brand_logos').upsert({
          name, domain: null, logo_url: null, fetched_at: nowIso, error: message,
        }, { onConflict: 'name' });
        results.push({ name, logo_url: null, error: message });
      }
    }

    const matched = results.filter((r) => r.logo_url).length;
    const summary = `Looked up ${names.length} brand name(s): ${matched} logo(s) found, ${names.length - matched} not found.`;

    await adminClient.from('app_settings').update({
      value: { ...cfg, lastRun: nowIso, lastSummary: summary, lastError: '' },
      updated_at: nowIso,
    }).eq('key', 'brandfetch');

    return new Response(JSON.stringify({ summary, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      const adminClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: row } = await adminClient.from('app_settings').select('value').eq('key', 'brandfetch').single();
      if (row) {
        await adminClient.from('app_settings').update({ value: { ...row.value, lastError: message } }).eq('key', 'brandfetch');
      }
    } catch (_) { /* best-effort error record */ }
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
