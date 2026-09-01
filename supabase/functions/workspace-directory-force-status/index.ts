// Answers one question, as cheaply as possible: "has the dashboard asked this PC to check in right
// now?" Polled by Jstar (not the headless 6-hourly scheduled task - that would defeat the point of
// an on-demand check) every couple of minutes so a "Force Inventory Pull" click on the dashboard
// gets picked up in near-real-time, without the PCs needing any inbound reachability - these are
// metered-SIM PCs behind NAT/cellular routers with no public IP, so the dashboard can never reach
// OUT to them; this is the polling side of that constraint, kept tiny (a few dozen bytes) since it
// runs far more often than the real check-in does. The flag itself is cleared by
// workspace-directory-checkin once a real check-in actually lands, not here.
//
// ALSO delivers one-shot secrets (currently: a new AnyDesk password set from the dashboard). This
// piggybacks on the poll the agent already makes rather than adding a second endpoint call: these
// PCs are on metered cellular SIMs, and a separate per-cycle request for something that is almost
// always absent would cost data on every device, every cycle, to say "nothing" nearly every time.
//
// Secrets travel here rather than through pending_command deliberately. A queued Run Command lands
// in workspace_devices.pending_command, in the audit_log detail, and afterwards in
// last_command_output - three long-lived clear-text copies of a live remote-access credential. The
// agent_secret_deliveries table has no SELECT policy at all, so the browser can send a password and
// nobody can ever read one back; only this function (service role) can, and the row is destroyed as
// soon as the agent confirms it applied.
//
// GRACE-PERIOD SECRET ROTATION: workspaceDirectoryAgent.value also carries an optional
// previousSecret/previousSecretExpiresAt pair, written by Settings whenever the AGENT secret
// (unrelated to the one-shot AnyDesk secrets this endpoint delivers) actually changes - accepted
// here too until it expires, same reasoning as every other endpoint an already-installed agent
// polls with its still-old hardcoded secret.
//
// Same shared-secret auth as workspace-directory-checkin (x-agent-secret), not a user session.
// GET only:
//   ?hostname=<name>                  -> { force, secret: { id, kind, value } | null }
//   ?hostname=<name>&applied=<id>     -> confirms delivery; the row is deleted and the change stamped
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-secret',
};

// How long a handed-out-but-unconfirmed secret may live before it is reaped. Bounds the window in
// which a credential exists in the database at all: if the agent took it and then died before
// confirming, the row is destroyed anyway and the admin simply sends it again.
const CLAIM_EXPIRY_MINUTES = 60;

// True if `provided` matches either the current agent secret, or a not-yet-expired previous one
// (see the grace-period comment above). Centralized so every caller applies the exact same rule.
function secretIsValid(cfg: any, provided: string | null): boolean {
  if (!provided) return false;
  if (cfg?.secret && provided === cfg.secret) return true;
  if (cfg?.previousSecret && cfg?.previousSecretExpiresAt && provided === cfg.previousSecret) {
    return new Date(cfg.previousSecretExpiresAt).getTime() > Date.now();
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: agentRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgent').single();
    const agentCfg = agentRow?.value || {};
    const providedSecret = req.headers.get('x-agent-secret');
    if (!agentCfg.secret || !secretIsValid(agentCfg, providedSecret)) {
      throw new Error('Not authenticated - missing or incorrect x-agent-secret header.');
    }

    const url = new URL(req.url);
    const hostname = url.searchParams.get('hostname');
    if (!hostname) throw new Error('hostname query param is required.');

    // Confirmation leg: the agent has applied the secret, so destroy it and record WHEN it changed
    // (never what it changed to). Scoped by hostname as well as id so one device cannot confirm
    // away another device's pending secret.
    const appliedId = url.searchParams.get('applied');
    if (appliedId) {
      const { data: gone } = await adminClient.from('agent_secret_deliveries')
        .delete().eq('id', appliedId).eq('hostname', hostname).select('kind').maybeSingle();
      if (gone?.kind === 'anydeskPassword') {
        await adminClient.from('workspace_devices')
          .update({ anydesk_password_set_at: new Date().toISOString() }).eq('hostname', hostname);
      }
      return new Response(JSON.stringify({ ok: true, confirmed: !!gone }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
      });
    }

    // Reap anything handed out long ago and never confirmed, so an interrupted delivery cannot
    // leave a credential sitting in the table indefinitely.
    await adminClient.from('agent_secret_deliveries')
      .delete()
      .lt('claimed_at', new Date(Date.now() - CLAIM_EXPIRY_MINUTES * 60 * 1000).toISOString());

    const { data: deviceRow } = await adminClient.from('workspace_devices')
      .select('force_checkin_requested').eq('hostname', hostname).maybeSingle();

    // Oldest first, so a password sent twice applies in the order it was sent rather than leaving
    // the earlier one to be applied last and win.
    const { data: pending } = await adminClient.from('agent_secret_deliveries')
      .select('id, kind, secret, target').eq('hostname', hostname)
      .order('created_at', { ascending: true }).limit(1).maybeSingle();

    if (pending) {
      await adminClient.from('agent_secret_deliveries')
        .update({ claimed_at: new Date().toISOString() }).eq('id', pending.id);
    }

    return new Response(JSON.stringify({
      force: !!deviceRow?.force_checkin_requested,
      // `target` (which AnyDesk installation this password is for) was missing here - the agent
      // reads $resp.secret.target and passes it straight to Set-AnyDeskPassword, which only ever
      // matched an install by that id. Omitting it meant every delivery was silently doomed: the
      // agent always called Set-AnyDeskPassword with a null target, which can never equal a real
      // install id, so the password was never applied and the delivery just sat there being
      // reclaimed (and retried, and failing the same way) on every single poll forever.
      secret: pending ? { id: pending.id, kind: pending.kind, value: pending.secret, target: pending.target } : null,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
