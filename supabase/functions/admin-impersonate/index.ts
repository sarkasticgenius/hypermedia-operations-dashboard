// Lets an active admin impersonate another active user, without ever handling that user's
// password. The client never gets a real session directly from this function - it gets a
// single-use magic-link token hash (via auth.admin.generateLink, service-role only) which the
// client then exchanges itself with supabase.auth.verifyOtp(). The client is responsible for
// saving its own admin session (access/refresh tokens) before swapping, so "Return to Admin" can
// restore it later - this function only ever hands back a short-lived token, never a session.
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
      throw new Error('Only an active admin can impersonate another user');
    }

    const body = await req.json();
    const targetUserId = body?.targetUserId;
    if (!targetUserId) throw new Error('targetUserId is required');
    if (targetUserId === caller.id) throw new Error('You are already signed in as yourself');

    const { data: targetProfile } = await adminClient.from('profiles').select('id, username, name, active').eq('id', targetUserId).single();
    if (!targetProfile) throw new Error('User not found');
    if (!targetProfile.active) throw new Error('Cannot impersonate a deactivated user');

    const { data: targetAuthUser, error: getUserErr } = await adminClient.auth.admin.getUserById(targetUserId);
    if (getUserErr || !targetAuthUser?.user?.email) throw new Error("Could not resolve that user's login email");

    const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
      type: 'magiclink', email: targetAuthUser.user.email,
    });
    if (linkErr) throw linkErr;

    const tokenHash = linkData?.properties?.hashed_token;
    if (!tokenHash) throw new Error('Could not generate an impersonation token');

    return new Response(JSON.stringify({ tokenHash, targetName: targetProfile.name || targetProfile.username }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
