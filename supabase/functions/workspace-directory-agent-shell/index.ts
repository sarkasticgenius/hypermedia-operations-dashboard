// Serves the current outer-shell script body (self-elevate, scheduled-task registration, remote-
// command runner, tray icon install, self-update check itself) to installed agents. Until this
// existed, that shell was the one part of the Digital Directory Agent that required physically
// re-running the installer on every PC to change - the Data Collector Script
// (workspace-directory-collector) already worked this way for what gets collected, but not for the
// shell logic around it. Several of these PCs are in remote locations with no one available to
// manually re-install, so the shell's own Invoke-SelfUpdate function checks here and
// overwrites+re-execs itself when a newer version exists - see buildWorkspaceDirectoryAgentScript
// in src/pages/settings.js for that logic and for how "Publish Latest Agent Version" writes here.
//
// TWO RESPONSE MODES, because these agents run on metered cellular SIMs and the shell script is
// ~100KB:
//   - "?meta=1"  -> { version } only, a couple of dozen bytes. This is what an agent asks for on
//                   every run, just to find out whether it already has the current version.
//   - no param   -> { script, version }, the full body. Only fetched on the rare run where the
//                   version actually differs from what the agent already has on disk.
// Before the meta mode existed every agent downloaded the entire ~100KB shell on every 20-minute
// poll purely to discover nothing had changed - roughly 211MB per device per month, on the very
// data plan this whole feature exists to measure and conserve.
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

    // TWO SLOTS, so a Publish can be tried on a few machines before it reaches signage PCs in
    // malls that nobody can walk up to:
    //   - workspaceDirectoryAgentShell        -> STABLE, what the fleet runs.
    //   - workspaceDirectoryAgentShellCanary  -> { script, version, hostnames[] }, served ONLY to
    //                                            the hostnames listed on it.
    // Routing is by the hostname the agent now sends on its self-update check. An agent that sends
    // NO hostname (any build older than that change) always falls through to stable - the safe
    // default, since an unidentified device must never be handed an untested build.
    const { data: shellRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgentShell').single();
    let script = shellRow?.value?.script || '';
    let version = shellRow?.value?.version || 0;

    const hostname = (new URL(req.url).searchParams.get('hostname') || '').trim();
    let isTestPc = false;
    if (hostname) {
      const { data: canaryRow } = await adminClient.from('app_settings').select('value')
        .eq('key', 'workspaceDirectoryAgentShellCanary').maybeSingle();
      const canary = canaryRow?.value;
      // Compared case-insensitively: Windows hostnames are case-insensitive, and an admin typing
      // "hm-office-test" into the dashboard should not silently fail to match "HM-OFFICE-TEST".
      const targets = (canary?.hostnames || []).map((h: string) => String(h).trim().toUpperCase());
      isTestPc = targets.includes(hostname.toUpperCase());
      if (canary?.script && isTestPc) {
        script = canary.script;
        version = canary.version || 0;
      }
    }

    // Per-device hold ("Updates" toggle on the Digital Directory page). Checked BEFORE the
    // fleet-wide freeze because it is the more specific instruction: a device explicitly held by an
    // admin stays held whether or not the fleet as a whole is moving, and that includes test PCs -
    // if someone deliberately pinned one, a canary publish must not quietly override them.
    //
    // Re-enabling deliberately does NOT replay the versions the device missed. The agent only
    // compares what it has against what is published RIGHT NOW and fetches that single build, so a
    // machine that sat out several publishes jumps straight to the newest one.
    if (hostname) {
      const { data: deviceRow } = await adminClient.from('workspace_devices')
        .select('updates_disabled, updates_pinned_version').eq('hostname', hostname).maybeSingle();
      if (deviceRow?.updates_disabled) {
        // Falls back to the version this device's own channel is serving when no pin was recorded
        // - that is what it is already running, so its version check still matches and it stays put.
        const pinned = deviceRow.updates_pinned_version ?? version;
        const metaOnlyDevice = new URL(req.url).searchParams.get('meta') === '1';
        return new Response(JSON.stringify(metaOnlyDevice ? { version: pinned } : { script: '', version: pinned }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
        });
      }
    }

    // An admin hold on fleet updates ("Freeze Fleet Updates" in Settings). Enforced HERE rather
    // than only by disabling the button, so the hold cannot be undone by someone publishing again
    // later - the fleet keeps being told the version it is already running, so every agent's own
    // version check matches, and it never downloads a script at all. Zero bytes on a metered SIM,
    // and no code change reaches a signage PC nobody can walk up to.
    //
    // Test PCs are deliberately exempt: freezing exists so work can continue on them while the
    // rest of the fleet holds still. An agent that sends no hostname is treated as fleet, the same
    // safe default used for canary routing above.
    if (shellRow?.value?.frozen && !isTestPc) {
      const pinned = shellRow?.value?.frozenAtVersion ?? version;
      const metaOnlyFrozen = new URL(req.url).searchParams.get('meta') === '1';
      return new Response(JSON.stringify(metaOnlyFrozen ? { version: pinned } : { script: '', version: pinned }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

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
