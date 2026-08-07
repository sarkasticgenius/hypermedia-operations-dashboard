import { STATE, loadData, revalidate, openModal, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listLocations } from '../data/locations.js';
import { listTickets } from '../data/tickets.js';
import { listPermits, permitStatus } from '../data/permits.js';
import { listMetroPics, metroPicStatus } from '../data/metroPics.js';
import { listSimCards, simLocationDuplicateCounts, isDuplicateLocationSim } from '../data/simCards.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { hiddenMemberIds, locationOfflineStats, locationManualStats, sourceStats, inventoryFaceTotals, mafInventoryTotals } from '../data/locationStats.js';
import { getSetting } from '../data/settings.js';
import { VENUE_CATEGORY_KEYS, TAB_DEFS as TS_TAB_DEFS, venueMatchesTab, isFocMarketingCampaign } from './trafficSheet.js';
import { supabase } from '../supabaseClient.js';
import { svgGroupedBarChart, svgDonutChart } from '../lib/charts.js';
import { renderTabs } from '../lib/tabs.js';
import { esc } from '../lib/format.js';

let refreshTimer = null;
const TS_LABELS = Object.fromEntries(TS_TAB_DEFS.map((t) => [t.key, t.label]));

async function loadOverview() {
  const [locations, tickets, permits, metroPics, simCards, assetInventory, iotApi, trafficSheetApi] = await Promise.all([
    listLocations(), listTickets(), listPermits(), listMetroPics(), listSimCards(), listAssetInventory(), getSetting('iotApi'), getSetting('trafficSheetApi'),
  ]);
  return { locations, tickets, permits, metroPics, simCards, assetInventory, iotApi, trafficSheetApi };
}

// Fetches the whole current year in one call (Jan-Dec) instead of just the current month - the
// proxy edge function already takes an arbitrary startMonth/endMonth range (same one the Traffic
// Sheet page itself uses for custom date ranges), so this is well within what it already supports.
// Cached by year in STATE so it only refetches on a year rollover, not on every render.
async function fetchOpsTrafficSheetYear(year) {
  setState({ opsTsLoading: true });
  try {
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', {
      body: { startMonth: `${year}-01`, endMonth: `${year}-12` },
    });
    if (error || data?.error) { setState({ opsTsLoading: false }); return; }
    setState({ opsTsData: data, opsTsYear: year, opsTsLoading: false });
  } catch (e) {
    setState({ opsTsLoading: false });
  }
}

// Distinct-campaign count per venue category among the given campaigns, reusing Traffic Sheet's
// own venueMatchesTab() so the breakdown here always matches what the Traffic Sheet page itself
// would show for the same campaigns - avoids a second, potentially-drifting categorization rule.
function trafficSheetCategoryCounts(campaigns) {
  const counts = {};
  const seen = {};
  VENUE_CATEGORY_KEYS.forEach((k) => { counts[k] = 0; seen[k] = new Set(); });
  (campaigns || []).forEach((c) => {
    VENUE_CATEGORY_KEYS.forEach((k) => {
      if (seen[k].has(c.contract)) return;
      if ((c.venues || []).some((v) => venueMatchesTab(v, k))) { seen[k].add(c.contract); counts[k]++; }
    });
  });
  return counts;
}

// A campaign counts as "live" in a date range if its own start/end window overlaps that range at
// all - same overlap test Traffic Sheet's isActiveInMonth() uses, just against an arbitrary range
// instead of one calendar month (plain ISO-string comparison works since AdLive's dates are
// already YYYY-MM-DD).
function campaignOverlapsRange(c, rangeStart, rangeEnd) {
  return !!c.startDate && !!c.endDate && c.startDate <= rangeEnd && c.endDate >= rangeStart;
}

