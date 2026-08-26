// Runs every 20 minutes via pg_cron (see the migration that schedules this, same net.http_post +
// x-cron-secret pattern as broadsign-sync/grassfish-sync/iot-sync) - scans for Slack-worthy
// conditions that can't be detected from inside a single check-in/sync itself, since each is about
// something ABSENT, or about state that lives across multiple syncs, rather than a value that
// arrives in one request body:
//   - A Digital Directory PC going offline, and the same PC coming back. Mirrors
//     isOnline()/STALE_AFTER_MINUTES in workspaceDirectory.js exactly (30 minutes since last_seen).
//   - A device's DU data-usage scrape going silently stale (48h+ with no fresh reading, while the
//     device is otherwise online and checking in fine). See DU_STALE_AFTER_HOURS below for why -
//     this exact blind spot let TOTEM-8's SIM run down to 91% used with nobody told.
//   - A Broadsign/Grassfish screen newly going offline, and the same screen coming back.
//     location_sub_assets only ever holds CURRENTLY offline rows, and broadsign-sync/grassfish-sync
//     fully wipe+reinsert their rows on every sync - so "newly offline" is tracked separately in
//     workspace_offline_screens, keyed by (source, location, screen name), which IS stable sync to
//     sync even though the row ids aren't. Recovery is that key disappearing from the offline set.
//   - A Digital Directory device developing a NEW problem (not full offline - antivirus disabled, a
//     popup appearing, etc.). workspace_devices.problems_last_alerted is the baseline; anything in
//     the current problems list that wasn't in that baseline is "new".
//   - A new Screen Report (field-reported screen issue). Plain alerted_at-per-row flag, since
//     screen_reports rows are stable and never get wiped/reinserted like location_sub_assets does.
// Data-usage crossing 80% (or dropping under the absolute low-GB floor) is instead detected inside
// workspace-directory-checkin, at the moment a fresh du_data_used_gb/du_data_left_gb actually
// arrives - see the comment there for why that one belongs in the check-in path instead of here.
//
// Edge-triggered throughout, not level-triggered: every condition here tracks whether it has
// already been alerted, cleared/removed the moment the condition clears - so nothing re-alerts
// every single 20-minute scan for as long as it stays true, only the first time it's noticed (and
// again if it clears and later recurs). Every "newly affected" set found in one scan is batched
// into a SINGLE Slack message per condition, since the common real-world case (a site's power
// dropping, a fleet-wide regression) affects many things at once, not one at a time.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
// Matches STALE_AFTER_MINUTES in src/pages/workspaceDirectory.js exactly - see that file for why
// this specific value (30 min = 1.5x the agent's 20-minute poll cycle) rather than something else.
const STALE_AFTER_MINUTES = 30;
// The DU scrape is meant to run once a day (anchored to each host's own slot in the 3-8 AM Dubai
// window) - 48h gives a full extra day of slack before calling it stale, so one missed jittered slot
// or a single Wi-Fi/offline blip doesn't false-alarm, while two consecutive misses still surfaces
// within a day of the second one rather than sitting silent for a week like DR2-FOODCOURT did.
const DU_STALE_AFTER_HOURS = 48;

async function isAuthorized(req: Request, adminClient: any, supabaseUrl: string, anonKey: string): Promise<boolean> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    const { data: secretRow } = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
    return !!(secretRow?.value?.secret && cronSecret === secretRow.value.secret);
  }
  const authHeader = req.headers.get('Authorization') || '';
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return false;
  const { data: profile } = await adminClient.from('profiles').select('active').eq('id', caller.id).single();
  return !!profile?.active;
}

async function postSlack(adminClient: any, supabaseUrl: string, anonKey: string, text: string): Promise<boolean> {
  const cronRes = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
  const cronSecret = cronRes.data?.value?.secret;
  const res = await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'x-cron-secret': cronSecret || '' },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}

