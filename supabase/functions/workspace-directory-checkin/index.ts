// Receives one check-in per PC from scripts/workspace-directory-agent.ps1, running unattended via
// a scheduled task on each machine - see that script for what it collects and how often it posts.
// Authenticated by a shared secret (x-agent-secret header, compared against
// app_settings.workspaceDirectoryAgent.secret), not a Supabase user session, since the agent has
// no user to sign in as. This is the same shape as broadsign-sync/grassfish-sync/iot-sync, just
// inverted: those pull from a vendor API on our schedule, this accepts a push on the agent's.
//
// Upserts by hostname (unique) - only touches the telemetry columns (ip_address, anydesk_id,
// os_name, os_version, logged_in_user, software, agent_version, last_seen). `location` and
// `notes` are admin-curated from the dashboard and never written here, so a new check-in never
// clobbers an admin's tree-grouping tag.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (req.method !== 'POST') throw new Error('Method not allowed');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgent').single();
    const expectedSecret = settingsRow?.value?.secret;
    const providedSecret = req.headers.get('x-agent-secret');
    if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
      throw new Error('Not authenticated - missing or incorrect x-agent-secret header.');
    }

    const body = await req.json();
    const hostname = String(body.hostname || '').trim();
    if (!hostname) throw new Error('hostname is required.');

    // Software list is capped defensively - a machine with an unusually bloated Add/Remove
    // Programs list (thousands of entries from some install tooling) shouldn't be able to bloat a
    // single jsonb row without bound.
    const software = Array.isArray(body.software)
      ? body.software.slice(0, 2000).map((s: any) => ({ name: String(s?.name || '').slice(0, 300), version: String(s?.version || '').slice(0, 100) })).filter((s: any) => s.name)
      : [];

    const row = {
      hostname,
      ip_address: body.ip ? String(body.ip).slice(0, 100) : null,
      anydesk_id: body.anydeskId ? String(body.anydeskId).slice(0, 50) : null,
      os_name: body.os ? String(body.os).slice(0, 200) : null,
      os_version: body.osVersion ? String(body.osVersion).slice(0, 100) : null,
      logged_in_user: body.loggedInUser ? String(body.loggedInUser).slice(0, 200) : null,
      software,
      agent_version: body.agentVersion ? String(body.agentVersion).slice(0, 50) : null,
      last_seen: new Date().toISOString(),
    };

    const { error } = await adminClient.from('workspace_devices').upsert(row, { onConflict: 'hostname' });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
