// Runs once a day via pg_cron (see the migration scheduling this, same net.http_post +
// x-cron-secret pattern as every other cron in this app) - answers a question the Digital
// Directory's own "Data Check Failed" tab can't: which PCs keep failing, not just which ones failed
// today.
//
// workspace_devices only ever holds the LATEST scrape attempt's outcome for a device, so a PC that
// has failed every single day for two weeks looks, on the dashboard, EXACTLY like one that flaked
// once. This function is what tells them apart: it logs today's failing set into
// workspace_du_failure_log (one row per device per Dubai calendar day), then reads back the
// trailing week to find devices that failed on REPEAT_OFFENDER_MIN_FAILS or more of the last
// REPEAT_OFFENDER_LOOKBACK_DAYS days, and posts a Slack digest naming them.
//
// The "is this device failing today" check is deliberately a straight duplicate of
// dataCheckFailedToday in src/pages/workspaceDirectory.js, not a shared import - same reasoning as
// STATUS_SUMMARY_STALE_MINUTES in settings.js: a small duplicated function costs nothing, and this
// runs in a completely separate Deno deployment that can't import browser-bundle source anyway. If
// dataCheckFailedToday's rule ever changes, this needs the same edit made twice - both call sites
// carry that reasoning in their own comment for exactly that reason.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const DUBAI_TZ = 'Asia/Dubai';
// A week's worth of history, requiring at least 3 failing days in it, is "keeps coming back" rather
// than "flaked once" - one bad morning (the du.ae render timing this whole feature already retries
// for) shouldn't page anyone, but the same PC failing 3+ times in a week is a real pattern worth a
// site visit rather than another silent retry.
const REPEAT_OFFENDER_LOOKBACK_DAYS = 7;
const REPEAT_OFFENDER_MIN_FAILS = 3;
// Kept well past the lookback window so a failure history is still inspectable by hand for a while,
// but not forever - this table only exists to answer "is this a repeat offender", not to be a
// permanent audit log.
const LOG_RETENTION_DAYS = 30;

function dubaiDayKey(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DUBAI_TZ }).format(new Date(value));
}

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

// Same shape and reasoning as buildLabelFor in workspace-directory-alert-scan (duplicated rather
// than shared, per this project's convention for edge functions - see that file's own header):
// names the SCREEN and VENUE a device drives rather than its bare hostname, since "PC-8CC58C11D9D0"
// tells nobody where to go but "SHZ-LED BRIDGES @ FINANCIAL CENTRE" does.
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
    const todayKey = dubaiDayKey(Date.now());

    // ---------- Step 1: log today's failing set ----------
    const { data: devices, error } = await adminClient.from('workspace_devices')
      .select('id, hostname, du_scrape_outcome, du_scrape_attempted_at, du_scraped_at, du_phone_number, broadsign_player_id, grassfish_box_id')
      .is('removed_at', null);
    if (error) throw error;

    // Straight port of dataCheckFailedToday (workspaceDirectory.js) - see this file's header for
    // why it's duplicated rather than imported.
    const failedToday = (d: any): boolean => {
      if (!d.du_scrape_attempted_at) return false;
      if (dubaiDayKey(d.du_scrape_attempted_at) !== todayKey) return false;
      if (d.du_scraped_at && dubaiDayKey(d.du_scraped_at) === todayKey) return false;
      if (d.du_scrape_outcome === 'nobrowser' || d.du_scrape_outcome === 'error') return true;
      if (d.du_scrape_outcome === 'partial' || d.du_scrape_outcome === 'nofigures') return true;
      const knownSim = !!(d.du_phone_number || d.du_scraped_at);
      return d.du_scrape_outcome === 'nodata' && knownSim;
    };

    const failingToday = ((devices || []) as any[]).filter(failedToday);
    results.failingToday = failingToday.length;

    if (failingToday.length) {
      const rows = failingToday.map((d) => ({
        device_id: d.id, hostname: d.hostname, fail_date: todayKey, outcome: d.du_scrape_outcome,
      }));
      const { error: upsertErr } = await adminClient.from('workspace_du_failure_log')
        .upsert(rows, { onConflict: 'device_id,fail_date' });
      if (upsertErr) throw upsertErr;
    }

    // Bounds the table - see LOG_RETENTION_DAYS above for why this is longer than the lookback
    // window actually used for repeat-offender detection.
    const retentionCutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await adminClient.from('workspace_du_failure_log').delete().lt('fail_date', retentionCutoff);

    // ---------- Step 2: find repeat offenders over the trailing window ----------
    const lookbackCutoff = new Date(Date.now() - (REPEAT_OFFENDER_LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: history, error: historyErr } = await adminClient.from('workspace_du_failure_log')
      .select('device_id, hostname, fail_date, outcome').gte('fail_date', lookbackCutoff);
    if (historyErr) throw historyErr;

    const byDevice = new Map<string, { hostname: string; days: Set<string>; lastOutcome: string | null; lastDate: string }>();
    for (const row of (history || []) as any[]) {
      const entry = byDevice.get(row.device_id) || { hostname: row.hostname, days: new Set<string>(), lastOutcome: null, lastDate: '' };
      entry.days.add(row.fail_date);
      // fail_date rows arrive in no particular order from the query - only the OUTCOME from the
      // most recent day is worth naming in the digest, since that's what "still failing" means.
      if (row.fail_date >= entry.lastDate) { entry.lastDate = row.fail_date; entry.lastOutcome = row.outcome; }
      byDevice.set(row.device_id, entry);
    }

    const repeatOffenders = [...byDevice.entries()]
      .filter(([, v]) => v.days.size >= REPEAT_OFFENDER_MIN_FAILS)
      .map(([deviceId, v]) => ({ deviceId, hostname: v.hostname, failDays: v.days.size, lastOutcome: v.lastOutcome }))
      .sort((a, b) => b.failDays - a.failDays);
    results.repeatOffenders = repeatOffenders.length;

    if (repeatOffenders.length) {
      // Re-fetch current broadsign/grassfish ids for these specific devices (not carried in the log
      // itself, which is intentionally a thin day/outcome trail) so the digest can name the actual
      // screen/venue the way every other alert in this app does.
      const { data: idRows } = await adminClient.from('workspace_devices')
        .select('id, hostname, broadsign_player_id, grassfish_box_id').in('id', repeatOffenders.map((o) => o.deviceId));
      const idByDevice = new Map(((idRows || []) as any[]).map((r) => [r.id, r]));
      const labelItems = repeatOffenders.map((o) => {
        const row = idByDevice.get(o.deviceId);
        return { hostname: o.hostname, broadsignPlayerId: row?.broadsign_player_id || null, grassfishBoxId: row?.grassfish_box_id || null };
      });
      const labelFor = await buildLabelFor(adminClient, labelItems);

      const lines = repeatOffenders.map((o) => {
        const row = idByDevice.get(o.deviceId);
        const label = labelFor({ hostname: o.hostname, broadsignPlayerId: row?.broadsign_player_id || null, grassfishBoxId: row?.grassfish_box_id || null });
        return `• ${label} - failed ${o.failDays} of the last ${REPEAT_OFFENDER_LOOKBACK_DAYS} days (last outcome: ${o.lastOutcome || 'unknown'})`;
      });
      const text = `:repeat: *Data Check repeat offenders* (${REPEAT_OFFENDER_MIN_FAILS}+ failures in ${REPEAT_OFFENDER_LOOKBACK_DAYS} days):\n${lines.join('\n')}`;
      results.notified = await postSlack(adminClient, supabaseUrl, anonKey, text);
    }

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
