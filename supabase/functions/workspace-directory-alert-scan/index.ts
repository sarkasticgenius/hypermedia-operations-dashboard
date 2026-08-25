// Runs every 20 minutes via pg_cron (see the migration that schedules this, same net.http_post +
// x-cron-secret pattern as broadsign-sync/grassfish-sync/iot-sync) - scans workspace_devices for
// two Slack-worthy conditions that can't be detected from inside workspace-directory-checkin
// itself, since both are about the ABSENCE of something rather than a value that arrives in a
// check-in body:
//   - A device going offline. Mirrors isOnline()/STALE_AFTER_MINUTES in workspaceDirectory.js
//     exactly (30 minutes since last_seen) - an offline device by definition isn't checking in, so
//     this can only ever be noticed by something that runs on ITS OWN schedule, not the device's.
// Data-usage crossing 80% is instead detected inside workspace-directory-checkin, at the moment a
// new du_data_used_gb/du_data_total_gb actually arrives - see the comment there for why that one
// belongs in the check-in path instead of here.
//
// Edge-triggered, not level-triggered: `offline_alerted_at` on each device row tracks whether an
// alert has already gone out for the CURRENT offline streak, cleared back to null the moment the
// device checks in again - so a device that's been offline for days doesn't re-alert every single
// scan, only the first time it's noticed, and a flapping device can alert again next time it drops.
// All newly-offline devices found in one scan are batched into a SINGLE Slack message rather than
// one message per device, since the common real-world case (a site's router/power drops) takes out
// many devices at once, not one at a time.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};
// Matches STALE_AFTER_MINUTES in src/pages/workspaceDirectory.js exactly - see that file for why
// this specific value (30 min = 1.5x the agent's 20-minute poll cycle) rather than something else.
const STALE_AFTER_MINUTES = 30;

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const { data: devices, error } = await adminClient.from('workspace_devices')
      .select('id, hostname, last_seen, offline_alerted_at, broadsign_player_id, grassfish_box_id')
      .is('removed_at', null);
    if (error) throw error;

    const staleMs = STALE_AFTER_MINUTES * 60 * 1000;
    const now = Date.now();
    const newlyOffline: { id: string; hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null }[] = [];
    const recovered: string[] = [];

    for (const d of devices || []) {
      const isOffline = !d.last_seen || (now - new Date(d.last_seen).getTime()) > staleMs;
      if (isOffline && !d.offline_alerted_at) {
        newlyOffline.push({ id: d.id, hostname: d.hostname, broadsignPlayerId: d.broadsign_player_id, grassfishBoxId: d.grassfish_box_id });
      } else if (!isOffline && d.offline_alerted_at) {
        recovered.push(d.id);
      }
    }

    // Marks newly-offline devices as alerted BEFORE actually sending, not after - if the Slack post
    // below fails, the next scan (20 min later) will just try again for anything still offline
    // anyway (it re-derives isOffline fresh each time), so there's no real downside, and this way a
    // slow/hanging Slack call can't cause the SAME device to be double-counted if this function
    // somehow got invoked twice concurrently.
    if (newlyOffline.length) {
      await adminClient.from('workspace_devices').update({ offline_alerted_at: new Date().toISOString() }).in('id', newlyOffline.map((d) => d.id));
    }
    if (recovered.length) {
      await adminClient.from('workspace_devices').update({ offline_alerted_at: null }).in('id', recovered);
    }

    let notified = false;
    if (newlyOffline.length) {
      // Names the SCREEN this PC drives rather than the PC itself. A hostname like
      // PC-1C697A0E88E4 says nothing about what is actually dark - whoever reads this alert needs
      // to know which screen, at which venue, stopped working. Matched on the same Player Box ID
      // that broadsign-sync/grassfish-sync already match on, so it agrees with the Matched Screen
      // column in the Digital Directory rather than inventing a second notion of the same link.
      //
      // Falls back to the hostname when a device drives no known screen (a back-office PC, or an
      // ID that is not in Asset Inventory) - there is genuinely nothing better to call it, and a
      // bare hostname is still far better than omitting the device from the alert.
      const boxIds = newlyOffline
        .flatMap((d) => [d.broadsignPlayerId, d.grassfishBoxId])
        .map((v) => (v || '').trim())
        .filter(Boolean);
      // Grouped, not keyed one-to-one: a single player box can drive MANY screens. DR2-FOODCOURT's
      // one Broadsign ID maps to 17 rows in Asset Inventory, so picking "a" matching screen would
      // name one arbitrary panel and quietly understate an outage covering all seventeen.
      let screensByBoxId = new Map<string, { name: string; venue: string | null }[]>();
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
      const labelFor = (d: { hostname: string; broadsignPlayerId: string | null; grassfishBoxId: string | null }) => {
        const screens = screensByBoxId.get((d.broadsignPlayerId || '').trim())
          || screensByBoxId.get((d.grassfishBoxId || '').trim())
          || [];
        if (!screens.length) return d.hostname;
        if (screens.length === 1) {
          const only = screens[0];
          return only.venue ? `${only.name} @ ${only.venue}` : only.name;
        }
        // Several screens behind one player: the venue is what matters, plus how many went dark.
        // Naming all seventeen would bury the rest of the alert.
        const venues = [...new Set(screens.map((x) => x.venue).filter(Boolean))];
        const where = venues.length === 1 ? venues[0] : `${venues.length} venues`;
        return `${screens.length} screens @ ${where}`;
      };
      const text = newlyOffline.length === 1
        ? `${labelFor(newlyOffline[0])} went offline (no check-in for ${STALE_AFTER_MINUTES}+ minutes).`
        : `${newlyOffline.length} devices went offline (no check-in for ${STALE_AFTER_MINUTES}+ minutes): ${newlyOffline.map(labelFor).join(', ')}.`;
      const cronRes = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
      const cronSecret = cronRes.data?.value?.secret;
      const slackRes = await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': anonKey, 'Authorization': `Bearer ${anonKey}`, 'x-cron-secret': cronSecret || '' },
        body: JSON.stringify({ text }),
      });
      notified = slackRes.ok;
    }

    return new Response(JSON.stringify({ ok: true, newlyOffline: newlyOffline.length, recovered: recovered.length, notified }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
