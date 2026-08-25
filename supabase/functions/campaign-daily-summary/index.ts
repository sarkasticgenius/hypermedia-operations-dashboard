// The daily operations digest posted to Slack at 19:00 Dubai (scheduled by pg_cron - see
// supabase/migrations/0043_campaign_daily_summary_cron.sql, same net.http_post + x-cron-secret
// pattern as the other crons).
//
// The slug still says "campaign-daily-summary" because that is what the cron job points at and what
// it originally covered; it now spans campaigns, the Digital Directory, both signage consoles, IoT
// and tickets. Renaming the function would mean re-pointing the schedule for no functional gain.
//
// ONE POST, NOT FIVE. Each section here could be its own scheduled notification, but five separate
// 19:00 messages is how a digest becomes noise people mute - and a muted channel is worse than no
// digest at all. Everything lands in a single scannable post instead.
//
// WHY IT IS COUNTS-FIRST RATHER THAN A LIST OF EVERYTHING
// Printing every active campaign works at 18 and collapses at 208, which is what this account runs
// on a normal day. A 208-line post is not a report, it is a wall that hides the line that mattered.
// So each section leads with its numbers, and only things that CHANGED today (campaigns starting or
// ending, tickets raised) are listed - everything else is still exactly as it was this morning.
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

// Dubai's date, not the server's UTC date. The cron fires at 15:00 UTC, which is 19:00 in Dubai -
// a digest headed with the wrong calendar day would be quietly wrong for everyone reading it.
function dubaiToday(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  if (!iso) return '?';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1] || m} ${y}`;
}

function campaignLine(c: any): string {
  const networks = Array.isArray(c.networks) && c.networks.length ? ` | ${c.networks.join(', ')}` : '';
  return `• ${c.campaignName || '(unnamed)'}${networks} | ${formatDate(c.startDate)} - ${formatDate(c.endDate)}`;
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
      parts.push(
        `\n:dart: *Campaigns* - ${activeToday.length} active today`
        + (statusLine ? `\n${statusLine}` : '')
        + listSection('*Started today*', campaigns.filter((c) => c.startDate === today).map(campaignLine))
        + listSection('*Ending today*', campaigns.filter((c) => c.endDate === today).map(campaignLine)),
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
      + (withIssues.length ? `\n:warning: ${withIssues.length} device(s) reporting issues` : ''),
    );

    // ---------- Broadsign / Grassfish consoles ----------
    // location_sub_assets only ever holds the OFFLINE entries (the syncs write a row per screen that
    // failed to report); the healthy totals live as counts on locations. Reading both is what makes
    // "x of y" possible rather than a bare offline number with no denominator.
    const { data: subAssets } = await adminClient.from('location_sub_assets').select('source, status');
    const { data: locs } = await adminClient.from('locations').select('broadsign_healthy_count, grassfish_healthy_count');
    const offlineFor = (src: string) => (subAssets || []).filter((s: any) => s.source === src && s.status === 'Offline').length;
    const healthyFor = (col: string) => (locs || []).reduce((n: number, l: any) => n + (l[col] || 0), 0);
    for (const [label, src, col, icon] of [
      ['Broadsign', 'broadsign', 'broadsign_healthy_count', ':satellite_antenna:'],
      ['Grassfish', 'grassfish', 'grassfish_healthy_count', ':satellite_antenna:'],
    ] as const) {
      const off = offlineFor(src);
      const on = healthyFor(col);
      const total = on + off;
      parts.push(`\n${icon} *${label}* - ${on}/${total} online` + (off ? `, :red_circle: ${off} offline` : ''));
    }

    // ---------- IoT ----------
    // Counted from the same lastDevices snapshot the IoT Panel renders, minus the devices an admin
    // has excluded - so the digest agrees with what the panel shows rather than quietly counting
    // devices the panel deliberately hides.
    const { data: iotRow } = await adminClient.from('app_settings').select('value').eq('key', 'iotApi').maybeSingle();
    const iotCfg = iotRow?.value || {};
    const excluded = new Set((iotCfg.excludedDeviceIds || []) as string[]);
    const iotDevices = ((iotCfg.lastDevices || []) as any[]).filter((d) => !excluded.has(d.deviceId));
    const iotOffline = iotDevices.filter((d) => !d.online).length;
    parts.push(
      `\n:camera: *IoT* - ${iotDevices.length - iotOffline}/${iotDevices.length} online`
      + (iotOffline ? `, :red_circle: ${iotOffline} offline` : '')
      + (excluded.size ? ` _(${excluded.size} excluded)_` : ''),
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
