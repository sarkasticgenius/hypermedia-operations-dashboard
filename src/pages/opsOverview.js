import { STATE, loadData, invalidate, openModal, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listLocations } from '../data/locations.js';
import { listTickets } from '../data/tickets.js';
import { listPermits, permitStatus } from '../data/permits.js';
import { listMetroPics, metroPicStatus } from '../data/metroPics.js';
import { listSimCards, simLocationDuplicateCounts, isDuplicateLocationSim } from '../data/simCards.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { hiddenMemberIds, locationOfflineStats, locationManualStats, sourceStats, inventoryFaceTotals } from '../data/locationStats.js';
import { svgGroupedBarChart, svgDonutChart } from '../lib/charts.js';
import { renderTabs } from '../lib/tabs.js';
import { esc } from '../lib/format.js';

let refreshTimer = null;

async function loadOverview() {
  const [locations, tickets, permits, metroPics, simCards, assetInventory] = await Promise.all([
    listLocations(), listTickets(), listPermits(), listMetroPics(), listSimCards(), listAssetInventory(),
  ]);
  return { locations, tickets, permits, metroPics, simCards, assetInventory };
}

function ensureAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (STATE.page === 'opsOverview') {
      invalidate('opsOverviewV2');
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

  const { locations, tickets, permits, metroPics, simCards, assetInventory } = data;
  const openTickets = urgentOpenTickets(tickets);
  const { items: offlineAssets, networkedOfflineFaces } = allOfflineAssets(locations);
  const simIssues = allSimIssues(simCards);
  const compliance = complianceDueItems(permits, metroPics);
  const health = networkHealth(locations);
  const ageBuckets = ticketAgeBuckets(openTickets);
  const visibleOffline = filteredOfflineAssets(offlineAssets);
  const inventoryTotals = inventoryFaceTotals(assetInventory);

  const kpis = [
    { key: 'tickets', label: 'Open Tickets', value: openTickets.length },
    { key: 'offline', label: 'Offline Screens', value: offlineAssets.length },
    { key: 'offlineFaces', label: 'Offline Faces', value: networkedOfflineFaces, sub: 'Broadsign + Grassfish' },
    { key: 'sims', label: 'SIM Issues', value: simIssues.length },
    { key: 'compliance', label: 'Compliance Due', value: compliance.length },
  ];

  return `
    <div class="banner"><span class="live-pulse-dot"></span>Live — updated ${new Date().toLocaleTimeString()}. This page auto-refreshes and only surfaces what needs attention right now. For a broader daily snapshot across every workspace, see <a href="#" style="color:var(--brand-orange-dark);font-weight:700;" onclick="event.preventDefault();App.setPage('dashboard')">Home</a>.</div>

    <div class="kpi-row">
      ${kpis.map((k) => `
        <div class="kpi" style="border-left:4px solid ${k.value > 0 ? '#c0392b' : '#1f9d55'};cursor:pointer;" onclick="App.scrollToOpsCard('${k.key === 'offlineFaces' ? 'offline' : k.key}')">
          <div class="label">${esc(k.label)}</div>
          <div class="value">${k.value}</div>
          ${k.sub ? `<div class="sub">${esc(k.sub)}</div>` : ''}
        </div>
      `).join('')}
    </div>

    <div class="card">
      <div class="card-head"><h3>Network Health</h3><div class="desc">${health.total - health.offline} of ${health.total} tracked items online</div></div>
      <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
        ${svgDonutChart(health.healthPct, donutColor(health.offline, health.total), 130, health.healthPct + '%', 'Online')}
        <div style="flex:1;min-width:220px;">
          ${svgGroupedBarChart(['Manual', 'Broadsign', 'Grassfish'], [{ name: 'Offline', color: '#c0392b', values: [offlineAssets.filter((o) => o.kind === 'manual').length, offlineAssets.filter((o) => o.kind === 'source' && o.source === 'Broadsign').length, offlineAssets.filter((o) => o.kind === 'source' && o.source === 'Grassfish').length] }], { width: 300, height: 130 })}
        </div>
      </div>
      <div class="kpi-row" style="margin-top:16px;">
        <div class="kpi"><div class="label">Total Screens (full inventory)</div><div class="value">${inventoryTotals.totalScreens}</div><div class="sub">${inventoryTotals.totalFaces} faces</div></div>
        <div class="kpi"><div class="label">Broadsign + Grassfish Faces</div><div class="value">${inventoryTotals.networkedFaces}</div><div class="sub">${inventoryTotals.networkedScreens} screens</div></div>
      </div>
    </div>

    <div id="ops-card-tickets" class="card">
      <div class="card-head"><h3>Open Tickets <span class="badge b-red">${openTickets.length}</span></h3></div>
      ${svgGroupedBarChart(ageBuckets.labels, [{ name: 'Tickets', color: '#e07a2c', values: ageBuckets.values }])}
      ${opsListRows(openTickets.slice(0, 8), (t) => ({
        main: t.title, sub: t.location || '-', tag: `${t.daysOpen}d open`, tagClass: t.daysOpen >= 3 ? 'b-red' : 'b-amber',
        onclick: `App.openOpsItem('ticket','${t.id}')`,
      }))}
      ${openTickets.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${openTickets.length - 8} more</div>` : ''}
      <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('tickets')">View all</button>
    </div>

    <div id="ops-card-offline" class="card">
      <div class="card-head"><h3>Offline Screens <span class="badge b-red">${offlineAssets.length}</span></h3><div class="desc">${networkedOfflineFaces} faces offline across Broadsign + Grassfish</div></div>
      ${renderTabs(OFFLINE_FILTER_TABS, STATE.opsOfflineFilter || 'All', 'App.setOpsOfflineFilter')}
      ${opsListRows(visibleOffline.slice(0, 8), (o) => ({ main: o.name, sub: o.location, tag: o.kind === 'manual' ? 'Manual' : o.source, tagClass: 'b-gray' }))}
      ${visibleOffline.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${visibleOffline.length - 8} more</div>` : ''}
      <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('locations')">View all</button>
    </div>

    <div id="ops-card-sims" class="card">
      <div class="card-head"><h3>SIM Issues <span class="badge b-amber">${simIssues.length}</span></h3></div>
      ${svgGroupedBarChart(['Duplicate', 'Mismatch'], [{ name: 'Count', color: '#8e44ad', values: [simIssues.filter((s) => s.issueType === 'Duplicate').length, simIssues.filter((s) => s.issueType === 'Mismatch').length] }])}
      ${opsListRows(simIssues.slice(0, 8), (s) => ({
        main: s.sim_number || '(no number)', sub: s.deployed_location_name || '-', tag: s.issueType, tagClass: s.issueType === 'Duplicate' ? 'b-red' : 'b-amber',
        onclick: `App.openOpsItem('sim','${s.id}')`,
      }))}
      ${simIssues.length > 8 ? `<div class="small muted" style="margin-top:6px;">+${simIssues.length - 8} more</div>` : ''}
      <button class="btn-sm" style="margin-top:8px;" onclick="App.setPage('simCards')">View all</button>
    </div>

    <div id="ops-card-compliance" class="card">
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
  `;
}