// Names the SCREEN and VENUE a device drives rather than its bare hostname - "TOTEM-8" tells
// whoever reads Slack nothing about where to go; "Totem 8 @ Dubai Mall" does. Matched on the same
// Player Box ID that broadsign-sync/grassfish-sync/the Digital Directory's Matched Screen column
// already use, so every alert agrees on how a device resolves to a place instead of each one
// inventing its own notion of "location". Shared by every alert below that names a device.
//
// Grouped by box id (not one-to-one), since a single player box can drive MANY screens -
// DR2-FOODCOURT's one Broadsign ID maps to 17 rows in Asset Inventory, so picking "a" matching
// screen would name one arbitrary panel and quietly understate an outage covering all seventeen.
async function buildLabelFor(
  adminClient: any,
  items: { hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null }[],
): Promise<(d: { hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null }) => string> {
  const boxIds = items
    .flatMap((d) => [d.broadsignPlayerId, d.grassfishBoxId])
    .map((v) => (v || '').trim())
    .filter(Boolean);
  const screensByBoxId = new Map<string, { name: string; venue: string | null }[]>();
  if (boxIds.length) {
    const { data: assets } = await adminClient.from('asset_inventory')
      .select('name, venue, player_box_id').in('player_box_id', boxIds);
    for (const a of (assets || []) as any[]) {
      if (!a.player_box_id) continue;
      const key = String(a.player_box_id).trim();
      const list = screensByBoxId.get(key) || [];
      list.push({ name: a.name, venue: a.venue });
      screensByBoxId.set(key, list);
    }
  }
  // Leads with the matched SCREEN name, not the hostname - "TOTEM-8" tells nobody where to go,
  // "Totem 8 @ Dubai Mall" does. Falls back to the bare hostname only when a device drives no
  // known screen (a back-office PC, or an ID not in Asset Inventory) - there is genuinely nothing
  // better to call it in that case, and a hostname is still far better than omitting the device.
  return (d) => {
    const screens = screensByBoxId.get((d.broadsignPlayerId || '').trim())
      || screensByBoxId.get((d.grassfishBoxId || '').trim())
      || [];
    if (!screens.length) return d.hostname;
    if (screens.length === 1) {
      const only = screens[0];
      return only.venue ? `${only.name} @ ${only.venue}` : only.name;
    }
    const venues = [...new Set(screens.map((x) => x.venue).filter(Boolean))];
    const where = venues.length === 1 ? venues[0] : `${venues.length} venues`;
    return `${screens.length} screens @ ${where}`;
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const results: Record<string, number | boolean> = {};

    // ---------- Digital Directory: offline + DU-stale ----------
    const { data: devices, error } = await adminClient.from('workspace_devices')
      .select('id, hostname, last_seen, offline_alerted_at, broadsign_player_id, grassfish_box_id, du_phone_number, du_scraped_at, du_stale_alerted_at, problems, problems_last_alerted')
      .is('removed_at', null);
    if (error) throw error;

    const staleMs = STALE_AFTER_MINUTES * 60 * 1000;
    const now = Date.now();
    const newlyOffline: { id: string; hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null }[] = [];
    // Carries the same shape as newlyOffline (not just ids) so the recovery message can name the
    // screen/venue through buildLabelFor, exactly like the going-offline message does - being told
    // "PC-48210B335B81 is back" without knowing which screen that is means looking it up by hand.
    const recovered: { id: string; hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null; offlineSince: string | null }[] = [];
    const newlyDuStale: { id: string; hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null; lastScraped: string | null }[] = [];
    const duRecovered: string[] = [];
    const newProblemDevices: { id: string; hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null; newOnes: string[]; allProblems: string[] }[] = [];

    const duStaleMs = DU_STALE_AFTER_HOURS * 60 * 60 * 1000;
    for (const d of devices || []) {
      const isOffline = !d.last_seen || (now - new Date(d.last_seen).getTime()) > staleMs;
      if (isOffline && !d.offline_alerted_at) {
        newlyOffline.push({ id: d.id, hostname: d.hostname, broadsignPlayerId: d.broadsign_player_id, grassfishBoxId: d.grassfish_box_id });
      } else if (!isOffline && d.offline_alerted_at) {
        recovered.push({ id: d.id, hostname: d.hostname, broadsignPlayerId: d.broadsign_player_id, grassfishBoxId: d.grassfish_box_id, offlineSince: d.offline_alerted_at });
      }

      // New-problem check runs regardless of online/offline - a device that just went offline still
      // carries its last-known problems list, worth comparing against its baseline like any other.
      const currentProblems: string[] = Array.isArray(d.problems) ? d.problems : [];
      const lastAlerted: string[] = Array.isArray(d.problems_last_alerted) ? d.problems_last_alerted : [];
      const lastAlertedSet = new Set(lastAlerted);
      const brandNew = currentProblems.filter((p) => !lastAlertedSet.has(p));
      if (brandNew.length) {
        newProblemDevices.push({ id: d.id, hostname: d.hostname, broadsignPlayerId: d.broadsign_player_id, grassfishBoxId: d.grassfish_box_id, newOnes: brandNew, allProblems: currentProblems });
      }

      // Only SIM-equipped, currently-ONLINE devices are eligible for DU-stale - see header comment.
      if (!d.du_phone_number || isOffline) continue;
      const scrapeAge = d.du_scraped_at ? now - new Date(d.du_scraped_at).getTime() : Infinity;
      const isDuStale = scrapeAge > duStaleMs;
      if (isDuStale && !d.du_stale_alerted_at) {
        newlyDuStale.push({ id: d.id, hostname: d.hostname, broadsignPlayerId: d.broadsign_player_id, grassfishBoxId: d.grassfish_box_id, lastScraped: d.du_scraped_at });
      } else if (!isDuStale && d.du_stale_alerted_at) {
        duRecovered.push(d.id);
      }
    }

    // Marks/updates BEFORE actually sending, not after - if a Slack post below fails, the next scan
    // (20 min later) either re-derives the SAME condition fresh (offline/DU-stale, so no downside)
    // or, for new-problems, simply won't re-alert on a problem it already recorded as seen; either
    // way a slow/hanging Slack call can't cause double-counting if this function somehow runs twice
    // concurrently.
    if (newlyOffline.length) {
      await adminClient.from('workspace_devices').update({ offline_alerted_at: new Date().toISOString() }).in('id', newlyOffline.map((d) => d.id));
    }
    if (recovered.length) {
      await adminClient.from('workspace_devices').update({ offline_alerted_at: null }).in('id', recovered.map((d) => d.id));
    }
    if (newlyDuStale.length) {
      await adminClient.from('workspace_devices').update({ du_stale_alerted_at: new Date().toISOString() }).in('id', newlyDuStale.map((d) => d.id));
    }
    if (duRecovered.length) {
      await adminClient.from('workspace_devices').update({ du_stale_alerted_at: null }).in('id', duRecovered);
    }
    if (newProblemDevices.length) {
      await Promise.all(newProblemDevices.map((d) =>
        adminClient.from('workspace_devices').update({ problems_last_alerted: d.allProblems }).eq('id', d.id)));
    }

    if (newlyOffline.length) {
      const labelFor = await buildLabelFor(adminClient, newlyOffline);
      const text = newlyOffline.length === 1
        ? `${labelFor(newlyOffline[0])} went offline (no check-in for ${STALE_AFTER_MINUTES}+ minutes).`
        : `${newlyOffline.length} devices went offline (no check-in for ${STALE_AFTER_MINUTES}+ minutes): ${newlyOffline.map(labelFor).join(', ')}.`;
      results.notified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }

    // The going-offline alert had no counterpart, so a device coming back was silent - the flag was
    // cleared in the database and nothing was said, leaving whoever saw the offline message with no
    // way to learn it had resolved except by opening the dashboard. Same edge-triggered batching as
    // every other condition here: one message per scan, fired only on the transition.
    if (recovered.length) {
      const labelFor = await buildLabelFor(adminClient, recovered);
      // Measured from when the OFFLINE ALERT fired, not from last_seen - last_seen has already been
      // updated by the check-in that brought it back, so it now reads seconds ago and would make
      // every outage look instant. offline_alerted_at is the last timestamp that still refers to
      // the outage itself. It lags the true start by up to one scan interval, hence "about".
      const downLabel = (iso: string | null) => {
        if (!iso) return '';
        const mins = Math.round((now - new Date(iso).getTime()) / 60000);
        if (mins < 60) return ` after about ${mins} minute${mins === 1 ? '' : 's'}`;
        // One decimal only when it actually adds something - a flat toFixed(1) rendered a clean
        // five-hour outage as "5.0 hours", which reads like spurious precision rather than detail.
        const hours = mins / 60;
        if (hours < 24) {
          const shown = hours < 10 ? Number(hours.toFixed(1)) : Math.round(hours);
          return ` after about ${shown} hour${shown === 1 ? '' : 's'}`;
        }
        return ` after about ${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'}`;
      };
      const text = recovered.length === 1
        ? `:white_check_mark: ${labelFor(recovered[0])} is back online${downLabel(recovered[0].offlineSince)}.`
        : `:white_check_mark: ${recovered.length} devices are back online: ${recovered.map((d) => `${labelFor(d)}${downLabel(d.offlineSince)}`).join(', ')}.`;
      results.recoveryNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }
    results.newlyOffline = newlyOffline.length;
    results.recovered = recovered.length;

    if (newlyDuStale.length) {
      const labelFor = await buildLabelFor(adminClient, newlyDuStale);
      // "Never" rather than a bogus duration for a device that has NEVER produced a reading -
      // distinguishing "was fine, then broke" from "has been broken since day one" is exactly the
      // kind of detail that made DR2-FOODCOURT take four days to notice.
      const ageLabel = (iso: string | null) => {
        if (!iso) return 'never scraped successfully';
        const days = Math.floor((now - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
        return `last good reading ${days}d ago`;
      };
      const list = newlyDuStale.map((d) => `${labelFor(d)} - ${ageLabel(d.lastScraped)}`).join(', ');
      const text = newlyDuStale.length === 1
        ? `:warning: ${labelFor(newlyDuStale[0])}'s SIM data-usage scrape has gone silent - ${ageLabel(newlyDuStale[0].lastScraped)}, device is online and checking in fine otherwise. Its data usage on the dashboard is stale and may no longer reflect reality.`
        : `:warning: ${newlyDuStale.length} devices' SIM data-usage scrapes have gone silent (online and checking in fine otherwise, but no fresh DU reading in ${DU_STALE_AFTER_HOURS}+ hours): ${list}. Their data usage on the dashboard may no longer reflect reality.`;
      results.duNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }
    results.newlyDuStale = newlyDuStale.length;
    results.duRecovered = duRecovered.length;

    if (newProblemDevices.length) {
      const labelFor = await buildLabelFor(adminClient, newProblemDevices);
      const lines = newProblemDevices.map((d) => `• ${labelFor(d)}: ${d.newOnes.join('; ')}`);
      const text = newProblemDevices.length === 1
        ? `:warning: New issue on ${lines[0].slice(2)}`
        : `:warning: New issue(s) on ${newProblemDevices.length} device(s):\n${lines.join('\n')}`;
      results.issuesNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }
    results.newProblemDevices = newProblemDevices.length;

    // ---------- Broadsign / Grassfish: newly-offline screens ----------
    // location_sub_assets only ever holds CURRENTLY offline rows and gets wiped+reinserted whole on
    // every sync (see header comment), so "newly offline" is computed by diffing against
    // workspace_offline_screens - the durable record of which (source, location, screen) keys were
    // already known offline as of the last scan.
    const { data: offlineSubAssets } = await adminClient.from('location_sub_assets')
      .select('source, location_id, name').eq('status', 'Offline').not('location_id', 'is', null);
    const currentScreens = ((offlineSubAssets || []) as any[]).filter((s) => s.source === 'broadsign' || s.source === 'grassfish');
    const currentKeySet = new Set(currentScreens.map((s) => `${s.source}|${s.location_id}|${s.name}`));

    const { data: knownOffline } = await adminClient.from('workspace_offline_screens').select('id, source, location_id, screen_key');
    // Keeps the whole row, not just the id: recovery is announced by NAME and venue like the
    // going-offline message, and once the row is deleted below there is nothing left to look it up
    // from - location_sub_assets only holds screens that are still offline.
    const knownKeyToRow = new Map(((knownOffline || []) as any[]).map((k) => [`${k.source}|${k.location_id}|${k.screen_key}`, k]));

    const newlyOfflineScreens = currentScreens.filter((s) => !knownKeyToRow.has(`${s.source}|${s.location_id}|${s.name}`));
    const recoveredScreens = [...knownKeyToRow.entries()].filter(([key]) => !currentKeySet.has(key)).map(([, row]) => row);
    const recoveredScreenIds = recoveredScreens.map((r) => r.id);

    if (newlyOfflineScreens.length) {
      await adminClient.from('workspace_offline_screens')
        .upsert(newlyOfflineScreens.map((s) => ({ source: s.source, location_id: s.location_id, screen_key: s.name })), { onConflict: 'source,location_id,screen_key' });
    }
    if (recoveredScreenIds.length) {
      await adminClient.from('workspace_offline_screens').delete().in('id', recoveredScreenIds);
    }

    if (newlyOfflineScreens.length) {
      const locIds = [...new Set(newlyOfflineScreens.map((s) => s.location_id))];
      const { data: locRows } = await adminClient.from('locations').select('id, name').in('id', locIds);
      const locNameById = new Map(((locRows || []) as any[]).map((l) => [l.id, l.name]));
      // Grouped by source+location, with the actual screen NAMES listed - a mall where 5 Broadsign
      // screens just dropped together should read as one line naming all 5, not a bare count that
      // tells nobody which screens to go check.
      const bySourceLoc = new Map<string, { source: string; locName: string; names: string[] }>();
      for (const s of newlyOfflineScreens) {
        const key = `${s.source}|${s.location_id}`;
        const entry = bySourceLoc.get(key) || { source: s.source, locName: locNameById.get(s.location_id) || 'Unassigned', names: [] };
        entry.names.push(s.name || 'Unnamed screen');
        bySourceLoc.set(key, entry);
      }
      const MAX_NAMES_PER_LOCATION = 15;
      const lines = [...bySourceLoc.values()].sort((a, b) => b.names.length - a.names.length)
        .map((e) => {
          const shown = e.names.slice(0, MAX_NAMES_PER_LOCATION).join(', ');
          const more = e.names.length > MAX_NAMES_PER_LOCATION ? ` +${e.names.length - MAX_NAMES_PER_LOCATION} more` : '';
          return `• [${e.source === 'broadsign' ? 'Broadsign' : 'Grassfish'}] ${e.locName} (${e.names.length}): ${shown}${more}`;
        });
      const text = `:red_circle: ${newlyOfflineScreens.length} screen(s) newly offline:\n${lines.join('\n')}`;
      results.screensNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }

    // Counterpart to the newly-offline message above. Without it a screen's recovery was only ever
    // a silent row delete, so an admin who saw ":red_circle: IBM-GF-MPI-8B newly offline" was never
    // told it came back - the same one-sided reporting the device path had.
    if (recoveredScreens.length) {
      const locIds = [...new Set(recoveredScreens.map((s) => s.location_id))];
      const { data: locRows } = await adminClient.from('locations').select('id, name').in('id', locIds);
      const locNameById = new Map(((locRows || []) as any[]).map((l) => [l.id, l.name]));
      // Grouped by source+location and capped identically to the offline message - a whole mall
      // coming back at once is exactly as common as it dropping at once (one power event, both
      // directions), so it needs the same treatment rather than one line per screen.
      const bySourceLoc = new Map<string, { source: string; locName: string; names: string[] }>();
      for (const s of recoveredScreens) {
        const key = `${s.source}|${s.location_id}`;
        const entry = bySourceLoc.get(key) || { source: s.source, locName: locNameById.get(s.location_id) || 'Unassigned', names: [] };
        entry.names.push(s.screen_key || 'Unnamed screen');
        bySourceLoc.set(key, entry);
      }
      const MAX_NAMES_PER_LOCATION = 15;
      const lines = [...bySourceLoc.values()].sort((a, b) => b.names.length - a.names.length)
        .map((e) => {
          const shown = e.names.slice(0, MAX_NAMES_PER_LOCATION).join(', ');
          const more = e.names.length > MAX_NAMES_PER_LOCATION ? ` +${e.names.length - MAX_NAMES_PER_LOCATION} more` : '';
          return `• [${e.source === 'broadsign' ? 'Broadsign' : 'Grassfish'}] ${e.locName} (${e.names.length}): ${shown}${more}`;
        });
      const text = `:white_check_mark: ${recoveredScreens.length} screen(s) back online:\n${lines.join('\n')}`;
      results.screenRecoveryNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }
    results.newlyOfflineScreens = newlyOfflineScreens.length;
    results.recoveredScreens = recoveredScreenIds.length;

    // ---------- New Screen Reports ----------
    const { data: newReports } = await adminClient.from('screen_reports')
      .select('id, asset_id, description, reporter_name').is('alerted_at', null);
    if ((newReports || []).length) {
      await adminClient.from('screen_reports').update({ alerted_at: new Date().toISOString() }).in('id', (newReports as any[]).map((r) => r.id));
      const assetIds = [...new Set((newReports as any[]).map((r) => r.asset_id).filter(Boolean))];
      const { data: assets } = assetIds.length
        ? await adminClient.from('asset_inventory').select('id, name, venue').in('id', assetIds)
        : { data: [] };
      const assetById = new Map(((assets || []) as any[]).map((a) => [a.id, a]));
      const lines = (newReports as any[]).map((r) => {
        const a = assetById.get(r.asset_id);
        const place = a ? (a.venue ? `${a.name} @ ${a.venue}` : a.name) : 'Unknown screen';
        return `• ${place} - ${r.description}${r.reporter_name ? ` (reported by ${r.reporter_name})` : ''}`;
      });
      const text = `:memo: ${(newReports as any[]).length} new Screen Report${(newReports as any[]).length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
      results.reportsNotified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }
    results.newScreenReports = (newReports || []).length;

    return new Response(JSON.stringify({ ok: true, ...results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
