import { STATE, setState, loadData, toast } from './state.js';
import { canViewPage } from './router.js';
import { isAdmin, isClientUser, canView, logout } from './auth.js';
import { listDashboardSections } from './data/dashboards.js';
import { listClients } from './data/clients.js';
import { LOGO_IMG } from './logo.js';
import { esc } from './lib/format.js';
import { isImpersonating, impersonationAdminName, stopImpersonation } from './impersonate.js';
import { renderThemeToggle } from './theme.js';

// Display labels for the three dashboard_sections.nav_group values - shown both as the
// expandable sidebar group label and as the Dashboards page's dynamic topbar title.
export const NAV_GROUP_LABELS = { dashboards: 'Maintenance Panel', campaigns: 'Digital Campaigns Panel', pdooh: 'pDOOH Campaign Panel', clientCampaigns: 'Client Campaigns Monitor' };

const NAV_ITEMS_TOP = [
  { page: 'opsOverview', label: 'Live Ops Overview' },
  { page: 'dashboard', label: 'Home' },
  { page: 'assetsInventory', label: 'Asset Inventory' },
  { page: 'assets', label: 'Hardware Inventory' },
  { page: 'procurement', label: 'Procurement & Delivery' },
  { page: 'locations', label: 'Locations' },
  { page: 'permits', label: 'Permits' },
  { page: 'metroPic', label: 'Metro PIC' },
  { page: 'tickets', label: 'Ticketing' },
  { page: 'simCards', label: 'SIM Cards' },
  { page: 'workspaceDirectory', label: 'Digital Directory' },
  { page: 'screenReports', label: 'Screen Reports' },
];
const NAV_ITEMS_BOTTOM = [
  { page: 'staticCampaigns', label: 'Static Campaigns' },
  { page: 'trafficSheet', label: 'Traffic Sheet' },
  { page: 'reporting', label: 'Reporting' },
  { page: 'creativeResizer', label: 'Creative Resizer' },
];

