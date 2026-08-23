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
// The agent itself checks in on three different cadences to keep a metered cellular SIM cheap,
// deciding locally what to include each time (see Invoke-Checkin's tiering in the agent script):
//   - Every ~20 minutes: hostname, problems (Issues tile), a couple of tiny counters - this alone
//     is what keeps Online/Offline and Issues fresh at 20-minute resolution.
//   - Every ~6 hours: adds ip/remote-access-IDs/OS/logged-in-user/antivirus, but ONLY when the
//     agent's own local diff says something in that group actually changed since it last sent it -
//     otherwise that cycle is just the same minimal payload as a 20-minute one.
//   - Once a day, anchored to 8 AM local time (bundled with the DU data-usage scrape): adds
//     volumes/hardware components/the installed-software list, again only if changed.
// Each of those fields is therefore only PRESENT in the request body on the cycles that actually
// have something new to say - so every one of them is written into `row` conditionally (`body.x
// !== undefined`), sticky rather than wiped, exactly like `software` already was before this
// three-tier scheme existed. A cycle that omits a field leaves the dashboard's last-known value
// alone instead of blanking it out.
//  - Network usage: the agent reports networkBytesTotal on EVERY check-in, but this function only
//    actually diffs it against the previous reading and folds the delta (in MB) into
//    data_used_mb_period/data_used_mb_last_24h roughly once a day (gated by data_usage_computed_at,
//    independent of the 6-hourly check-in cadence itself) - the DU-style usage figure is meant to
//    read like a daily figure, not jump every 6 hours. On the 3 out of 4 check-ins where usage isn't
//    due, network_bytes_total is left untouched so the NEXT due check-in still diffs against the
//    right baseline and captures the full ~24h of usage in one go. A lower new reading than the
//    stored baseline means the counter reset (reboot) - treated as zero delta rather than negative.
//  - Remote command: admin queues one PowerShell one-liner per device (pending_command, set from
//    the dashboard) - this function hands it back in the response for the agent to run locally
//    (no extra request), and accepts the PREVIOUS command's output back via body.commandOutput on
//    the agent's *next* check-in (cached locally by the agent meanwhile), clearing pending_command
//    once recorded. So a command takes up to one extra cycle to report back, in exchange for
//    never needing a second network round-trip.
// A separate, agent-side-gated once-a-day scrape of mydata.du.ae (see Get-DuDataUsage in the agent
// script) reports du_phone_number/du_data_used_gb/du_data_left_gb/du_data_total_gb only on the
// check-ins it actually ran on - written here as a plain field-presence check rather than a
// time-based gate, since the agent itself already decided whether it was due.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-agent-secret',
};
// Gates the DU-style usage computation to roughly once a day, independent of the 6-hourly check-in
// cadence - a bit under 24h so it reliably fires on the day's 4th check-in even with some drift.
const USAGE_INTERVAL_MS = 20 * 60 * 60 * 1000;

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

    // A PC renamed from the dashboard (see the ::RENAME handler in the agent) reports what it used
    // to be called on its first check-in under the new name. Because every row here is keyed by
    // hostname, without this the upsert below would insert a SECOND row and leave the original
    // stranded - taking its Location, Notes, linked SIM Card, DU history and Broadsign match with
    // it. Renaming the existing row instead keeps all of that attached to the device it belongs to.
    //
    // Skipped if a row already exists under the new name: that would mean two machines answering to
    // the same hostname, and quietly deleting one to make room for the other is not a decision this
    // function should make on its own. The upsert then just updates whatever is there, and the old
    // row is left for an admin to look at rather than destroyed.
    const previousHostname = String(body.previousHostname || '').trim();
    if (previousHostname && previousHostname !== hostname) {
      const { data: existingNew } = await adminClient.from('workspace_devices')
        .select('hostname').eq('hostname', hostname).maybeSingle();
      if (!existingNew) {
        const { error: renameErr } = await adminClient.from('workspace_devices')
          .update({ hostname }).eq('hostname', previousHostname);
        if (renameErr) console.error('rename migration failed', renameErr.message);
      } else {
        console.warn(`rename migration skipped: a row for "${hostname}" already exists, leaving "${previousHostname}" in place`);
      }
    }

    // Software list is capped defensively - a machine with an unusually bloated Add/Remove
    // Programs list (thousands of entries from some install tooling) shouldn't be able to bloat a
    // single jsonb row without bound. uninstallString (the registry's own QuietUninstallString/
    // UninstallString, captured verbatim) is what the Digital Directory's per-item Uninstall button
    // queues as the pending command, so it's passed through rather than re-derived server-side.
    const software = Array.isArray(body.software)
      ? body.software.slice(0, 2000).map((s: any) => ({
          name: String(s?.name || '').slice(0, 300),
          version: String(s?.version || '').slice(0, 100),
          publisher: String(s?.publisher || '').slice(0, 200),
          uninstallString: String(s?.uninstallString || '').slice(0, 500),
        })).filter((s: any) => s.name)
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
      .select('network_bytes_total, data_used_mb_period, data_usage_computed_at, du_data_used_gb, du_data_total_gb').eq('hostname', hostname).maybeSingle();

    // Base fields: present on literally every check-in, light or not (see the header comment for
    // the three-tier cadence) - hostname/agent_version/last_seen/force_checkin_requested are
    // trivially small, and `problems` (the Issues tile) is deliberately sent every single cycle so
    // it stays fresh at 20-minute resolution even though the raw data it's computed FROM
    // (antivirus/volumes/remote-IDs) mostly isn't transmitted that often - see below.
    const row: Record<string, unknown> = {
      hostname,
      problems,
      agent_version: body.agentVersion ? String(body.agentVersion).slice(0, 50) : null,
      last_seen: new Date().toISOString(),
      // Whatever asked for this check-in to happen right now (a "Force Inventory Pull" click
      // picked up by Jstar's polling, or just its normal schedule) is satisfied by the fact this
      // check-in is happening at all - cleared unconditionally rather than only when it was true,
      // since a stray still-true flag would otherwise force every future check-in.
      force_checkin_requested: false,
    };

    // Moderate (~6-hourly, if changed) and heavy (once-daily at 8am, if changed) fields - each one
    // is only written into the upsert row when the agent actually INCLUDED it this cycle
    // (`body.x !== undefined`), sticky rather than wiped, so a cycle that skips them (by design,
    // per the agent's own local diff-check - see the header comment) leaves the dashboard's
    // last-known value alone instead of blanking it to empty/null.
    if (body.ip !== undefined) row.ip_address = body.ip ? String(body.ip).slice(0, 100) : null;
    if (body.anydeskId !== undefined) row.anydesk_id = body.anydeskId ? String(body.anydeskId).slice(0, 50) : null;
    if (body.teamviewerId !== undefined) row.teamviewer_id = body.teamviewerId ? String(body.teamviewerId).slice(0, 50) : null;
    if (body.otherRemoteIds !== undefined) row.other_remote_ids = otherRemoteIds;
    if (body.broadsignPlayerId !== undefined) row.broadsign_player_id = body.broadsignPlayerId ? String(body.broadsignPlayerId).slice(0, 100) : null;
    if (body.grassfishBoxId !== undefined) row.grassfish_box_id = body.grassfishBoxId ? String(body.grassfishBoxId).slice(0, 100) : null;
    if (body.os !== undefined) row.os_name = body.os ? String(body.os).slice(0, 200) : null;
    if (body.osVersion !== undefined) row.os_version = body.osVersion ? String(body.osVersion).slice(0, 100) : null;
    if (body.loggedInUser !== undefined) row.logged_in_user = body.loggedInUser ? String(body.loggedInUser).slice(0, 200) : null;
    if (body.antivirus !== undefined) row.antivirus = antivirus;
    if (body.volumes !== undefined) row.volumes = volumes;
    if (body.components !== undefined) row.components = components;
    if (body.software !== undefined) row.software = software;

    const newCounter = Number.isFinite(Number(body.networkBytesTotal)) ? Number(body.networkBytesTotal) : null;
    const lastUsageAt = existing?.data_usage_computed_at ? new Date(existing.data_usage_computed_at).getTime() : 0;
    const usageDue = (Date.now() - lastUsageAt) >= USAGE_INTERVAL_MS;
    if (newCounter !== null && usageDue) {
      const priorCounter = existing?.network_bytes_total;
      const priorUsedMb = existing?.data_used_mb_period || 0;
      const deltaBytes = (typeof priorCounter === 'number' && newCounter >= priorCounter) ? newCounter - priorCounter : 0;
      const deltaMb = deltaBytes / (1024 * 1024);
      row.network_bytes_total = newCounter;
      row.data_used_mb_period = priorUsedMb + deltaMb;
      row.data_used_mb_last_24h = deltaMb;
      row.data_usage_computed_at = new Date().toISOString();
    }

    // A previous cycle's command result, cached locally by the agent and reported back now -
    // clears pending_command so the same command doesn't run again next cycle.
    if (typeof body.commandOutput === 'string' && body.commandOutput.length) {
      row.last_command_output = body.commandOutput.slice(0, 8000);
      row.last_command_at = new Date().toISOString();
      row.pending_command = null;
    }

    // The agent's own once-a-day (locally gated) scrape of mydata.du.ae - only present on days it
    // actually ran, so these are only written when sent rather than nulled out on every check-in.
    if (body.duPhoneNumber) row.du_phone_number = String(body.duPhoneNumber).slice(0, 30);
    if (Number.isFinite(Number(body.duDataUsedGb))) row.du_data_used_gb = Number(body.duDataUsedGb);
    if (Number.isFinite(Number(body.duDataLeftGb))) row.du_data_left_gb = Number(body.duDataLeftGb);
    if (Number.isFinite(Number(body.duDataTotalGb))) row.du_data_total_gb = Number(body.duDataTotalGb);
    if (row.du_phone_number || row.du_data_used_gb !== undefined || row.du_data_left_gb !== undefined || row.du_data_total_gb !== undefined) {
      row.du_scraped_at = new Date().toISOString();
    }

    // Slack-worthy the moment a FRESH DU reading (this check-in, not a stale earlier one) crosses
    // 80% - compared against what was stored before this same upsert, so it only fires once per
    // crossing rather than every day the figure stays over 80% (the next day's oldPct is already
    // >=80, so the condition below is false again). Computed here, before the upsert, since both
    // the old (from `existing`, fetched above) and new (about to be written) values are on hand;
    // the actual Slack call happens AFTER the upsert succeeds, so a failed write can't still result
    // in a notification about data that was never actually saved.
    const newUsedGb = Number(row.du_data_used_gb ?? existing?.du_data_used_gb);
    const newTotalGb = Number(row.du_data_total_gb ?? existing?.du_data_total_gb);
    const oldUsedGb = Number(existing?.du_data_used_gb);
    const oldTotalGb = Number(existing?.du_data_total_gb);
    const newPct = newTotalGb > 0 ? (newUsedGb / newTotalGb) * 100 : null;
    const oldPct = oldTotalGb > 0 ? (oldUsedGb / oldTotalGb) * 100 : null;
    const crossed80 = row.du_data_used_gb !== undefined && newPct !== null && newPct >= 80 && (oldPct === null || oldPct < 80);

    const { data: saved, error } = await adminClient.from('workspace_devices')
      .upsert(row, { onConflict: 'hostname' }).select('pending_command').single();
    if (error) throw error;

    if (crossed80) {
      try {
        const cronRes = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
        const cronSecret = cronRes.data?.value?.secret;
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        const text = `${hostname} has used ${newPct!.toFixed(0)}% of its SIM data plan (${newUsedGb.toFixed(2)} of ${newTotalGb.toFixed(2)} GB).`;
        await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'x-cron-secret': cronSecret || '' },
          body: JSON.stringify({ text }),
        });
      } catch { /* best-effort - the check-in itself already succeeded above regardless */ }
    }

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