// Every count/chart the Traffic Sheet Campaigns tile shows, all derived from one year's worth of
// campaigns already loaded (fetchOpsTrafficSheetYear) - Today/This Month/Quarterly/Monthly are all
// just campaignOverlapsRange() against different windows of the same dataset, not separate fetches.
function trafficSheetYearBreakdown(campaigns, year) {
  const todayIso = todayISOString();
  const monthIso = todayIso.slice(0, 7);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const liveToday = campaigns.filter((c) => campaignOverlapsRange(c, todayIso, todayIso));
  const liveThisMonth = campaigns.filter((c) => campaignOverlapsRange(c, `${monthIso}-01`, `${monthIso}-31`));
  const liveThisYear = campaigns.filter((c) => campaignOverlapsRange(c, yearStart, yearEnd));
  const focThisYear = liveThisYear.filter(isFocMarketingCampaign);
  const expiredThisYear = campaigns.filter((c) => c.endDate && c.endDate < todayIso && c.endDate >= yearStart);

  const quarterLabels = ['Q1', 'Q2', 'Q3', 'Q4'];
  const quarterCounts = quarterLabels.map((_, qi) => {
    const startMonth = qi * 3 + 1;
    const qStart = `${year}-${String(startMonth).padStart(2, '0')}-01`;
    const qEndMonth = startMonth + 2;
    const qEnd = `${year}-${String(qEndMonth).padStart(2, '0')}-${new Date(year, qEndMonth, 0).getDate()}`;
    return campaigns.filter((c) => campaignOverlapsRange(c, qStart, qEnd)).length;
  });

  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthCounts = monthLabels.map((_, mi) => {
    const m = mi + 1;
    const mStart = `${year}-${String(m).padStart(2, '0')}-01`;
    const mEnd = `${year}-${String(m).padStart(2, '0')}-${new Date(year, m, 0).getDate()}`;
    return campaigns.filter((c) => campaignOverlapsRange(c, mStart, mEnd)).length;
  });

  return {
    liveTodayCount: liveToday.length,
    liveThisMonthCount: liveThisMonth.length,
    liveThisYearCount: liveThisYear.length,
    focThisYearCount: focThisYear.length,
    expiredThisYearCount: expiredThisYear.length,
    quarterLabels, quarterCounts, monthLabels, monthCounts,
    categoryCounts: trafficSheetCategoryCounts(liveThisYear),
  };
}

function todayISOString() { return new Date().toISOString().slice(0, 10); }

function ensureAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (STATE.page === 'opsOverview') {
      revalidate('opsOverviewV2');
      setState({});
    } else {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }, 60000);
}

function urgentOpenTickets(tickets) {
  const today = new Date();
  return tickets
    .filter((t) => t.type === 'Issue' && t.status !== 'Closed' && t.status !== 'Resolved')
    .map((t) => ({ ...t, daysOpen: Math.max(0, Math.round((today - new Date(t.date_reported)) / 86400000)) }))
    .sort((a, b) => b.daysOpen - a.daysOpen);
}

// Combines Manual + Broadsign + Grassfish offline items into one list (Grassfish was previously
// missing here entirely - only Manual/Broadsign were tallied). Also returns the combined
// Broadsign+Grassfish offline-faces total (sourceStats' offlineFaces), since that's a materially
// different number from "how many screen rows are offline" whenever any offline screen has more
// than one face.
function allOfflineAssets(locations) {
  const hidden = hiddenMemberIds(locations);
  const visible = locations.filter((l) => !hidden.has(l.id));
  const items = [];
  let networkedOfflineFaces = 0;
  for (const loc of visible) {
    const manual = locationManualStats(loc, locations);
    for (const item of manual.offlineItems) items.push({ ...item, kind: 'manual' });
    const bs = sourceStats(loc, locations, 'broadsign', 'broadsign_healthy_count');
    for (const item of bs.offlineItems) items.push({ ...item, kind: 'source', source: 'Broadsign' });
    networkedOfflineFaces += bs.offlineFaces;
    const gf = sourceStats(loc, locations, 'grassfish', 'grassfish_healthy_count');
    for (const item of gf.offlineItems) items.push({ ...item, kind: 'source', source: 'Grassfish' });
    networkedOfflineFaces += gf.offlineFaces;
  }
  return { items, networkedOfflineFaces };
}

