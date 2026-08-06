// Looks up a brand's DOMAIN via Brandfetch's Search API (GET /v2/search/{name}?c={apiKey}) and
// caches a logo URL in brand_logos, keyed by the exact name we searched for (venue/contractor/
// client name). Runs server-side (service role) so the Brandfetch key never reaches the browser.
//
// IMPORTANT: the persisted logo_url points at OUR OWN "brand-logos" Storage bucket, not at any
// external host - discovered the hard way that no external image URL is safe to cache long-term:
//   - Brandfetch Search's `icon` field is a signed, expiring URL (confirmed via real cached rows
//     going HTTP 410 Gone after about a week).
//   - Brandfetch's Logo Link CDN (cdn.brandfetch.io/{domain}?c={clientId}) started returning HTTP
//     403 for every URL account-wide, including ones confirmed working days earlier.
//   - Even Google's favicon service (google.com/s2/favicons?domain=...), the fix for the above
//     two, meant every single page render re-fetched the image live from Google rather than truly
//     caching it, and put every logo's uptime at the mercy of a service we don't control.
// storeLogoImage() below fetches the image bytes ONCE (still via Google's favicon service, which
// already handles the messy real-world resolution - missing root favicon.ico, redirects, apple-
// touch-icon fallbacks) and re-uploads them into our own Storage bucket, keyed by domain so
// multiple names sharing a domain (chain branches) reuse one image. Falls back to the live Google
// URL if the fetch/upload ever fails, so a hiccup here never leaves a name with no logo at all.
// Brandfetch itself is still only ever used to resolve a fuzzy name ("Sobha") to the right domain
// (sobha.com) - never to host the final image. domainOverrides skips Search entirely for names it
// can't resolve reliably (generic-sounding names, or known account-side failures).
//
// app_settings.brandfetch.domainOverrides is an optional {name: domain} map (set from Settings)
// for names the Search API can't reliably resolve to the right brand (e.g. "AL HAMRA MALL" - a
// generic-sounding name that search alone won't confidently match to alhamra.ae).
//
// Runs three ways, same pattern as broadsign-sync/grassfish-sync/iot-sync:
//   1. Settings > Integrations > "Fetch Missing Logos" - authenticated admin JWT, browser supplies
//      the exact names to look up (gathered client-side from Locations/Contractors/Campaigns/
//      Traffic Sheet venues).
//   2. A weekly pg_cron job (see migration) - sends a shared secret in x-cron-secret instead of a
//      user session (pg_cron can't hold one) and no request body, so this gathers the same
//      candidate names itself server-side rather than relying on a browser to supply them.
//   3. { backfillStorage: true } - a one-off (or safely re-runnable) migration that re-hosts every
//      already-resolved logo into Storage without touching Brandfetch at all (see above).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const BATCH_CAP = 25;
const LOGO_BUCKET = 'brand-logos';

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
}

// Fetches the actual favicon image bytes - still resolved via Google's favicon service, which
// already handles the messy real-world cases (missing root favicon.ico, redirects, apple-touch-
// icon fallbacks) far better than guessing a path ourselves - and re-hosts them in our own Storage
// bucket, so every subsequent page load serves the logo from our own infra instead of hitting
// Google's service again on every single render. Keyed by DOMAIN (not by name) so e.g. "LULU AL
// KHALIFA" and "LULU AL BARSHA" both resolving to lulu.com share one uploaded image, and re-runs
// are safe (upsert just overwrites with the same fresh bytes). Falls back to returning the live
// Google URL directly (today's original behavior) if anything about the fetch/upload fails, so a
// hiccup here never leaves a name with no logo at all.
async function storeLogoImage(adminClient: any, domain: string): Promise<string> {
  const liveUrl = faviconUrl(domain);
  try {
    const res = await fetch(liveUrl);
    // Google's favicon service redirects to a gstatic endpoint that, for a domain it has no
    // specific favicon for, responds with HTTP 404 but STILL returns a real image body (a generic
    // globe placeholder) rather than an empty/error response - confirmed via direct curl. Checking
    // res.ok would skip every one of those (they render fine live today, just via the generic
    // icon), so this checks the content-type is actually an image instead of the status code -
    // that's what tells a genuine failure (an HTML error page, a timeout) from Google's own
    // not-quite-a-404 convention.
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return liveUrl;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return liveUrl;
    const path = `${domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.png`;
    const { error } = await adminClient.storage.from(LOGO_BUCKET).upload(path, bytes, { contentType, upsert: true });
    if (error) return liveUrl;
    const { data } = adminClient.storage.from(LOGO_BUCKET).getPublicUrl(path);
    return data?.publicUrl || liveUrl;
  } catch (_) {
    return liveUrl;
  }
}

