// Serves the current PowerShell "collector" script body to every installed agent, each check-in
// run - this is what makes the agent "generic"/remotely updatable per the requirement: the script
// actually installed on each PC (scripts/workspace-directory-agent.ps1) is a small, fixed outer
// shell (self-elevate, register the scheduled task, fetch this collector, execute it, POST the
// result) that never needs to change. The DATA COLLECTION logic - which fields to gather, how -
// lives here instead, editable from Settings > Integrations > Digital Directory Agent, and takes
// effect on every PC's next 6-hour check-in with no re-install anywhere.
//
// Same shared-secret auth as workspace-directory-checkin (x-agent-secret), not a user session.
// GET only, no request body - just returns { script, version }.
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

    return new Response(JSON.stringify({ script, version }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