// A small gradient-chip line icon per workspace, keyed by nav label/key so it stays attached even
// as pages get renamed - purely visual, doesn't affect routing. Replaced the old flat single-color
// emoji set (looked dated, inconsistent across OSes/fonts) with hand-drawn stroke icons in colored
// rounded-square badges - same idea Linear/Notion-style sidebars use, renders identically
// everywhere since it's plain SVG rather than relying on the platform's emoji font.
const NAV_ICONS = {
  'Live Ops Overview': { grad: ['#6366f1', '#8b5cf6'], svg: '<path d="M3 17l5-5 4 4 8-9"/><path d="M14 7h7v7"/>' },
  Home: { grad: ['#f59e0b', '#ea580c'], svg: '<path d="M4 11.5L12 4l8 7.5"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>' },
  'Asset Inventory': { grad: ['#14b8a6', '#06b6d4'], svg: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8"/><path d="M12 16v4"/>' },
  'Hardware Inventory': { grad: ['#a16207', '#c2853a'], svg: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>' },
  'Procurement & Delivery': { grad: ['#16a34a', '#22c55e'], svg: '<rect x="2" y="8" width="12" height="8" rx="1"/><path d="M14 11h4l3 3v2h-7z"/><circle cx="6.5" cy="18" r="1.6"/><circle cx="16.5" cy="18" r="1.6"/>' },
  Locations: { grad: ['#e11d48', '#f43f5e'], svg: '<path d="M12 21s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.4"/>' },
  Permits: { grad: ['#4f46e5', '#6366f1'], svg: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12h6M9.5 15.5h6M9.5 8.5h3"/>' },
  'Metro PIC': { grad: ['#0891b2', '#0ea5e9'], svg: '<rect x="5" y="3" width="14" height="12" rx="4"/><path d="M8 19l-2 2M16 19l2 2"/><circle cx="9" cy="11" r="1.1"/><circle cx="15" cy="11" r="1.1"/><path d="M5 11h14"/>' },
  Ticketing: { grad: ['#7c3aed', '#a855f7'], svg: '<path d="M3 8a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/>' },
  'SIM Cards': { grad: ['#0284c7', '#38bdf8'], svg: '<path d="M4 20h2v-4H4z"/><path d="M9 20h2v-8H9z"/><path d="M14 20h2v-12h-2z"/><path d="M19 20h2v-16h-2z"/>' },
  'Digital Directory': { grad: ['#0891b2', '#22d3ee'], svg: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="7.5" cy="6.5" r=".6" fill="#fff"/><circle cx="9.5" cy="6.5" r=".6" fill="#fff"/>' },
  'Screen Reports': { grad: ['#dc2626', '#f97316'], svg: '<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="M12 13v3M12 18h.01"/>' },
  'Static Campaigns': { grad: ['#db2777', '#f472b6'], svg: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-6-6-4 4-2-2-6 6"/>' },
  'Traffic Sheet': { grad: ['#ea580c', '#dc2626'], svg: '<rect x="9" y="2" width="6" height="16" rx="3"/><circle cx="12" cy="6" r="1.3"/><circle cx="12" cy="10" r="1.3"/><circle cx="12" cy="14" r="1.3"/><path d="M9 20h6"/>' },
  Reporting: { grad: ['#0ea5e9', '#6366f1'], svg: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9 16v-3M12 16v-5M15 16v-2"/>' },
  'Creative Resizer': { grad: ['#8b5cf6', '#d946ef'], svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4 5-5 4 4"/><circle cx="8.5" cy="8.5" r="1.4"/>' },
  'Digital Campaigns Panel': { grad: ['#9333ea', '#d946ef'], svg: '<path d="M3 10v4h3l6 4V6l-6 4H3z"/><path d="M14 9a4 4 0 010 6"/><path d="M17 6a8 8 0 010 12"/>' },
  'pDOOH Campaign Panel': { grad: ['#2563eb', '#4f46e5'], svg: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M10 9l4 2-4 2z"/>' },
  'Maintenance Panel': { grad: ['#475569', '#64748b'], svg: '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.8 2.8-2-2z"/>' },
  'Client Campaigns Monitor': { grad: ['#059669', '#10b981'], svg: '<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/>' },
  'Campaign Monitor': { grad: ['#059669', '#10b981'], svg: '<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6z"/><path d="M9 12l2 2 4-4"/>' },
  Administration: { grad: ['#9f1239', '#be123c'], svg: '<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6z"/>' },
  Settings: { grad: ['#525252', '#737373'], svg: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12a7 7 0 00.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6a7 7 0 00.1-1.2z"/>' },
  'My Account': { grad: ['#f59e0b', '#f97316'], svg: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-7 8-7s8 3 8 7"/>' },
  'Recycle Bin': { grad: ['#dc2626', '#f87171'], svg: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>' },
};
function navIcon(label) {
  const def = NAV_ICONS[label];
  if (!def) return '';
  return `<span class="nav-icon-chip" aria-hidden="true" style="background:linear-gradient(135deg,${def.grad[0]},${def.grad[1]})">
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${def.svg}</svg>
  </span>`;
}

function navItem(page, label) {
  if (!canViewPage(page)) return '';
  const active = STATE.page === page ? ' active' : '';
  return `<div class="nav-item${active}" onclick="App.setPage('${page}')">${navIcon(label)}${esc(label)}</div>`;
}

// An expandable nav group header: clicking the label navigates (onclickJs), clicking the
// arrow only toggles expansion (stopPropagation keeps the two independent).
function navParent(label, isActive, expanded, toggleKey, onclickJs) {
  return `<div class="nav-item${isActive ? ' active' : ''}" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
    <span style="flex:1;" onclick="${onclickJs}">${navIcon(label)}${esc(label)}</span>
    <span class="nav-arrow${expanded ? ' open' : ''}" onclick="event.stopPropagation();App.toggleNavExpand('${toggleKey}')">&#8250;</span>
  </div>`;
}

function navSubItem(label, isActive, page) {
  return `<div class="nav-subitem${isActive ? ' active' : ''}" onclick="App.setPage('${page}')">${esc(label)}</div>`;
}

// A nested dashboard-link nav entry (under Maintenance/Campaigns/pDOOH panels). Admins get an
// inline Edit button that opens the same modal the Dashboards page's "+ Add Link" uses.
function navDashLink(sectionId, dash, admin) {
  const active = STATE.page === 'dashboards' && STATE.activeDashboard === dash.id;
  return `<div class="nav-subitem${active ? ' active' : ''}" style="display:flex;justify-content:space-between;align-items:center;padding-right:10px;" onclick="App.goToDashLink('${sectionId}','${dash.id}')">
    <span>${esc(dash.name)}</span>
    ${admin ? `<button class="link-btn" style="border:none;background:none;padding:0 0 0 6px;font-size:11px;color:var(--text-dim);" onclick='event.stopPropagation();App.editDashLink("${dash.id}","${sectionId}")' title="Edit">Edit</button>` : ''}
  </div>`;
}

function flattenDashboards(sections, navGroup) {
  const out = [];
  sections.forEach((s) => {
    if ((s.nav_group || 'dashboards') !== navGroup) return;
    (s.dashboards || []).forEach((d) => out.push({ sectionId: s.id, dash: d }));
  });
  return out;
}

// A client-portal login only ever sees its own single Campaign Monitor link + Account - none of
// the other nav groups apply to a restricted client account, so this bypasses the normal sidebar
// entirely rather than trying to selectively hide pieces of it.
function renderClientSidebar() {
  const user = STATE.user;
  return `
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="logo-badge">${LOGO_IMG}</div>
        <div>
          <div class="name">HYPERMEDIA</div>
          <div class="sub">Operations</div>
        </div>
      </div>
      <div class="nav-scroll">
        <div class="nav-section">Campaigns</div>
        ${navItem('clientCampaignMonitor', 'Campaign Monitor')}
        <div class="nav-section">Account</div>
        ${navItem('account', 'My Account')}
      </div>
      <div class="sidebar-footer">
        <div class="u">${esc(user?.name || '')}</div>
        <div class="r">${esc(user?.title || 'Client')}</div>
        <button class="logout-btn" onclick="App.logout()">Log out</button>
      </div>
    </div>
  `;
}

function navClientLink(client) {
  const active = STATE.page === 'clientCampaignMonitor' && STATE.activeClientId === client.id;
  return `<div class="nav-subitem${active ? ' active' : ''}" onclick="App.goToClientMonitor('${client.id}')">${esc(client.name)}</div>`;
}

function renderSidebar(allSections) {
  if (isClientUser()) return renderClientSidebar();

  const user = STATE.user;
  const admin = isAdmin();

  const activeDashSec = STATE.page === 'dashboards' ? allSections.find((s) => s.id === STATE.activeDashSection) : null;
  const activeGroup = activeDashSec ? (activeDashSec.nav_group || 'dashboards') : null;

  const campExpanded = !!STATE.navExpanded.campaigns || STATE.page === 'gantt' || activeGroup === 'campaigns';
  const dashExpanded = !!STATE.navExpanded.dashboards || activeGroup === 'dashboards' || STATE.page === 'broadsignPanel' || STATE.page === 'grassfishPanel' || STATE.page === 'iotPanel';
  const pdoohExpanded = !!STATE.navExpanded.pdooh || activeGroup === 'pdooh';

  const maintenanceSection = allSections.find((s) => s.lock_key === 'maintenance') || allSections.find((s) => (s.nav_group || 'dashboards') === 'dashboards');
  const pdoohSection = allSections.find((s) => s.lock_key === 'pdooh') || allSections.find((s) => (s.nav_group || 'dashboards') === 'pdooh');

  const consoleLinksHtml = canView('maintenancePanels')
    ? navSubItem('Broadsign Console', STATE.page === 'broadsignPanel', 'broadsignPanel')
      + navSubItem('Grassfish Console', STATE.page === 'grassfishPanel', 'grassfishPanel')
      + navSubItem('IoT Panel', STATE.page === 'iotPanel', 'iotPanel')
    : '';
  const dashLinksHtml = canView('dashboards')
    ? flattenDashboards(allSections, 'dashboards').map(({ sectionId, dash }) => navDashLink(sectionId, dash, admin)).join('')
    : '';
  const campLinksHtml = flattenDashboards(allSections, 'campaigns').map(({ sectionId, dash }) => navDashLink(sectionId, dash, admin)).join('');
  const pdoohLinksHtml = flattenDashboards(allSections, 'pdooh').map(({ sectionId, dash }) => navDashLink(sectionId, dash, admin)).join('');

  const topItems = NAV_ITEMS_TOP.map((n) => navItem(n.page, n.label)).join('');

  const campaignsGroup = canView('campaigns')
    ? navParent(NAV_GROUP_LABELS.campaigns, STATE.page === 'campaigns', campExpanded, 'campaigns', "App.setPage('campaigns')")
      + (campExpanded ? campLinksHtml + navSubItem('Campaign Calendar', STATE.page === 'gantt', 'gantt') : '')
    : '';

  const pdoohGroup = canView('pdooh')
    ? navParent(NAV_GROUP_LABELS.pdooh, STATE.page === 'dashboards' && activeGroup === 'pdooh', pdoohExpanded, 'pdooh', pdoohSection ? `App.goToDashGroup('${pdoohSection.id}')` : "App.setPage('dashboards')")
      + (pdoohExpanded ? pdoohLinksHtml || '<div class="empty small" style="padding-left:34px;">No links yet.</div>' : '')
    : '';

  const maintenanceGroup = (canView('dashboards') || canView('maintenancePanels'))
    ? navParent(NAV_GROUP_LABELS.dashboards, (STATE.page === 'dashboards' && activeGroup === 'dashboards') || STATE.page === 'broadsignPanel' || STATE.page === 'grassfishPanel' || STATE.page === 'iotPanel', dashExpanded, 'dashboards', maintenanceSection ? `App.goToDashGroup('${maintenanceSection.id}')` : "App.setPage('dashboards')")
      + (dashExpanded ? consoleLinksHtml + dashLinksHtml : '')
    : '';

  // Sub-items come from the Clients table (Settings > Clients) - one per configured client, same
  // "one dynamic sidebar group fed by a DB table" pattern the Maintenance/Campaigns/pDOOH panels
  // use with dashboard_sections, just fed by listClients() instead.
  const clientCampExpanded = !!STATE.navExpanded.clientCampaigns || STATE.page === 'clientCampaignMonitor';
  const clients = canView('clientCampaigns') ? (loadData('clients', listClients) || []) : [];
  const clientCampGroup = canView('clientCampaigns')
    ? navParent(NAV_GROUP_LABELS.clientCampaigns, STATE.page === 'clientCampaignMonitor' && !STATE.activeClientId, clientCampExpanded, 'clientCampaigns', "App.setPage('clientCampaignMonitor')")
      + (clientCampExpanded ? (clients.map(navClientLink).join('') || '<div class="empty small" style="padding-left:34px;">No clients yet - add one in Settings.</div>') : '')
    : '';

  const bottomItems = NAV_ITEMS_BOTTOM.map((n) => navItem(n.page, n.label)).join('');
  const adminLinks = admin ? navItem('admin', 'Administration') + navItem('settings', 'Settings') + navItem('recycleBin', 'Recycle Bin') : '';

  return `
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="logo-badge">${LOGO_IMG}</div>
        <div>
          <div class="name">HYPERMEDIA</div>
          <div class="sub">Operations</div>
        </div>
      </div>
      <div class="nav-scroll">
        <div class="nav-section">Operations</div>
        ${topItems}
        ${campaignsGroup}
        ${pdoohGroup}
        ${maintenanceGroup}
        ${clientCampGroup}
        ${bottomItems}
        ${adminLinks ? `<div class="nav-section">Admin</div>${adminLinks}` : ''}
        <div class="nav-section">Account</div>
        ${navItem('account', 'My Account')}
      </div>
      <div class="sidebar-footer">
        <div class="u">${esc(user?.name || '')}</div>
        <div class="r">${esc(user?.title || (isAdmin() ? 'Administrator' : 'Team member'))}</div>
        <button class="logout-btn" onclick="App.logout()">Log out</button>
      </div>
    </div>
  `;
}

const PAGE_TITLES = {
  opsOverview: 'Live Ops Overview',
  dashboard: 'Home',
  assetsInventory: 'Asset Inventory',
  assets: 'Hardware Inventory',
  procurement: 'Procurement & Delivery',
  locations: 'Locations',
  broadsignPanel: 'Broadsign Console',
  grassfishPanel: 'Grassfish Console',
  iotPanel: 'IoT Panel',
  permits: 'Permits',
  metroPic: 'Metro PIC',
  tickets: 'Ticketing',
  simCards: 'SIM Cards',
  workspaceDirectory: 'Digital Directory',
  screenReports: 'Screen Reports',
  campaigns: 'Digital Campaigns',
  gantt: 'Campaign Calendar',
  staticCampaigns: 'Static Campaigns',
  trafficSheet: 'Traffic Sheet',
  reporting: 'Reporting',
  creativeResizer: 'Creative Resizer',
  clientCampaignMonitor: 'Client Campaigns Monitor',
  dashboards: 'Maintenance Panel',
  admin: 'Administration',
  settings: 'Settings',
  recycleBin: 'Recycle Bin',
  account: 'My Account',
};

function pageTitle(allSections) {
  if (STATE.page === 'dashboards') {
    const sec = allSections.find((s) => s.id === STATE.activeDashSection);
    const group = sec ? (sec.nav_group || 'dashboards') : 'dashboards';
    return NAV_GROUP_LABELS[group] || 'Dashboards';
  }
  return PAGE_TITLES[STATE.page] || '';
}

function renderImpersonationBanner() {
  if (!isImpersonating()) return '';
  return `
    <div style="background:#c0392b;color:#fff;padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:14px;font-size:13px;font-weight:600;flex-wrap:wrap;">
      <span>Impersonating <strong>${esc(STATE.user?.name || STATE.user?.username || '')}</strong> - signed in by ${esc(impersonationAdminName() || 'an admin')}</span>
      <button class="btn-sm" style="background:#fff;color:#c0392b;border:none;" onclick="App.stopImpersonating()">Return to Admin</button>
    </div>
  `;
}

export function renderShell(innerHtml) {
  const allSections = loadData('dashboardSections', listDashboardSections) || [];
  const title = pageTitle(allSections);
  return `
    ${renderImpersonationBanner()}
    <div class="shell">
      ${renderSidebar(allSections)}
      <div class="main">
        <div class="topbar">
          <div style="display:flex;align-items:center;gap:10px;">
            ${canGoBack() ? `<button class="btn-outline btn-sm" type="button" onclick="App.goBack()" title="${esc(backButtonTitle())}" aria-label="Back">&larr;</button>` : ''}
            <h1>${esc(title)}</h1>
          </div>
          <div class="meta" style="display:flex;align-items:center;gap:12px;">
            ${renderThemeToggle()}
            <span>${esc(STATE.user?.name || '')}</span>
          </div>
        </div>
        <div class="content">${innerHtml}</div>
      </div>
    </div>
  `;
}

export async function stopImpersonating() {
  try {
    await stopImpersonation();
    toast('Back to your admin session');
  } catch (e) { toast(e.message, 'error'); }
}

// Every page-changing nav action goes through this instead of a raw setState() - pushes the page
// being LEFT onto a capped history stack whenever the destination is actually different, so a
// single global "Back" control (see renderShell()'s topbar) can return to wherever the user was,
// regardless of which of the several nav functions below got them to the current page. Capped at
// 20 so a long session doesn't grow this unboundedly.
function navigateTo(newState) {
  const history = STATE.pageHistory || [];
  if (newState.page && newState.page !== STATE.page) {
    setState({ ...newState, pageHistory: [...history, STATE.page].slice(-20) });
  } else {
    setState(newState);
  }
}

export function goToPage(page) {
  navigateTo({ page, modal: null });
}

// Clicking a Maintenance/pDOOH panel group's label in the sidebar: jump to the Dashboards page
// scoped to that section, keeping whichever link (if any) was last active within it.
export function goToDashGroup(sectionId) {
  navigateTo({ page: 'dashboards', activeDashSection: sectionId || null, modal: null });
}

// Clicking a specific nested dashboard link in the sidebar.
export function goToDashLink(sectionId, dashId) {
  navigateTo({ page: 'dashboards', activeDashSection: sectionId, activeDashboard: dashId, modal: null });
}

// Clicking a specific client under the Client Campaigns Monitor group.
export function goToClientMonitor(clientId) {
  navigateTo({ page: 'clientCampaignMonitor', activeClientId: clientId, modal: null });
}

// Traffic Sheet's Location drill-down (clicking a mall/venue row) filters the current page in
// place rather than changing STATE.page, so it never shows up in pageHistory - without this, Back
// would skip straight past it to whatever page was open before Traffic Sheet entirely, which is
// exactly the "takes me to a different workspace" complaint. Checked ahead of page-history popping
// so Back always undoes the most recent thing the user did, whether that was a drill-down or a
// page change.
function trafficSheetDrilledIn() {
  return STATE.page === 'trafficSheet' && !!STATE.trafficSheetLocation;
}

export function canGoBack() {
  return trafficSheetDrilledIn() || (STATE.pageHistory || []).length > 0;
}

export function backButtonTitle() {
  return trafficSheetDrilledIn() ? 'Back to the location list' : 'Return to the previous page';
}

// Pops the last entry straight into STATE.page - deliberately NOT routed through navigateTo(), so
// clicking Back never pushes its own history entry (which would otherwise make "back" and
// "forward" loop against each other).
export function goBack() {
  if (trafficSheetDrilledIn()) {
    setState({ trafficSheetLocation: '' });
    return;
  }
  const history = STATE.pageHistory || [];
  if (!history.length) return;
  const prevPage = history[history.length - 1];
  setState({ page: prevPage, pageHistory: history.slice(0, -1), modal: null });
}

export function toggleNavExpand(key) {
  setState({ navExpanded: { ...STATE.navExpanded, [key]: !STATE.navExpanded[key] } });
}

export async function doLogout() {
  await logout();
}
