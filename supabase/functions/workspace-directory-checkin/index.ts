// Receives one check-in per PC from scripts/workspace-directory-agent.ps1, running unattended via
// a scheduled task on each machine - see that script for what it collects and how often it posts.
// Authenticated by a shared secret (x-agent-secret header, compared against
// app_settings.workspaceDirectoryAgent.secret), not a Supabase user session, since the agent has
// no user to sign in as. This is the same shape as broadsign-sync/grassfish-sync/iot-sync, just
// inverted: those pull from a vendor API on our schedule, this accepts a push on the agent's.
//
// GRACE-PERIOD SECRET ROTATION: workspaceDirectoryAgent.value also carries an optional
// previousSecret/previousSecretExpiresAt pair, written by Settings' saveWorkspaceDirectoryAgentForm
// whenever the secret actually changes. Every already-installed agent is still running with the OLD
// secret hardcoded into its script text - it needs to authenticate at least once more (its next
// self-update poll) to receive a build with the NEW secret baked in. Without accepting the old value
// here too (until it expires), rotating would lock every PC out of self-update simultaneously: the
// very request that would deliver the new secret is itself rejected for using the old one.
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
// Absolute safety net alongside the 80%-of-plan alert below. 80% of a 43GB plan is still 8.6GB
// left - fine. 80% of TOTEM-8's 6GB plan is 1.2GB left - already tight. This catches the case the
// percentage alert can miss on a small plan: genuinely about to run out, in real GB, regardless of
// plan size.
const LOW_LEFT_GB_FLOOR = 0.3;

