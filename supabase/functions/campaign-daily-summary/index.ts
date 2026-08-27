// The daily operations digest posted to Slack at 08:00 and 19:00 Dubai (scheduled by pg_cron - see
// supabase/migrations/0043_campaign_daily_summary_cron.sql and campaign_daily_summary_0800_cron,
// same net.http_post + x-cron-secret pattern as the other crons).
//
// The slug still says "campaign-daily-summary" because that is what the cron jobs point at and what
// it originally covered; it now spans campaigns, the Digital Directory, SIM data usage, both
// signage consoles, IoT and tickets. Renaming the function would mean re-pointing two schedules for
// no functional gain.
//
// ONE POST, NOT MANY. Each section here could be its own scheduled notification, but several
// separate messages at the same time is how a digest becomes noise people mute - and a muted
// channel is worse than no digest at all. Everything lands in a single scannable post instead.
//
// WHY IT IS COUNTS-FIRST RATHER THAN A LIST OF EVERYTHING
// Printing every active campaign works at 18 and collapses at 208, which is what this account runs
// on a normal day. A 208-line post is not a report, it is a wall that hides the line that mattered.
// So each section leads with its numbers, and only things that CHANGED today (tickets raised) are
// listed by name - everything else is still exactly as it was this morning. Campaigns starting/
// ending today are counted, not named, for the same reason: on a normal day that list alone can
// run past 200 rows, which turns an ops alert into a wall of campaign names nobody scans. Anyone
// who needs the actual names has Traffic Sheet/Client Campaigns Monitor for that.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const TRAFFIC_SHEET_ENDPOINT = 'https://adlivecenter.adlive.io/api/traffic-sheet';
// Enough to see the day's real movement, short enough that the post stays scannable on a phone.
const MAX_LISTED = 10;
// Matches STALE_AFTER_MINUTES in workspaceDirectory.js and workspace-directory-alert-scan, so the
// digest's idea of "online" is the same one the dashboard and the offline alerts already use.
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

