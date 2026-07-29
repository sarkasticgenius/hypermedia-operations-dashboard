// Creates a new app user (auth.users + profiles + user_permissions row).
// Client-side code only has the anon key, which cannot call auth.admin.createUser -
// that requires the service role key, which never leaves the server. This function holds
// that boundary: it runs with the service role, but only lets the request through if either
// (a) the caller is already an active admin, or (b) there are zero profiles rows yet, i.e.
// this is the very first account being bootstrapped for a fresh project.
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

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData } = await callerClient.auth.getUser();
    const caller = callerData?.user || null;

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { count } = await adminClient
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    const isBootstrap = (count || 0) === 0;

    if (!isBootstrap) {
      if (!caller) throw new Error('Not authenticated');
      const { data: callerProfile } = await adminClient
        .from('profiles')
        .select('role, active')
        .eq('id', caller.id)
        .single();
      if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.active) {
        throw new Error('Only an active admin can create users');
      }
    }

    const body = await req.json();
    const { email, password, username, name, title, role, permissions } = body || {};
    if (!email || !password || !username) {
      throw new Error('email, password and username are required');
    }

    const finalRole = isBootstrap ? 'admin' : (role === 'admin' ? 'admin' : 'team');

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, name: name || '', title: title || '', role: finalRole },
    });
    if (createErr) throw createErr;

    const newUserId = created.user.id;

    // The on_auth_user_created trigger already inserted a profiles row from user_metadata;
    // this update just makes sure it matches exactly what was requested.
    await adminClient
      .from('profiles')
      .update({ username, name: name || '', title: title || '', role: finalRole })
      .eq('id', newUserId);

    if (finalRole !== 'admin' && permissions && typeof permissions === 'object') {
      const rows = Object.keys(permissions).map((area) => ({
        user_id: newUserId,
        area,
        can_view: !!permissions[area]?.view,
        can_add: !!permissions[area]?.add,
        can_edit: !!permissions[area]?.edit,
        can_delete: !!permissions[area]?.delete,
        can_export: !!permissions[area]?.export,
      }));
      if (rows.length) {
        await adminClient.from('user_permissions').upsert(rows, { onConflict: 'user_id,area' });
      }
    }

    return new Response(JSON.stringify({ id: newUserId, bootstrap: isBootstrap }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
