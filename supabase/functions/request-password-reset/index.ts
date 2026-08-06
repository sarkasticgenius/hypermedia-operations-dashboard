// Self-service "forgot password" - resolves a username or email to the real account (mirroring
// resolve-login's own username->email lookup), then uses Supabase Auth's own
// admin.generateLink({type:'recovery'}) to get a genuine, secure, time-limited recovery link
// (never a custom-rolled token) and emails it via sendgrid-send. Always returns the exact same
// generic response regardless of whether a match was found - mirroring resolve-login's
// anti-enumeration convention: someone probing for valid usernames/emails can't tell a real
// account from a made-up one by the response alone.
//
// No isAuthorized() gate, deliberately - this has to be callable by someone who is NOT logged in
// (that's the entire point), same as resolve-login. The Supabase client always attaches at least
// the anon key as a bearer token, which satisfies the platform's own verify_jwt gate.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GENERIC_RESPONSE = { summary: "If that account exists, we've sent a password reset link to its email address." };

function genericResponse() {
  return new Response(JSON.stringify(GENERIC_RESPONSE), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const identifier = String(body.identifier || '').trim();
    const origin = String(body.origin || '').trim();
    if (!identifier) return genericResponse();

    let email = identifier;
    if (!identifier.includes('@')) {
      const { data: profile } = await adminClient.from('profiles').select('id').ilike('username', identifier).maybeSingle();
      if (!profile) return genericResponse();
      const { data: authUser } = await adminClient.auth.admin.getUserById(profile.id);
      email = authUser?.user?.email || '';
    }
    if (!email) return genericResponse();

    const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: origin ? { redirectTo: origin } : undefined,
    });
    // generateLink failing (e.g. no user with that email) is an expected outcome here, not an
    // exceptional one - still returns the same generic response, never a different error shape.
    if (linkErr || !linkData?.properties?.action_link) return genericResponse();

    const { data: secretRow } = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
    const secret = secretRow?.value?.secret;
    if (secret) {
      const text = `We received a request to reset your Hypermedia Operations Dashboard password.\n\nClick here to set a new one: ${linkData.properties.action_link}\n\nIf you didn't request this, you can ignore this email - your password won't change.`;
      await fetch(`${supabaseUrl}/functions/v1/sendgrid-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
        body: JSON.stringify({ to: email, subject: 'Reset your password', text }),
      }).catch(() => {});
    }

    return genericResponse();
  } catch (_err) {
    // Even an unexpected internal error must not leak anything - same generic response either way.
    return genericResponse();
  }
});
