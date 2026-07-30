// Looks up brand logos via Brandfetch's Search API (GET /v2/search/{name}?c={apiKey}) and caches
// results in brand_logos, keyed by the exact name we searched for (venue/contractor/client name).
// Runs server-side (service role) so the Brandfetch key never reaches the browser. Uses the
// Search endpoint rather than the Brand API because it returns a usable icon URL directly per
// result with a single query-param key - no separate Bearer-token Brand API call needed, which
// matters given Brandfetch's free tier is only 100 requests/month.
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

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'brandfetch').single();
    const cfg = settingsRow?.value || {};
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error('Brandfetch integration is not fully configured (API Key, Enabled).');
    }

    const body = await req.json().catch(() => ({}));
    const names = Array.isArray(body.names)
      ? [...new Set(body.names.map((n: unknown) => String(n || '').trim()).filter(Boolean))]
      : [];
    if (!names.length) throw new Error('No brand names supplied.');

    const results: { name: string; logo_url: string | null; domain?: string | null; error?: string }[] = [];
    const nowIso = new Date().toISOString();

    for (const name of names) {
      try {
        const res = await fetch(`https://api.brandfetch.io/v2/search/${encodeURIComponent(name)}?c=${encodeURIComponent(cfg.apiKey)}`, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arr = await res.json();
        const best = Array.isArray(arr) ? arr.find((b: any) => b?.icon) : null;
        if (best?.icon) {
          await adminClient.from('brand_logos').upsert({
            name, domain: best.domain || null, logo_url: best.icon, fetched_at: nowIso, error: null,
          }, { onConflict: 'name' });
          results.push({ name, logo_url: best.icon, domain: best.domain || null });
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
