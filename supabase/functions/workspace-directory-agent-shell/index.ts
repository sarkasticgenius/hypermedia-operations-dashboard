// Serves the current outer-shell script body (self-elevate, scheduled-task registration, remote-
// command runner, tray icon install, self-update check itself) to every installed agent, each
// check-in run. Until this existed, that shell was the one part of the Digital Directory Agent that
// required physically re-running the installer on every PC to change - the Data Collector Script
// (workspace-directory-collector) already worked this way for what gets collected, but not for the
// shell logic around it. Several of these PCs are in remote locations with no one available to
// manually re-install, so the shell's own Invoke-SelfUpdate function fetches from here on every run
// and overwrites+re-execs itself if different - see buildWorkspaceDirectoryAgentScript in
// src/pages/settings.js for that logic and for how "Publish Latest Agent Version" writes here.
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

    const { data: shellRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgentShell').single();
    const script = shellRow?.value?.script || '';
    const version = shellRow?.value?.version || 0;

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
