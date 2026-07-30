import { STATE, setState, loadData } from './state.js';
import { canViewPage } from './router.js';
import { isAdmin, canView, logout } from './auth.js';
import { listDashboardSections } from './data/dashboards.js';
import { LOGO_IMG } from './logo.js';
import { esc } from './lib/format.js';

// Display labels for the three dashboard_sections.nav_group values - shown both as the
// expandable sidebar group label and as the Dashboards page's dynamic topbar title.
export const NAV_GROUP_LABELS = { dashboards: 'Maintenance Panel', campaigns: 'Digital Campaigns Panel', pdooh: 'pDOOH Campaign Panel' };

const NAV_ITEMS_TOP = [
  { page: 'opsOverview', label: 'Live Ops Overview' },
  { page: 'dashboard', label: 'Home' },
  { page: 'assetsInventory', label: 'Asset Inventory' },
  { page: 'assets', label: 'Hardware Inventory' },
  { page: 'procurement', label: 'Procurement & Delivery' },
  { page: 'locations', label: 'Locations' },
  { page: 'permits', label: 'Permits' },
  { page: 'metroPic', label: 'Metro PIC' },
  { page: 'tickets', label: 'Tickets' },
  { page: 'simCards', label: 'SIM Cards' },
];
const NAV_ITEMS_BOTTOM = [
  { page: 'staticCampaigns', label: 'Static Campaigns' },
];

// A small icon per workspace, keyed by nav label/key so it stays attached even as pages get
// renamed - purely visual, doesn't affect routing.
const NAV_ICONS = {
  'Live Ops Overview': '📊', Home: '🏠', 'Asset Inventory': '🖥️', 'Hardware Inventory': '📦',
  'Procurement & Delivery': '🚚', Locations: '📍', Permits: '📄', 'Metro PIC': '🚇',
  Tickets: '🎫', 'SIM Cards': '📶', 'Static Campaigns': '🖼️',
  'Digital Campaigns Panel': '📢', 'pDOOH Campaign Panel': '📺', 'Maintenance Panel': '🛠️',
  Administration: '🛡️', Settings: '⚙️', 'My Account': '👤',
};
function navIcon(label) {
  const icon = NAV_ICONS[label];
  return icon ? `<span aria-hidden="true" style="margin-right:8px;">${icon}</span>` : '';
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

function renderSidebar(allSections) {
  const user = STATE.user;
  const admin = isAdmin();

  const activeDashSec = STATE.page === 'dashboards' ? allSections.find((s) => s.id === STATE.activeDashSection) : null;
  const activeGroup = activeDashSec ? (activeDashSec.nav_group || 'dashboards') : null;

  const campExpanded = !!STATE.navExpanded.campaigns || STATE.page === 'gantt' || activeGroup === 'campaigns';
  const dashExpanded = !!STATE.navExpanded.dashboards || activeGroup === 'dashboards' || STATE.page === 'broadsignPanel' || STATE.page === 'grassfishPanel';
  const pdoohExpanded = !!STATE.navExpanded.pdooh || activeGroup === 'pdooh';

  const maintenanceSection = allSections.find((s) => s.lock_key === 'maintenance') || allSections.find((s) => (s.nav_group || 'dashboards') === 'dashboards');
  const pdoohSection = allSections.find((s) => s.lock_key === 'pdooh') || allSections.find((s) => (s.nav_group || 'dashboards') === 'pdooh');

  const consoleLinksHtml = canView('locations')
    ? navSubItem('Broadsign Console', STATE.page === 'broadsignPanel', 'broadsignPanel') + navSubItem('Grassfish Console', STATE.page === 'grassfishPanel', 'grassfishPanel')
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

  const maintenanceGroup = (canView('dashboards') || canView('locations'))
    ? navParent(NAV_GROUP_LABELS.dashboards, (STATE.page === 'dashboards' && activeGroup === 'dashboards') || STATE.page === 'broadsignPanel' || STATE.page === 'grassfishPanel', dashExpanded, 'dashboards', maintenanceSection ? `App.goToDashGroup('${maintenanceSection.id}')` : "App.setPage('dashboards')")
      + (dashExpanded ? consoleLinksHtml + dashLinksHtml : '')
    : '';

  const bottomItems = NAV_ITEMS_BOTTOM.map((n) => navItem(n.page, n.label)).join('');
  const adminLinks = admin ? navItem('admin', 'Administration') + navItem('settings', 'Settings') : '';

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
  permits: 'Permits',
  metroPic: 'Metro PIC',
  tickets: 'Tickets',
  simCards: 'SIM Cards',
  campaigns: 'Digital Campaigns',
  gantt: 'Campaign Calendar',
  staticCampaigns: 'Static Campaigns',
  dashboards: 'Maintenance Panel',
  admin: 'Administration',
  settings: 'Settings',
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

export function renderShell(innerHtml) {
  const allSections = loadData('dashboardSections', listDashboardSections) || [];
  const title = pageTitle(allSections);
  return `
    <div class="shell">
      ${renderSidebar(allSections)}
      <div class="main">
        <div class="topbar">
          <h1>${esc(title)}</h1>
          <div class="meta">${esc(STATE.user?.name || '')}</div>
        </div>
        <div class="content">${innerHtml}</div>
      </div>
    </div>
  `;
}

export function goToPage(page) {
  setState({ page, modal: null });
}

// Clicking a Maintenance/pDOOH panel group's label in the sidebar: jump to the Dashboards page
// scoped to that section, keeping whichever link (if any) was last active within it.
export function goToDashGroup(sectionId) {
  setState({ page: 'dashboards', activeDashSection: sectionId || null, modal: null });
}

// Clicking a specific nested dashboard link in the sidebar.
export function goToDashLink(sectionId, dashId) {
  setState({ page: 'dashboards', activeDashSection: sectionId, activeDashboard: dashId, modal: null });
}

export function toggleNavExpand(key) {
  setState({ navExpanded: { ...STATE.navExpanded, [key]: !STATE.navExpanded[key] } });
}

export async function doLogout() {
  await logout();
}