// True if `provided` matches either the current secret, or a not-yet-expired previous one (see the
// grace-period comment above). Centralized so every caller applies the exact same rule.
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
    if (req.method !== 'POST') throw new Error('Method not allowed');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: settingsRow } = await adminClient.from('app_settings').select('value').eq('key', 'workspaceDirectoryAgent').single();
    const agentCfg = settingsRow?.value || {};
    const providedSecret = req.headers.get('x-agent-secret');
    if (!agentCfg.secret || !secretIsValid(agentCfg, providedSecret)) {
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
      .select('id, network_bytes_total, data_used_mb_period, data_usage_computed_at, du_data_used_gb, du_data_total_gb, du_data_left_gb, broadsign_player_id, grassfish_box_id')
      .eq('hostname', hostname).maybeSingle();

    // Base fields. Only hostname and last_seen are truly unconditional: every request that gets
    // this far is genuine contact from that PC, whatever it had to say.
    const row: Record<string, unknown> = {
      hostname,
      last_seen: new Date().toISOString(),
    };

    // NOT every POST here is a check-in. The user-session DU scrape reports its own result directly
    // (see the $DuScrapeOnce branch in the agent) with a deliberately tiny payload - hostname,
    // light, duScrapeAttemptedAt, duScrapeOutcome and nothing else. When agent_version/problems/
    // force_checkin_requested were written unconditionally, that partial post silently destroyed
    // all three: agent_version fell to null, the Issues list was replaced with an empty array
    // (`Array.isArray(undefined)` is false, so `problems` above is []), and any pending Force
    // Inventory Pull was marked satisfied by a post that never ran a check-in at all.
    //
    // Confirmed live on 1 Sep 2026: seven devices sat with agent_version null AND zero problems -
    // exactly the set that had had a DU scrape reported from the user session, including
    // CARREFOURLCD and DM02-LED-NESTO- minutes after a Check Data Usage was queued against them.
    // ADCOOP-MINA-AR was the same, and its own agent log shows no matching entry, because the
    // user-session task cannot write to the SYSTEM-owned log - so this post is invisible on the PC
    // and looked like a healthy check-in from the server side.
    //
    // Presence, not the `light` flag, decides: a Light check-in is still a real check-in and does
    // send these. Anything absent is left exactly as it was, which is the same sticky rule the
    // moderate/heavy fields below already follow.
    if (body.problems !== undefined) row.problems = problems;
    if (body.agentVersion !== undefined) {
      row.agent_version = body.agentVersion ? String(body.agentVersion).slice(0, 50) : null;
    }
    // Which PUBLISHED build the PC is actually running (agent v71+), read from its own
    // installed-shell-version.txt. Distinct from agent_version above, which is the script's
    // hand-maintained internal constant and was identical across v64 -> v71 - so until this field
    // existed, "has this PC taken the new build?" could only be answered by queueing a Run Command
    // against it. Conditional like everything else here: an agent below v71 does not send it, and
    // must not have the column blanked for staying quiet.
    if (body.shellVersion !== undefined) {
      row.agent_shell_version = body.shellVersion ? String(body.shellVersion).slice(0, 20) : null;
    }
    // Whatever asked for this check-in to happen right now (a "Force Inventory Pull" click picked
    // up by Jstar's polling, or just its normal schedule) is satisfied by the fact a real check-in
    // is happening - cleared regardless of whether it was set, since a stray still-true flag would
    // otherwise force every future check-in. Gated on `problems` because that is the field the
    // agent sends on every genuine cycle and the DU-only post never carries: clearing the flag for
    // a post that did not collect anything would drop the request on the floor, and the admin would
    // be left watching a Force that silently never happened.
    if (body.problems !== undefined) row.force_checkin_requested = false;

    // Moderate (~6-hourly, if changed) and heavy (once-daily at 8am, if changed) fields - each one
    // is only written into the upsert row when the agent actually INCLUDED it this cycle
    // (`body.x !== undefined`), sticky rather than wiped, so a cycle that skips them (by design,
    // per the agent's own local diff-check - see the header comment) leaves the dashboard's
    // last-known value alone instead of blanking it to empty/null.
    if (body.ip !== undefined) row.ip_address = body.ip ? String(body.ip).slice(0, 100) : null;
    if (body.anydeskId !== undefined) row.anydesk_id = body.anydeskId ? String(body.anydeskId).slice(0, 50) : null;
    if (body.teamviewerId !== undefined) row.teamviewer_id = body.teamviewerId ? String(body.teamviewerId).slice(0, 50) : null;
    if (body.otherRemoteIds !== undefined) row.other_remote_ids = otherRemoteIds;
    // Per-installation AnyDesk detail: which id each install answers on, the binary that owns it,
    // and whether an unattended password is set. A PC can run a standard AnyDesk and a custom MSI
    // build side by side, so "the AnyDesk password" is ambiguous without knowing which install is
    // meant - this is what lets the dashboard ask. passwordSet is a boolean by design; the hash
    // itself is never read on the device, so there is nothing sensitive to store here.
    if (body.anydeskInstalls !== undefined) {
      row.anydesk_installs = Array.isArray(body.anydeskInstalls)
        ? body.anydeskInstalls.slice(0, 10).map((a: any) => ({
            id: String(a?.id || '').slice(0, 40),
            exe: String(a?.exe || '').slice(0, 300),
            service: String(a?.service || '').slice(0, 100),
            passwordSet: !!a?.passwordSet,
          })).filter((a: any) => a.id)
        : [];
    }
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
    // Number(null), Number('') and Number(false) are ALL 0, and 0 is finite - so a bare
    // Number.isFinite(Number(x)) check let an explicit null, an empty string from a half-parsed
    // scrape, or a stray boolean through as a genuine reading of 0 GB used. That is not a harmless
    // rounding: it stamps du_scraped_at, writes a daily-history row, and draws an empty usage bar
    // as though du had reported zero consumption. Only undefined and unparseable text fell out on
    // their own.
    //
    // Same rule as the volume sizes and the phone-only scrape outcome elsewhere in today's fixes:
    // an unknown must never be rendered as a confident number. Not currently reachable, because
    // Add-DuFiguresToPayload guards with `$null -ne` before sending - but every partial-payload bug
    // found today was a caller changing while this end went on trusting it.
    const duFigure = (v: unknown): number | undefined => {
      if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const duUsedGb = duFigure(body.duDataUsedGb);
    const duLeftGb = duFigure(body.duDataLeftGb);
    const duTotalGb = duFigure(body.duDataTotalGb);
    if (duUsedGb !== undefined) row.du_data_used_gb = duUsedGb;
    if (duLeftGb !== undefined) row.du_data_left_gb = duLeftGb;
    if (duTotalGb !== undefined) row.du_data_total_gb = duTotalGb;
    // Stamped on a FIGURE, never on the phone number alone. A scrape that recovers the number but
    // no usage at all still reports outcome 'ok' (the agent counts a phone number as a successful
    // parse - see Invoke-DuScrape), and the GB columns are deliberately left untouched when their
    // fields are absent, so including du_phone_number here re-dated yesterday's stored figures as
    // if they had just been read. That is the worst of both worlds: the Data Usage bar and "DU Last
    // Update" both claim a fresh reading, the Details modal says "du reported these figures", and
    // the Data Check Failed tab stays empty because the outcome really was 'ok'. Confirmed live on
    // ADCOOP-MINA-AR, 1 Sep 2026: scraped 'ok' at 04:15 UTC showing 4.84 of 15 GB, which was
    // byte-identical to its 31 Aug reading and its only daily-history row - it had reported no
    // usage figure in 18 hours. 51 devices were in that state at once, every one of them holding
    // figures exactly equal to its last history row, so nothing had moved on any of them.
    // The daily-history upsert below already gates on du_data_used_gb for this same reason; this
    // brings the timestamp in line with it, so "when were these numbers read" has one answer.
    if (row.du_data_used_gb !== undefined || row.du_data_left_gb !== undefined || row.du_data_total_gb !== undefined) {
      row.du_scraped_at = new Date().toISOString();
    }

    // What the last ATTEMPT did, whether or not it parsed anything - the fields above only arrive
    // on the days the scrape succeeds, which is why a PC on Wi-Fi/LAN (nothing to report, ever)
    // used to be indistinguishable from one whose scrape is broken, and both from one that had
    // never run it at all. The agent re-sends this trio whenever it changes rather than only on
    // scrape days, so this is also the path by which a just-updated agent backfills what it knows.
    // Timestamped by the AGENT, not on arrival like du_scraped_at above: it records when the scrape
    // ran on the PC, which can be several cycles before the check-in that finally delivers it.
    if (body.duScrapeAttemptedAt) {
      const attemptedAt = new Date(String(body.duScrapeAttemptedAt));
      if (!Number.isNaN(attemptedAt.getTime())) {
        row.du_scrape_attempted_at = attemptedAt.toISOString();
        // Constrained to the known set rather than stored as-sent, so the dashboard can branch on
        // it safely and a mangled/rogue payload can't invent a state the UI has no branch for.
        // 'partial'   - du answered with the SIM's phone number but no usage figures. Retried once,
        //               an hour later, by the agent (see Test-DuScrapeDue).
        // 'nofigures' - phone-only twice running, so the agent stops for the day rather than
        //               relaunching a browser hourly on an account that never reports usage.
        // Both must be listed here: an outcome missing from this set is stored as NULL, which the
        // dashboard reads as "never reported a scrape" - the agent would be telling the truth and
        // the server would be throwing it away.
        const outcome = String(body.duScrapeOutcome || '').toLowerCase();
        row.du_scrape_outcome = ['ok', 'nodata', 'nobrowser', 'error', 'pending', 'partial', 'nofigures'].includes(outcome) ? outcome : null;
        // Cleared when the attempt carries no note, so a fault reason doesn't outlive the fault.
        row.du_scrape_note = typeof body.duScrapeNote === 'string' && body.duScrapeNote.length
          ? body.duScrapeNote.slice(0, 500)
          : null;
      }
    }

    // Slack-worthy the moment a FRESH DU reading (this check-in, not a stale earlier one) crosses
    // 80%, OR drops under the absolute LOW_LEFT_GB_FLOOR - compared against what was stored before
    // this same upsert, so each only fires once per crossing rather than every day it stays past
    // the line (the next day's "old" value is already past it too, so the condition is false
    // again). Computed here, before the upsert, since both the old (from `existing`, fetched
    // above) and new (about to be written) values are on hand; the actual Slack call happens AFTER
    // the upsert succeeds, so a failed write can't still result in a notification about data that
    // was never actually saved.
    const newUsedGb = Number(row.du_data_used_gb ?? existing?.du_data_used_gb);
    const newTotalGb = Number(row.du_data_total_gb ?? existing?.du_data_total_gb);
    const oldUsedGb = Number(existing?.du_data_used_gb);
    const oldTotalGb = Number(existing?.du_data_total_gb);
    const newPct = newTotalGb > 0 ? (newUsedGb / newTotalGb) * 100 : null;
    const oldPct = oldTotalGb > 0 ? (oldUsedGb / oldTotalGb) * 100 : null;
    const crossed80 = row.du_data_used_gb !== undefined && newPct !== null && newPct >= 80 && (oldPct === null || oldPct < 80);

    const newLeftGbRaw = row.du_data_left_gb ?? existing?.du_data_left_gb;
    const newLeftGb = newLeftGbRaw == null ? null : Number(newLeftGbRaw);
    const oldLeftGbRaw = existing?.du_data_left_gb;
    const oldLeftGb = oldLeftGbRaw == null ? null : Number(oldLeftGbRaw);
    const crossedLowFloor = row.du_data_left_gb !== undefined && newLeftGb !== null && newLeftGb < LOW_LEFT_GB_FLOOR
      && (oldLeftGb === null || oldLeftGb >= LOW_LEFT_GB_FLOOR);

    const { data: saved, error } = await adminClient.from('workspace_devices')
      .upsert(row, { onConflict: 'hostname' }).select('id, pending_command').single();
    if (error) throw error;

    // One row per device per Dubai calendar day, so day-over-day and month-over-month usage can be
    // computed later - workspace_devices.du_data_used_gb is overwritten every scrape, so without
    // this nothing keeps yesterday's number. Only written on cycles that actually carried a fresh
    // DU reading (same gate as du_scraped_at above), and upserted per day since the scrape runs at
    // most once a day - a second check-in the same day just refines that day's row.
    if (saved?.id && row.du_data_used_gb !== undefined) {
      const usageDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
      const { error: historyErr } = await adminClient.from('workspace_device_du_usage_daily').upsert({
        device_id: saved.id,
        hostname,
        usage_date: usageDate,
        used_gb: row.du_data_used_gb ?? null,
        total_gb: row.du_data_total_gb ?? null,
        left_gb: row.du_data_left_gb ?? null,
        scraped_at: row.du_scraped_at ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'device_id,usage_date' });
      if (historyErr) console.error('du usage history upsert failed', historyErr.message);
    }

    // Several PCs can share one physical du SIM (see the shared-account clusters noted in the
    // agent's DU-retry comments - Al Furjan, Discovery Garden, Jebel Ali, Expo Station, Jumeirah
    // Golf Estates and others each run a handful of devices off a single account). The usage is one
    // number regardless of which PC's browser actually managed to render it, but until now each
    // device only ever showed ITS OWN last successful scrape - so a sibling stuck on
    // 'partial'/'nofigures'/a browser fault kept displaying figures days older than what the SIM
    // actually shows, even though another PC on the exact same number scraped it fine in the
    // meantime. Confirmed live 2 Sep 2026: CARREFOURLCD and DM02-LED-NESTO- both answer
    // +971556814967; DM02 scraped cleanly the day before while CARREFOURLCD's own attempts had been
    // failing for two days straight, and the dashboard had no way to show CARREFOURLCD what its own
    // SIM was actually doing.
    //
    // So a FRESH successful reading (this cycle, not a stale one already on `row`) is mirrored onto
    // every other device holding the same phone number. Only the figures + du_scraped_at travel -
    // the sibling's own du_scrape_outcome/du_scrape_note/du_scrape_attempted_at are left untouched,
    // since those describe THAT PC's own last attempt, not whose figures are on screen. Deliberately
    // excluded from crossed80/crossedLowFloor above (computed only against the reporting device's
    // own before/after), so one crossing fires one Slack message, not one per sibling.
    if (row.du_phone_number && row.du_data_used_gb !== undefined) {
      const { data: siblings, error: siblingsErr } = await adminClient.from('workspace_devices')
        .select('id, hostname').eq('du_phone_number', row.du_phone_number).neq('hostname', hostname);
      if (siblingsErr) {
        console.error('sibling SIM lookup failed', siblingsErr.message);
      } else if (siblings?.length) {
        const siblingIds = siblings.map((s: any) => s.id);
        const { error: siblingWriteErr } = await adminClient.from('workspace_devices').update({
          du_data_used_gb: row.du_data_used_gb,
          du_data_left_gb: row.du_data_left_gb ?? existing?.du_data_left_gb ?? null,
          du_data_total_gb: row.du_data_total_gb ?? existing?.du_data_total_gb ?? null,
          du_scraped_at: row.du_scraped_at,
        }).in('id', siblingIds);
        if (siblingWriteErr) {
          console.error('sibling SIM figures propagation failed', siblingWriteErr.message);
        } else {
          const usageDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
          for (const sib of siblings) {
            const { error: sibHistErr } = await adminClient.from('workspace_device_du_usage_daily').upsert({
              device_id: sib.id,
              hostname: sib.hostname,
              usage_date: usageDate,
              used_gb: row.du_data_used_gb ?? null,
              total_gb: row.du_data_total_gb ?? existing?.du_data_total_gb ?? null,
              left_gb: row.du_data_left_gb ?? existing?.du_data_left_gb ?? null,
              scraped_at: row.du_scraped_at ?? null,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'device_id,usage_date' });
            if (sibHistErr) console.error('sibling SIM usage history upsert failed', sibHistErr.message);
          }
        }
      }
    }

    if (crossed80 || crossedLowFloor) {
      try {
        // Leads with the matched SCREEN and VENUE this PC drives, not the hostname - "TOTEM-8"
        // means nothing to whoever reads Slack; "Totem 8 @ Dubai Mall" tells them where to
        // actually go. Falls back to the bare hostname only when there's no match. Same match
        // (Player Box ID against Asset Inventory) workspace-directory-alert-scan uses for its
        // alerts, so every Slack alert agrees on how a device resolves to a place.
        let placeLabel = hostname;
        const boxIds = [existing?.broadsign_player_id, existing?.grassfish_box_id].map((v) => (v || '').trim()).filter(Boolean);
        if (boxIds.length) {
          const { data: assets } = await adminClient.from('asset_inventory')
            .select('name, venue, player_box_id').in('player_box_id', boxIds).limit(1);
          const match = (assets || [])[0] as any;
          if (match) placeLabel = match.venue ? `${match.name} @ ${match.venue}` : match.name;
        }
        const reasons: string[] = [];
        if (crossed80) reasons.push(`used ${newPct!.toFixed(0)}% of its SIM data plan (${newUsedGb.toFixed(2)} of ${newTotalGb.toFixed(2)} GB)`);
        if (crossedLowFloor) reasons.push(`only ${newLeftGb!.toFixed(2)} GB left on its SIM`);
        const cronRes = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
        const cronSecret = cronRes.data?.value?.secret;
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        const text = `${placeLabel} has ${reasons.join(' and ')}.`;
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
