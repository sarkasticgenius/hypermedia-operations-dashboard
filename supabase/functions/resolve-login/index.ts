// Lets the login screen accept either a username or an email address. Supabase Auth's
// signInWithPassword() only ever takes an email, and profiles.username lookup can't happen
// client-side (RLS on profiles requires an existing session, by design, to stop username
// enumeration by anyone with just the anon key) - so this resolves username -> email server-side
// with the service role, then performs the real sign-in itself and hands the resulting session
// back to the browser to adopt via supabase.auth.setSession().
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Same message regardless of whether the identifier didn't match anyone or the password was
// wrong - matches Supabase Auth's own signInWithPassword() wording, and avoids letting a login
// attempt reveal whether a given username/email exists.
const INVALID_CREDENTIALS = 'Invalid login credentials';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { identifier, password } = await req.json();
    if (!identifier || !password) throw new Error(INVALID_CREDENTIALS);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    let email = String(identifier).trim();
    if (!email.includes('@')) {
      const { data: profile } = await adminClient.from('profiles').select('id').ilike('username', email).maybeSingle();
      if (!profile) throw new Error(INVALID_CREDENTIALS);
      const { data: userRes, error: userErr } = await adminClient.auth.admin.getUserById(profile.id);
      if (userErr || !userRes?.user?.email) throw new Error(INVALID_CREDENTIALS);
      email = userRes.user.email;
    }

    const anonClient = createClient(supabaseUrl, anonKey);
    const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
    if (error || !data?.session) throw new Error(INVALID_CREDENTIALS);

    return new Response(JSON.stringify({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
