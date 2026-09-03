// Records one row in login_history for a Login or Logout event - IP address, a rough location, and
// the browser/OS derived from the User-Agent, none of which the client is trusted to self-report.
// Identity is resolved from the caller's own JWT (same pattern as admin-impersonate), not from
// anything in the request body, so one user can never write a login_history row under another
// user's name. There is deliberately no "PC name" field anywhere in this - no browser API exposes
// a visitor's local machine name to a website, unlike the native WorkspaceDirectory agent which has
// real OS access; IP + geolocation + browser/OS is the closest real substitute.
//
// Called twice per session, both times from src/auth.js: right after login() adopts its new
// session (event: "login"), and right before logout() calls supabase.auth.signOut() (event:
// "logout" - has to happen BEFORE signOut, while the JWT this function authenticates with is still
// valid).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Deno Deploy (what Supabase Edge Functions run on) sets this to "client, proxy1, proxy2, ..." -
// the FIRST entry is the actual visitor, everything after is infrastructure in between. Falls back
// to x-real-ip for any front-end that sets that instead.
function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

// ipwho.is - free, HTTPS, no key. ipapi.co was tried first and rejected: confirmed live (both from
// this project's own Edge Function AND independently by curl) that it returns HTTP 429 "RateLimited"
// on essentially the first request, which going by ipapi.co's own docs means Supabase's shared
// outbound IP for this region is already past its free-tier quota from OTHER Supabase projects'
// traffic - not something raising a plan or waiting fixes, since it's not this app's own volume
// causing it. Best-effort either way: a failed/rate-limited lookup just leaves location null, never
// blocks the login event itself from being recorded.
async function lookupLocation(ip: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const geo = await resp.json();
    if (!geo.success) return null;
    return [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { event } = await req.json();
    if (event !== 'login' && event !== 'logout') throw new Error('event must be "login" or "logout"');

    const authHeader = req.headers.get('Authorization') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) throw new Error('Not authenticated');

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile } = await adminClient.from('profiles').select('username, name').eq('id', caller.id).maybeSingle();

    const ip = clientIp(req);
    const [location] = await Promise.all([ip ? lookupLocation(ip) : Promise.resolve(null)]);

    await adminClient.from('login_history').insert({
      user_id: caller.id,
      username: profile?.username || null,
      name: profile?.name || null,
      event,
      ip_address: ip,
      location,
      user_agent: req.headers.get('user-agent') || null,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    // Never lets a login/logout itself fail because of this - the caller (src/auth.js) only
    // best-effort invokes this function and doesn't await its result on the critical path, but a
    // clean error response here still matters for anyone watching function logs while debugging it.
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
