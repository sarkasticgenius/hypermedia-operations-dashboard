// Lets an active admin remove another user's two-factor factor(s) - the "lost my phone" recovery
// path for the opt-in MFA feature (see src/pages/account.js). Mirrors admin-impersonate's own
// caller-is-an-active-admin check exactly, since the two are the same trust boundary: only an
// admin who is already fully signed in themselves may act on someone else's account.
//
// Deletes every TOTP factor on the target account rather than requiring the caller to know a
// specific factor id - a user only ever has at most one verified TOTP factor in this app's own
// enrollment flow (challengeAndVerify immediately follows enroll, so an unverified stray factor
// left over from an abandoned attempt is the only other case, and clearing that too is exactly
// what "reset" should mean here).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) throw new Error('Not authenticated');

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: callerProfile } = await adminClient.from('profiles').select('role, active').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.active) {
      throw new Error('Only an active admin can reset another user\'s two-factor authentication');
    }

    const body = await req.json();
    const targetUserId = body?.targetUserId;
    if (!targetUserId) throw new Error('targetUserId is required');

    const { data: targetProfile } = await adminClient.from('profiles').select('id, username, name').eq('id', targetUserId).single();
    if (!targetProfile) throw new Error('User not found');

    const { data: factorsData, error: factorsErr } = await adminClient.auth.admin.mfa.listFactors({ userId: targetUserId });
    if (factorsErr) throw factorsErr;
    const factors = factorsData?.factors || [];
    if (!factors.length) {
      return new Response(JSON.stringify({ ok: true, removed: 0, targetName: targetProfile.name || targetProfile.username }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

    for (const factor of factors) {
      const { error: delErr } = await adminClient.auth.admin.mfa.deleteFactor({ id: factor.id, userId: targetUserId });
      if (delErr) throw delErr;
    }

    return new Response(JSON.stringify({ ok: true, removed: factors.length, targetName: targetProfile.name || targetProfile.username }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