function allSimIssues(simCards) {
  const counts = simLocationDuplicateCounts(simCards);
  const issues = [];
  for (const s of simCards) {
    if (isDuplicateLocationSim(s, counts)) issues.push({ ...s, issueType: 'Duplicate' });
    else if (s.has_mismatch) issues.push({ ...s, issueType: 'Mismatch' });
  }
  return issues.sort((a, b) => (a.issueType === 'Duplicate' ? -1 : 1) - (b.issueType === 'Duplicate' ? -1 : 1));
}

function complianceDueItems(permits, metroPics) {
  const items = [
    ...permits.filter((p) => ['Expired', 'Expiring Soon'].includes(permitStatus(p))).map((p) => ({ kind: 'permit', type: 'Permit', label: p.title, date: p.expiry_date, status: permitStatus(p), id: p.id })),
    ...metroPics.filter((m) => ['Expired', 'Expiring Soon'].includes(metroPicStatus(m))).map((m) => ({ kind: 'metroPic', type: 'Metro PIC', label: `${m.station} PIC`, date: m.validity_end, status: metroPicStatus(m), id: m.id })),
  ];
  return items.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function networkHealth(locations) {
  const hidden = hiddenMemberIds(locations);
  const visible = locations.filter((l) => !hidden.has(l.id));
  let offline = 0;
  let total = 0;
  for (const loc of visible) {
    const stats = locationOfflineStats(loc, locations);
    offline += stats.offline;
    total += stats.total;
  }
  const healthPct = total > 0 ? Math.round(((total - offline) / total) * 100) : 100;
  return { healthPct, offline, total };
}

function donutColor(offline, total) {
  if (total === 0 || offline === 0) return '#1f9d55';
  const ratio = offline / total;
  if (ratio <= 0.05) return '#e0a13a';
  if (ratio <= 0.15) return '#e07a2c';
  return '#c0392b';
}

function ticketAgeBuckets(tickets) {
  const buckets = { '0-1d': 0, '2-3d': 0, '4-7d': 0, '8d+': 0 };
  for (const t of tickets) {
    if (t.daysOpen <= 1) buckets['0-1d']++;
    else if (t.daysOpen <= 3) buckets['2-3d']++;
    else if (t.daysOpen <= 7) buckets['4-7d']++;
    else buckets['8d+']++;
  }
  return { labels: Object.keys(buckets), values: Object.values(buckets) };
}

function opsListRows(items, mapFn) {
  if (!items.length) return '<div class="empty">Nothing to show.</div>';
  return items.map((item) => {
    const r = mapFn(item);
    const clickAttr = r.onclick ? ` onclick="${r.onclick}" style="cursor:pointer;"` : '';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f2f1ee;"${clickAttr}>
        <div>
          <div style="font-weight:600;font-size:13px;">${esc(r.main)}</div>
          <div class="small muted">${esc(r.sub || '')}</div>
        </div>
        <span class="badge ${r.tagClass || 'b-gray'}">${esc(r.tag || '')}</span>
      </div>
    `;
  }).join('');
}

function filteredOfflineAssets(items) {
  const filter = STATE.opsOfflineFilter || 'All';
  if (filter === 'All') return items;
  if (filter === 'Manual') return items.filter((i) => i.kind === 'manual');
  return items.filter((i) => i.kind === 'source' && i.source === filter);
}

// Status icon for the hero stat tiles - a plain checkmark when that metric is clear (value 0),
// a warning triangle when it needs attention (value > 0). One shared icon pair rather than a
// unique glyph per KPI keeps the strip visually calm instead of noisy.
const STAT_ICON_OK = '<path d="M20 6L9 17l-5-5"/>';
const STAT_ICON_ALERT = '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';
function statIcon(alert) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${alert ? STAT_ICON_ALERT : STAT_ICON_OK}</svg>`;
}

const OFFLINE_FILTER_TABS = [
  { key: 'All', label: 'All' }, { key: 'Manual', label: 'Manual' },
  { key: 'Broadsign', label: 'Broadsign' }, { key: 'Grassfish', label: 'Grassfish' },
];

export function setOpsOfflineFilter(f) { setState({ opsOfflineFilter: f }); }
export function scrollToOpsCard(key) {
  const el = document.getElementById(`ops-card-${key}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function openOpsItem(kind, id) {
  const data = STATE.pageData.opsOverviewV2?.data;
  if (!data) return;
  if (kind === 'ticket') {
    const t = data.tickets.find((x) => x.id === id);
    if (t) openModal('ticket', t);
  } else if (kind === 'permit') {
    const p = data.permits.find((x) => x.id === id);
    if (p) openModal('permit', p);
  } else if (kind === 'metroPic') {
    const m = data.metroPics.find((x) => x.id === id);
    if (m) openModal('metroPic', m);
  } else if (kind === 'sim') {
    const s = data.simCards.find((x) => x.id === id);
    if (s) openModal('simCard', s);
  }
}

export function renderOpsOverview() {
  const data = loadData('opsOverviewV2', loadOverview);
  ensureAutoRefresh();
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { locations, tickets, permits, metroPics, simCards, assetInventory, iotApi, trafficSheetApi } = data;
  const openTickets = urgentOpenTickets(tickets);
  const { items: offlineAssets, networkedOfflineFaces } = allOfflineAssets(locations);
  const simIssues = allSimIssues(simCards);
  const compliance = complianceDueItems(permits, metroPics);
  const health = networkHealth(locations);
  const ageBuckets = ticketAgeBuckets(openTickets);
  const visibleOffline = filteredOfflineAssets(offlineAssets);
  const inventoryTotals = inventoryFaceTotals(assetInventory);
  const mafTotals = mafInventoryTotals(assetInventory);
  const iotB = iotApi?.deviceBreakdown;
  const iotTracking = iotB?.byState?.Tracking || 0;
  const iotTrackingPct = iotB?.totalDevices ? Math.round((iotTracking / iotB.totalDevices) * 100) : 0;
  // Broadsign+Grassfish online = everything in the full inventory for those two networks minus
  // whatever's currently known offline from live sync data - same "total minus offline" base
  // inventoryFaceTotals already uses, just split into online/offline instead of one static figure.
  const offlineNetworkedScreens = offlineAssets.filter((o) => o.kind === 'source').length;
  const onlineNetworkedScreens = Math.max(0, inventoryTotals.networkedScreens - offlineNetworkedScreens);
  const onlineNetworkedFaces = Math.max(0, inventoryTotals.networkedFaces - networkedOfflineFaces);

  // Traffic Sheet campaigns summary - own live fetch (the whole current year, one call),
  // independent of the opsOverviewV2 cache above since it hits a different edge function with its
  // own auth/config. Every count/chart below (Today/This Month/This Year/Quarterly/Monthly/FOC/
  // Expired) is derived client-side from that same one dataset.
  const tsConfigured = !!(trafficSheetApi?.enabled && trafficSheetApi?.apiKey);
  const currentYear = new Date().getFullYear();
  if (tsConfigured && STATE.opsTsYear !== currentYear && !STATE.opsTsLoading && STATE.opsTsFetchingYear !== currentYear) {
    STATE.opsTsFetchingYear = currentYear;
    queueMicrotask(() => fetchOpsTrafficSheetYear(currentYear));
  }
  const tsData = STATE.opsTsYear === currentYear ? STATE.opsTsData : null;
  const tsBreakdown = tsData ? trafficSheetYearBreakdown(tsData.campaigns || [], currentYear) : null;

  const kpis = [
    { key: 'tickets', label: 'Open Tickets', value: openTickets.length },
    { key: 'offline', label: 'Offline Screens', value: offlineAssets.length },
    { key: 'offlineFaces', label: 'Offline Faces', value: networkedOfflineFaces, sub: 'Broadsign + Grassfish' },
    { key: 'sims', label: 'SIM Issues', value: simIssues.length },
    { key: 'compliance', label: 'Compliance Due', value: compliance.length },
  ];

  return `
    <div class="banner"><span class="live-pulse-dot"></span>Live — updated ${new Date().toLocaleTimeString()}. This page auto-refreshes and only surfaces what needs attention right now. For a broader daily snapshot across every workspace, see <a href="#" style="color:var(--brand-orange-dark);font-weight:700;" onclick="event.preventDefault();App.setPage('dashboard')">Home</a>.</div>

    <div class="bento-stats">
      ${kpis.map((k) => `
        <div class="bento-stat ${k.value > 0 ? 'alert' : 'ok'}" onclick="App.scrollToOpsCard('${k.key === 'offlineFaces' ? 'offline' : k.key}')">
          <div class="stat-icon">${statIcon(k.value > 0)}</div>
          <div class="stat-label">${esc(k.label)}</div>
          <div class="stat-value">${k.value}</div>
          ${k.sub ? `<div class="stat-sub">${esc(k.sub)}</div>` : ''}
        </div>
      `).join('')}
    </div>

    <div class="bento-grid">
      <div class="bento-tile bento-span-4">
        <div class="card-head"><h3>Network Health</h3><div class="desc">${health.total - health.offline} of ${health.total} tracked items online</div></div>
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
          ${svgDonutChart(health.healthPct, donutColor(health.offline, health.total), 130, health.healthPct + '%', 'Online')}
          <div style="flex:1;min-width:220px;">
            ${svgGroupedBarChart(['Manual', 'Broadsign', 'Grassfish'], [{ name: 'Offline', color: '#c0392b', values: [offlineAssets.filter((o) => o.kind === 'manual').length, offlineAssets.filter((o) => o.kind === 'source' && o.source === 'Broadsign').length, offlineAssets.filter((o) => o.kind === 'source' && o.source === 'Grassfish').length] }], { width: 300, height: 130 })}
          </div>
        </div>
        <div class="kpi-row" style="margin-top:16px;">
          <div class="kpi"><div class="label">Total Screens (full inventory)</div><div class="value">${inventoryTotals.totalScreens}</div><div class="sub">${inventoryTotals.totalFaces} faces</div></div>
          <div class="kpi"><div class="label">MAF Mall Screens</div><div class="value">${mafTotals.screens}</div></div>
          <div class="kpi"><div class="label">MAF Mall Faces</div><div class="value">${mafTotals.faces}</div></div>
        </div>
        <div class="card-head" style="margin-top:16px;margin-bottom:8px;"><h3 style="font-size:13.5px;">Broadsign + Grassfish, combined</h3></div>
        <div class="kpi-row">
          <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Online Screens</div><div class="value">${onlineNetworkedScreens}</div></div>
          <div class="kpi" style="border-left:4px solid #c0392b;"><div class="label">Offline Screens</div><div class="value">${offlineNetworkedScreens}</div></div>
          <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Online Faces</div><div class="value">${onlineNetworkedFaces}</div></div>
          <div class="kpi" style="border-left:4px solid #c0392b;"><div class="label">Offline Faces</div><div class="value">${networkedOfflineFaces}</div></div>
        </div>
      </div>

      ${iotB && iotB.totalDevices ? `<div class="bento-tile bento-span-2">
        <div class="card-head"><h3>IoT Devices</h3><div class="desc">${iotB.totalDevices} device(s) via the aioo IoT Admin Console${iotApi.lastSync ? `, last synced ${new Date(iotApi.lastSync).toLocaleTimeString()}` : ''}. See <a href="#" style="color:var(--brand-orange-dark);font-weight:700;" onclick="event.preventDefault();App.setPage('iotPanel')">IoT Panel</a> for the full breakdown.</div></div>
        <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
          ${svgDonutChart(iotTrackingPct, donutColor(iotB.totalDevices - iotTracking, iotB.totalDevices), 130, iotTrackingPct + '%', 'Tracking')}
          <div style="flex:1;min-width:220px;">
            ${svgGroupedBarChart(Object.keys(iotB.byState), [{ name: 'Devices', color: '#2f6fb3', values: Object.values(iotB.byState) }], { width: 300, height: 130 })}
          </div>
        </div>
        <div class="kpi-row" style="margin-top:16px;">
          <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Tracking</div><div class="value">${iotTracking}</div></div>
          <div class="kpi" style="border-left:4px solid #c0392b;"><div class="label">Offline</div><div class="value">${iotB.byState.Offline || 0}</div></div>
          <div class="kpi"><div class="label">Ready</div><div class="value">${iotB.byState.Ready || 0}</div></div>
          <div class="kpi"><div class="label">Idle / Unknown</div><div class="value">${(iotB.byState.Idle || 0) + (iotB.byState.Unknown || 0)}</div></div>
        </div>
      </div>` : ''}

      ${tsConfigured ? `<div class="bento-tile bento-span-4">
        <div class="card-head"><h3>Traffic Sheet Campaigns</h3><div class="desc">${tsBreakdown ? `${tsBreakdown.liveTodayCount} live today, ${tsBreakdown.liveThisYearCount} live at some point in ${currentYear}.` : 'Loading...'} See <a href="#" style="color:var(--brand-orange-dark);font-weight:700;" onclick="event.preventDefault();App.setPage('trafficSheet')">Traffic Sheet</a> for full detail.</div></div>
        ${tsBreakdown ? `
          <div class="kpi-row">
            <div class="kpi" style="border-left:4px solid #1f9d55;"><div class="label">Live Today</div><div class="value">${tsBreakdown.liveTodayCount}</div></div>
            <div class="kpi"><div class="label">This Month</div><div class="value">${tsBreakdown.liveThisMonthCount}</div></div>
            <div class="kpi"><div class="label">This Year (${currentYear})</div><div class="value">${tsBreakdown.liveThisYearCount}</div></div>
            <div class="kpi"><div class="label">FOC / Marketing (${currentYear})</div><div class="value">${tsBreakdown.focThisYearCount}</div></div>
            <div class="kpi" style="border-left:4px solid #6b7280;"><div class="label">Expired (${currentYear})</div><div class="value">${tsBreakdown.expiredThisYearCount}</div></div>
          </div>
          <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:16px;">
            <div style="flex:1;min-width:220px;">
              <div class="small muted" style="margin-bottom:6px;font-weight:700;">By Quarter (${currentYear})</div>
              ${svgGroupedBarChart(tsBreakdown.quarterLabels, [{ name: 'Campaigns', color: '#2f6fb3', values: tsBreakdown.quarterCounts }], { width: 260, height: 150 })}
            </div>
            <div style="flex:2;min-width:320px;">
              <div class="small muted" style="margin-bottom:6px;font-weight:700;">By Month (${currentYear})</div>
              ${svgGroupedBarChart(tsBreakdown.monthLabels, [{ name: 'Campaigns', color: '#8e44ad', values: tsBreakdown.monthCounts }], { width: 620, height: 150 })}
            </div>
          </div>
          <div style="margin-top:16px;">
            <div class="small muted" style="margin-bottom:6px;font-weight:700;">By Venue Category (${currentYear})</div>
            ${svgGroupedBarChart(VENUE_CATEGORY_KEYS.map((k) => TS_LABELS[k] || k), [{ name: 'Campaigns', color: '#2f6fb3', values: VENUE_CATEGORY_KEYS.map((k) => tsBreakdown.categoryCounts[k] || 0) }], { width: 620, height: 150 })}
          </div>
        ` : '<div class="empty">Loading Traffic Sheet data...</div>'}
      </div>` : ''}

      <div id="ops-card-tickets" class="bento-tile bento-span-2 bento-row-2">
        <div class="card-head"><h3>Open Tickets <span class="badge b-red">${openTickets.length}</span></h3></div>
        ${svgGroupedBarChart(ageBuckets.labels, [{ name: 'Tickets', color: '#e07a2c', values: ageBuckets.values }])}
        ${opsListRows(openTickets.slice(0, 8), (t) => ({
          main: t.title, sub: t.location || '-', tag: `${t.daysOpen}d open`, tagClass: t.daysOpen >= 3 ? 'b-red' : 'b-amber',
          onclick: `App.openOpsItem('ticket','${t.id}')`,
        }))}
        ${openTickets.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${openTickets.length - 8} more</div>` : ''}
        <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('tickets')">View all</button>
      </div>

      <div id="ops-card-offline" class="bento-tile bento-span-2 bento-row-2">
        <div class="card-head"><h3>Offline Screens <span class="badge b-red">${offlineAssets.length}</span></h3><div class="desc">${networkedOfflineFaces} faces offline across Broadsign + Grassfish</div></div>
        ${renderTabs(OFFLINE_FILTER_TABS, STATE.opsOfflineFilter || 'All', 'App.setOpsOfflineFilter')}
        ${opsListRows(visibleOffline.slice(0, 8), (o) => ({ main: o.name, sub: o.location, tag: o.kind === 'manual' ? 'Manual' : o.source, tagClass: 'b-gray' }))}
        ${visibleOffline.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${visibleOffline.length - 8} more</div>` : ''}
        <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('locations')">View all</button>
      </div>

      <div id="ops-card-sims" class="bento-tile bento-span-2">
        <div class="card-head"><h3>SIM Issues <span class="badge b-amber">${simIssues.length}</span></h3></div>
        ${svgGroupedBarChart(['Duplicate', 'Mismatch'], [{ name: 'Count', color: '#8e44ad', values: [simIssues.filter((s) => s.issueType === 'Duplicate').length, simIssues.filter((s) => s.issueType === 'Mismatch').length] }])}
        ${opsListRows(simIssues.slice(0, 8), (s) => ({
          main: s.sim_number || '(no number)', sub: s.deployed_location_name || '-', tag: s.issueType, tagClass: s.issueType === 'Duplicate' ? 'b-red' : 'b-amber',
          onclick: `App.openOpsItem('sim','${s.id}')`,
        }))}
        ${simIssues.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${simIssues.length - 8} more</div>` : ''}
        <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('simCards')">View all</button>
      </div>

      <div id="ops-card-compliance" class="bento-tile bento-span-2">
        <div class="card-head"><h3>Compliance Due <span class="badge b-amber">${compliance.length}</span></h3></div>
        ${svgGroupedBarChart(['Permit', 'Metro PIC'], [{ name: 'Due', color: '#3a7ca5', values: [compliance.filter((c) => c.type === 'Permit').length, compliance.filter((c) => c.type === 'Metro PIC').length] }])}
        ${opsListRows(compliance.slice(0, 8), (c) => ({
          main: c.label, sub: c.type, tag: c.status, tagClass: c.status === 'Expired' ? 'b-red' : 'b-amber',
          onclick: `App.openOpsItem('${c.kind}','${c.id}')`,
        }))}
        ${compliance.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${compliance.length - 8} more</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn-sm" onclick="App.setPage('permits')">View Permits</button>
          <button class="btn-sm" onclick="App.setPage('metroPic')">View Metro PIC</button>
        </div>
      </div>
    </div>
  `;
}