// Dubai's date, not the server's UTC date. The 19:00 cron fires at 15:00 UTC and the 08:00 one at
// 04:00 UTC - a digest headed with the wrong calendar day would be quietly wrong for everyone
// reading it, and the 08:00 run in particular sits right on the UTC-date boundary where this matters.
function dubaiToday(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  if (!iso) return '?';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1] || m} ${y}`;
}

function listSection(title: string, rows: string[]): string {
  if (!rows.length) return '';
  const shown = rows.slice(0, MAX_LISTED).join('\n');
  const more = rows.length > MAX_LISTED ? `\n_...and ${rows.length - MAX_LISTED} more_` : '';
  return `\n${title} (${rows.length})\n${shown}${more}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (!(await isAuthorized(req, adminClient, supabaseUrl, anonKey))) throw new Error('Not authenticated');

    const today = dubaiToday();
    const parts: string[] = [`:bar_chart: *HyperMedia Daily Ops Digest*\n*Date:* ${formatDate(today)}`];

    // ---------- Campaigns (live Traffic Sheet API, never stored locally) ----------
    // Wrapped so a vendor API outage degrades this one section instead of killing the whole digest -
    // the Digital Directory and ticket numbers are still worth sending if AdLive is down.
    try {
      const { data: tsRow } = await adminClient.from('app_settings').select('value').eq('key', 'trafficSheetApi').single();
      const cfg = tsRow?.value || {};
      if (!cfg.enabled || !cfg.apiKey) throw new Error('not configured');
      const res = await fetch(`${TRAFFIC_SHEET_ENDPOINT}?startMonth=${today.slice(0, 7)}&endMonth=${today.slice(0, 7)}`, {
        headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const campaigns: any[] = Array.isArray(data.campaigns) ? data.campaigns : [];
      const activeToday = campaigns.filter((c) => (c.startDate || '') <= today && (c.endDate || '') >= today);
      // Counted from what the API actually returns rather than a hardcoded list, so a status this
      // account starts using tomorrow appears on its own instead of being silently dropped.
      const byStatus = new Map<string, number>();
      for (const c of activeToday) byStatus.set(c.status || 'Unknown', (byStatus.get(c.status || 'Unknown') || 0) + 1);
      const statusLine = [...byStatus.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(' · ');
      const startedToday = campaigns.filter((c) => c.startDate === today).length;
      const endingToday = campaigns.filter((c) => c.endDate === today).length;
      // Counts only, no per-campaign names/dates - this section alone can run past 200 rows on a
      // normal day (see the file header), which turned an "ops alert" into a wall of campaign names
      // nobody was scanning. Every other section already led with numbers; this just drops the
      // list underneath them too instead of keeping it as the one exception.
      parts.push(
        `\n:dart: *Campaigns* - ${activeToday.length} active today`
        + (statusLine ? `\n${statusLine}` : '')
        + (startedToday || endingToday ? `\nStarted today: ${startedToday} · Ending today: ${endingToday}` : ''),
      );
    } catch (e) {
      parts.push(`\n:dart: *Campaigns* - unavailable (${e instanceof Error ? e.message : String(e)})`);
    }

    // ---------- Digital Directory ----------
    const staleCutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60 * 1000).toISOString();
    const { data: devices } = await adminClient.from('workspace_devices')
      .select('hostname, last_seen, problems').is('removed_at', null);
    const devList = devices || [];
    const offlineDevices = devList.filter((d: any) => !d.last_seen || d.last_seen < staleCutoff);
    const withIssues = devList.filter((d: any) => Array.isArray(d.problems) && d.problems.length > 0);
    parts.push(
      `\n:desktop_computer: *Digital Directory* - ${devList.length - offlineDevices.length}/${devList.length} online`
      + (offlineDevices.length ? `\n:red_circle: Offline: ${offlineDevices.map((d: any) => d.hostname).slice(0, MAX_LISTED).join(', ')}` : '')
      // Named per-device with WHAT the problem actually is, not just a bare count - a count told
      // nobody whether it was worth opening the dashboard or not.
      + listSection('*Reporting issues*', withIssues.map((d: any) => `• ${d.hostname} - ${(d.problems as string[]).join('; ')}`)),
    );

    // ---------- SIM Data Usage ----------
    // Two independent things worth an admin's attention, surfaced only when they actually apply -
    // no section at all when neither does, same "only what changed" rule as everywhere else here.
    //   - Notable usage: today's reading vs the PREVIOUS stored day (not necessarily yesterday - a
    //     device that missed a day still compares against its last real reading) jumped more than
    //     1GB AND the plan is already over 80% consumed. Either signal alone is common and boring;
    //     together they mean "this SIM had an unusually heavy day AND is genuinely close to
    //     running out", which is the combination worth a Slack line rather than a dashboard glance.
    //   - Scrape issues: any SIM-equipped device whose most recent scrape attempt did not
    //     succeed - reported the same day it happens rather than waiting the 48h the separate
    //     stale-scrape Slack alert allows, so a fail is visible by the very next digest.
    try {
      const { data: usageRows } = await adminClient.from('workspace_device_du_usage_daily')
        .select('hostname, usage_date, used_gb, total_gb')
        .order('usage_date', { ascending: false });
      const lastTwoByHost = new Map<string, any[]>();
      for (const r of (usageRows || []) as any[]) {
        const list = lastTwoByHost.get(r.hostname) || [];
        if (list.length < 2) list.push(r);
        lastTwoByHost.set(r.hostname, list);
      }
      const notable: string[] = [];
      for (const [hostname, rows] of lastTwoByHost) {
        if (rows.length < 2) continue;
        const [latest, prev] = rows;
        const used = Number(latest.used_gb);
        const total = Number(latest.total_gb);
        const deltaGb = used - Number(prev.used_gb);
        const pct = total > 0 ? (used / total) * 100 : 0;
        if (deltaGb > 1 && pct > 80) {
          notable.push(`• ${hostname} - ${used.toFixed(2)} of ${total.toFixed(2)} GB (${pct.toFixed(0)}%), up ${deltaGb.toFixed(2)} GB since ${prev.usage_date}`);
        }
      }

      const { data: simDevices } = await adminClient.from('workspace_devices')
        .select('hostname, du_scrape_outcome, du_scrape_note, du_scrape_attempted_at')
        .is('removed_at', null).not('du_phone_number', 'is', null);
      const failing = ((simDevices || []) as any[]).filter((d) => d.du_scrape_outcome && d.du_scrape_outcome !== 'ok' && d.du_scrape_outcome !== 'pending');
      const failLines = failing.map((d) => {
        const ageH = d.du_scrape_attempted_at ? Math.round((Date.now() - new Date(d.du_scrape_attempted_at).getTime()) / 3600000) : null;
        return `• ${d.hostname} - ${d.du_scrape_outcome}${d.du_scrape_note ? ` (${d.du_scrape_note})` : ''}${ageH !== null ? `, ${ageH}h ago` : ''}`;
      });

      if (notable.length || failLines.length) {
        parts.push(
          `\n:signal_strength: *SIM Data Usage*`
          + listSection('*Notable usage (up 1GB+, over 80%)*', notable)
          + listSection('*Scrape issues*', failLines),
        );
      }
    } catch (e) {
      parts.push(`\n:signal_strength: *SIM Data Usage* - unavailable (${e instanceof Error ? e.message : String(e)})`);
    }

    // ---------- Broadsign / Grassfish consoles ----------
    // location_sub_assets only ever holds the OFFLINE entries (the syncs write a row per screen that
    // failed to report); the healthy totals live as counts on locations. Reading both is what makes
    // "x of y" possible rather than a bare offline number with no denominator.
    //
    // Offline entries are grouped by LOCATION, with the actual screen NAMES listed under each - a
    // location header alone ("Reem Mall (4)") tells nobody which 4 screens to go check, only that
    // some 4 did. Named up to MAX_NAMES_PER_LOCATION per location so a genuinely huge outage at one
    // site still fits on a phone screen without deleting the count-first summary above it.
    const { data: subAssets } = await adminClient.from('location_sub_assets').select('source, status, location_id, name');
    const { data: locs } = await adminClient.from('locations').select('id, name, broadsign_healthy_count, grassfish_healthy_count').is('deleted_at', null);
    const locNameById = new Map((locs || []).map((l: any) => [l.id, l.name]));
    const offlineRowsFor = (src: string) => (subAssets || []).filter((s: any) => s.source === src && s.status === 'Offline');
    const healthyFor = (col: string) => (locs || []).reduce((n: number, l: any) => n + (l[col] || 0), 0);
    const MAX_NAMES_PER_LOCATION = 15;
    for (const [label, src, col, icon] of [
      ['Broadsign', 'broadsign', 'broadsign_healthy_count', ':satellite_antenna:'],
      ['Grassfish', 'grassfish', 'grassfish_healthy_count', ':satellite_antenna:'],
    ] as const) {
      const offRows = offlineRowsFor(src);
      const on = healthyFor(col);
      const total = on + offRows.length;
      const byLocation = new Map<string, string[]>();
      for (const s of offRows) {
        const locName = locNameById.get(s.location_id) || 'Unassigned';
        const names = byLocation.get(locName) || [];
        names.push(s.name || 'Unnamed screen');
        byLocation.set(locName, names);
      }
      const locLines = [...byLocation.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, names]) => {
        const shown = names.slice(0, MAX_NAMES_PER_LOCATION).join(', ');
        const more = names.length > MAX_NAMES_PER_LOCATION ? ` +${names.length - MAX_NAMES_PER_LOCATION} more` : '';
        return `• ${name} (${names.length}): ${shown}${more}`;
      });
      parts.push(
        `\n${icon} *${label}* - ${on}/${total} online` + (offRows.length ? `, :red_circle: ${offRows.length} offline` : '')
        + listSection('*Offline locations*', locLines),
      );
    }

    // ---------- IoT ----------
    // Counted from the same lastDevices snapshot the IoT Panel renders, minus the devices an admin
    // has excluded - so the digest agrees with what the panel shows rather than quietly counting
    // devices the panel deliberately hides. Grouped by site (storeName falling back to venue - same
    // convention networkPanels.js already uses for this data) for the same reason Broadsign/
    // Grassfish are grouped by location above: a site with many offline cameras should read as one
    // line, not one per device.
    const { data: iotRow } = await adminClient.from('app_settings').select('value').eq('key', 'iotApi').maybeSingle();
    const iotCfg = iotRow?.value || {};
    const excluded = new Set((iotCfg.excludedDeviceIds || []) as string[]);
    const iotDevices = ((iotCfg.lastDevices || []) as any[]).filter((d) => !excluded.has(d.deviceId));
    const iotOfflineDevices = iotDevices.filter((d) => !d.online);
    const bySite = new Map<string, number>();
    for (const d of iotOfflineDevices) {
      const site = d.storeName || d.venue || 'Unassigned';
      bySite.set(site, (bySite.get(site) || 0) + 1);
    }
    const siteLines = [...bySite.entries()].sort((a, b) => b[1] - a[1]).map(([site, n]) => `• ${site} (${n})`);
    parts.push(
      `\n:camera: *IoT* - ${iotDevices.length - iotOfflineDevices.length}/${iotDevices.length} online`
      + (iotOfflineDevices.length ? `, :red_circle: ${iotOfflineDevices.length} offline` : '')
      + (excluded.size ? ` _(${excluded.size} excluded)_` : '')
      + listSection('*Offline sites*', siteLines),
    );

    // ---------- Tickets ----------
    const { data: tickets } = await adminClient.from('tickets')
      .select('title, location, status, priority, date_reported').is('deleted_at', null);
    const tList = tickets || [];
    const raisedToday = tList.filter((t: any) => t.date_reported === today);
    const open = tList.filter((t: any) => t.status !== 'Closed');
    parts.push(
      `\n:ticket: *Tickets* - ${raisedToday.length} raised today, ${open.length} still open`
      + listSection('*Raised today*', raisedToday.map((t: any) => `• ${t.title}${t.location ? ` | ${t.location}` : ''}${t.priority ? ` | ${t.priority}` : ''}`)),
    );

    const text = parts.join('\n');

    const { data: cronRow } = await adminClient.from('app_settings').select('value').eq('key', '_cronSecret').single();
    const slackRes = await fetch(`${supabaseUrl}/functions/v1/slack-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'x-cron-secret': cronRow?.value?.secret || '',
      },
      body: JSON.stringify({ text }),
    });

    return new Response(JSON.stringify({ ok: true, date: today, notified: slackRes.ok, chars: text.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    });
  }
});
