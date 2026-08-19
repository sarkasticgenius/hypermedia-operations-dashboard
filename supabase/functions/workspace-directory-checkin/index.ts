// Receives one check-in per PC from scripts/workspace-directory-agent.ps1, running unattended via
// a scheduled task on each machine - see that script for what it collects and how often it posts.
// Authenticated by a shared secret (x-agent-secret header, compared against
// app_settings.workspaceDirectoryAgent.secret), not a Supabase user session, since the agent has
// no user to sign in as. This is the same shape as broadsign-sync/grassfish-sync/iot-sync, just
// inverted: those pull from a vendor API on our schedule, this accepts a push on the agent's.
//
// Upserts by hostname (unique) - only touches the telemetry columns (ip_address, anydesk_id,
// teamviewer_id, other_remote_ids, os_name, os_version, logged_in_user, software, volumes,
// components, antivirus, problems, agent_version, last_seen). `location` and `notes` are
// admin-curated from the dashboard and never written here, so a new check-in never clobbers an
// admin's tree-grouping tag. The exact shape of volumes/components/antivirus/problems is defined
// by whatever the current collector script (see workspace-directory-collector) produces, not fixed
// here - this function just stores whatever comes in, defensively capped/typed.
//
// Two other things happen here, both to keep the remote-command feature bandwidth-light (several
// of these PCs are on metered cellular SIMs, checking in only every 6 hours by design):
//  - Network usage: the agent reports networkBytesTotal, a raw cumulative counter off its network
//    adapter(s). This function diffs it against the PREVIOUS reading and adds the delta (in MB) to
//    data_used_mb_period - a running total since whenever tracking started (or was last reset from
//    the dashboard), not a calendar-anchored figure. A lower new reading than the stored one means
//    the counter reset (reboot) - treated as zero delta rather than going negative.
//  - Remote command: admin queues one PowerShell one-liner per device (pending_command, set from
//    the dashboard) - this function hands it back in the response for the agent to run locally
//    (no extra request), and accepts the PREVIOUS command's output back via body.commandOutput on
//    the agent's *next* check-in (cached locally by the agent meanwhile), clearing pending_command
//    once recorded. So a command takes up to one extra 6-hour cycle to report back, in exchange for
//    never needing a second network round-trip.
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

    // Other remote-access tools beyond AnyDesk/TeamViewer (Chrome Remote Desktop, LogMeIn, etc.) -
    // same defensive cap/shape as software, since this also comes from the admin-editable
    // collector script and shouldn't be able to bloat a row without bound.
    const otherRemoteIds = Array.isArray(body.otherRemoteIds)
      ? body.otherRemoteIds.slice(0, 20).map((r: any) => ({ tool: String(r?.tool || '').slice(0, 100), id: String(r?.id || '').slice(0, 100) })).filter((r: any) => r.tool && r.id)
      : [];
    const volumes = Array.isArray(body.volumes)
      ? body.volumes.slice(0, 50).map((v: any) => ({ drive: String(v?.drive || '').slice(0, 10), label: String(v?.label || '').slice(0, 100), sizeGb: Number(v?.sizeGb) || 0, freeGb: Number(v?.freeGb) || 0 }))
      : [];
    const antivirus = Array.isArray(body.antivirus)
      ? body.antivirus.slice(0, 20).map((a: any) => ({ name: String(a?.name || '').slice(0, 200), enabled: !!a?.enabled }))
      : [];
    const problems = Array.isArray(body.problems)
      ? body.problems.slice(0, 100).map((p: any) => String(p).slice(0, 500))
      : [];
    const components = (body.components && typeof body.components === 'object') ? body.components : {};

    const { data: existing } = await adminClient.from('workspace_devices')
      .select('network_bytes_total, data_used_mb_period').eq('hostname', hostname).maybeSingle();

    const row: Record<string, unknown> = {
      hostname,
      ip_address: body.ip ? String(body.ip).slice(0, 100) : null,
      anydesk_id: body.anydeskId ? String(body.anydeskId).slice(0, 50) : null,
      teamviewer_id: body.teamviewerId ? String(body.teamviewerId).slice(0, 50) : null,
      other_remote_ids: otherRemoteIds,
      broadsign_player_id: body.broadsignPlayerId ? String(body.broadsignPlayerId).slice(0, 100) : null,
      grassfish_box_id: body.grassfishBoxId ? String(body.grassfishBoxId).slice(0, 100) : null,
      os_name: body.os ? String(body.os).slice(0, 200) : null,
      os_version: body.osVersion ? String(body.osVersion).slice(0, 100) : null,
      logged_in_user: body.loggedInUser ? String(body.loggedInUser).slice(0, 200) : null,
      software,
      volumes,
      components,
      antivirus,
      problems,
      agent_version: body.agentVersion ? String(body.agentVersion).slice(0, 50) : null,
      last_seen: new Date().toISOString(),
    };

    const newCounter = Number.isFinite(Number(body.networkBytesTotal)) ? Number(body.networkBytesTotal) : null;
    if (newCounter !== null) {
      const priorCounter = existing?.network_bytes_total;
      const priorUsedMb = existing?.data_used_mb_period || 0;
      const deltaBytes = (typeof priorCounter === 'number' && newCounter >= priorCounter) ? newCounter - priorCounter : 0;
      row.network_bytes_total = newCounter;
      row.data_used_mb_period = priorUsedMb + deltaBytes / (1024 * 1024);
    }

    // A previous cycle's command result, cached locally by the agent and reported back now -
    // clears pending_command so the same command doesn't run again next cycle.
    if (typeof body.commandOutput === 'string' && body.commandOutput.length) {
      row.last_command_output = body.commandOutput.slice(0, 8000);
      row.last_command_at = new Date().toISOString();
      row.pending_command = null;
    }

    const { data: saved, error } = await adminClient.from('workspace_devices')
      .upsert(row, { onConflict: 'hostname' }).select('pending_command').single();
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, pendingCommand: saved?.pending_command || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