function isStorageUrl(url: string | null): boolean {
  return !!url && url.includes(`/storage/v1/object/public/${LOGO_BUCKET}/`);
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
// here too since a cron-triggered run has no browser to supply names. Also mirrors that function's
// Domain Overrides handling: every override name is a candidate regardless of whether it also
// happens to come from a location/contractor/campaign, and a name with an override is only
// skipped once its cached row's domain already matches - so a newly-added or changed override
// still gets (re-)applied even though that name already has a (now-stale) cached row.
async function gatherMissingNames(adminClient: any, domainOverrides: Record<string, string>): Promise<string[]> {
  const [{ data: locations }, { data: contractors }, { data: campaigns }, { data: cached }] = await Promise.all([
    adminClient.from('locations').select('name, chain').is('deleted_at', null),
    adminClient.from('contractors').select('company, name').is('deleted_at', null),
    adminClient.from('campaigns').select('client').is('deleted_at', null),
    adminClient.from('brand_logos').select('name, domain'),
  ]);
  const cachedByName = new Map((cached || []).map((r: any) => [String(r.name).toLowerCase(), r]));
  const overridesByLowerName = new Map(Object.entries(domainOverrides || {}).map(([n, d]) => [n.trim().toLowerCase(), d]));
  const candidates = new Set<string>();
  Object.keys(domainOverrides || {}).forEach((n) => { const t = n.trim(); if (t) candidates.add(t); });
  (locations || []).forEach((l: any) => { const n = brandNameForLocation(l); if (n) candidates.add(String(n).trim()); });
  (contractors || []).forEach((c: any) => (c.company || c.name) && candidates.add(String(c.company || c.name).trim()));
  (campaigns || []).forEach((c: any) => c.client && candidates.add(String(c.client).trim()));
  return [...candidates].filter((n) => {
    if (!n) return false;
    const cachedRow = cachedByName.get(n.toLowerCase());
    const overrideDomain = overridesByLowerName.get(n.toLowerCase());
    if (!cachedRow) return true;
    if (overrideDomain) return String(cachedRow.domain || '').toLowerCase() !== overrideDomain.trim().toLowerCase();
    return false;
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const body = await req.json().catch(() => ({}));

    // One-time (or re-runnable) migration: re-host every already-resolved logo's image bytes into
    // Storage, without touching Brandfetch's Search API or its quota at all - the domain is already
    // known from a past successful lookup, so this only needs Google's favicon service (free,
    // unauthenticated, no cap) plus our own Storage. Doesn't require the integration to even be
    // enabled/configured, since it never calls Brandfetch itself.
    if (body.backfillStorage === true) {
      const { data: rows } = await adminClient.from('brand_logos').select('name, domain, logo_url').not('domain', 'is', null);
      const toBackfill = (rows || []).filter((r: any) => !isStorageUrl(r.logo_url));
      let migrated = 0;
      for (const row of toBackfill) {
        const logo_url = await storeLogoImage(adminClient, row.domain);
        if (isStorageUrl(logo_url)) {
          await adminClient.from('brand_logos').update({ logo_url }).eq('name', row.name);
          migrated++;
        }
      }
      const summary = `Backfilled ${migrated} of ${toBackfill.length} existing logo(s) into Storage.`;
      return new Response(JSON.stringify({ summary }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'brandfetch').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error('Brandfetch integration is not fully configured (API Key, Enabled).');
    }

    let names = Array.isArray(body.names)
      ? [...new Set(body.names.map((n: unknown) => String(n || '').trim()).filter(Boolean))]
      : [];
    if (!names.length) names = (await gatherMissingNames(adminClient, cfg.domainOverrides || {})).slice(0, BATCH_CAP);
    if (!names.length) {
      const summary = 'No new brand names to look up - everything already cached.';
      await adminClient.from('app_settings').update({ value: { ...cfg, lastRun: new Date().toISOString(), lastSummary: summary, lastError: '' } }).eq('key', 'brandfetch');
      return new Response(JSON.stringify({ summary, results: [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
    }

    const domainOverrides: Record<string, string> = cfg.domainOverrides || {};
    // Lowercased so an override typed as "Danube" still applies to a candidate name gathered as
    // "danube"/"DANUBE" - the raw Record lookup below was case-sensitive, which silently dropped
    // an override the moment its casing didn't exactly match whatever the app derived elsewhere.
    const overridesByLowerName = new Map(Object.entries(domainOverrides).map(([n, d]) => [n.trim().toLowerCase(), d]));
    const results: { name: string; logo_url: string | null; domain?: string | null; error?: string }[] = [];
    const nowIso = new Date().toISOString();

    for (const name of names) {
      try {
        const overrideDomain = overridesByLowerName.get(name.trim().toLowerCase());
        if (overrideDomain) {
          const logo_url = await storeLogoImage(adminClient, overrideDomain);
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
          const logo_url = await storeLogoImage(adminClient, best.domain);
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
