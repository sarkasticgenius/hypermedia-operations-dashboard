// Serves the current PowerShell "collector" script body to installed agents - this is what makes
// the agent "generic"/remotely updatable per the requirement: the DATA COLLECTION logic (which
// fields to gather, how) lives here, editable from Settings > Integrations > Digital Directory
// Agent > Data Collector Script, and takes effect on every PC's next check-in with no re-install
// anywhere. The outer shell itself (self-elevate, register the scheduled task, fetch this
// collector, execute it, POST the result) is served the same way, just from
// workspace-directory-agent-shell instead - see that function for why both halves needed to be
// centrally updatable, not just this one.
//
// TWO RESPONSE MODES, for the same metered-SIM reason as the agent-shell function:
//   - "?meta=1"  -> { version } only, a couple of dozen bytes. Asked on every check-in so the agent
//                   can tell whether the copy it already cached on disk is still current.
//   - no param   -> { script, version }, the full ~11KB body. Only fetched when the version differs
//                   from the agent's cached copy.
// Before the meta mode existed every agent re-downloaded this entire script on every 20-minute
// poll even though it changes maybe a few times a year - roughly 22MB per device per month of
// pure waste on a metered plan.
//
// Same shared-secret auth as workspace-directory-checkin (x-agent-secret), not a user session.
// GET only, no request body.
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

    const { data: collectorRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryCollector').single();
    const script = collectorRow?.value?.script || '';
    const version = collectorRow?.value?.version || 0;

    const metaOnly = new URL(req.url).searchParams.get('meta') === '1';
    const body = metaOnly ? { version } : { script, version };

    return new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
