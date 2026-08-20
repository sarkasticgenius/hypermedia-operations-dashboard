// Answers one question, as cheaply as possible: "has the dashboard asked this PC to check in right
// now?" Polled by Jstar (not the headless 6-hourly scheduled task - that would defeat the point of
// an on-demand check) every couple of minutes so a "Force Inventory Pull" click on the dashboard
// gets picked up in near-real-time, without the PCs needing any inbound reachability - these are
// metered-SIM PCs behind NAT/cellular routers with no public IP, so the dashboard can never reach
// OUT to them; this is the polling side of that constraint, kept tiny (a few dozen bytes) since it
// runs far more often than the real check-in does. The flag itself is cleared by
// workspace-directory-checkin once a real check-in actually lands, not here - this endpoint never
// writes anything.
//
// Same shared-secret auth as workspace-directory-checkin (x-agent-secret), not a user session.
// GET only, ?hostname=<name> query param - returns { force: boolean }.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: agentRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgent').single();
    const expectedSecret = agentRow?.value?.secret;
    const providedSecret = req.headers.get('x-agent-secret');
    if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
      throw new Error('Not authenticated - missing or incorrect x-agent-secret header.');
    }

    const hostname = new URL(req.url).searchParams.get('hostname');
    if (!hostname) throw new Error('hostname query param is required.');

    const { data: deviceRow } = await adminClient.from('workspace_devices').select('force_checkin_requested').eq('hostname', hostname).maybeSingle();

    return new Response(JSON.stringify({ force: !!deviceRow?.force_checkin_requested }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
