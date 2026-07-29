import { STATE, setState } from './state.js';
import { canViewPage } from './router.js';
import { isAdmin, logout } from './auth.js';
import { LOGO_IMG } from './logo.js';
import { esc } from './lib/format.js';

const NAV_ITEMS = [
  { page: 'opsOverview', label: 'Live Ops Overview' },
  { page: 'dashboard', label: 'Home' },
  { page: 'assetsInventory', label: 'Asset Inventory' },
  { page: 'assets', label: 'Hardware Inventory' },
  { page: 'procurement', label: 'Procurement' },
  { page: 'locations', label: 'Locations' },
  { page: 'broadsignPanel', label: 'Broadsign Console' },
  { page: 'grassfishPanel', label: 'Grassfish Console' },
  { page: 'permits', label: 'Permits' },
  { page: 'metroPic', label: 'Metro PIC' },
  { page: 'tickets', label: 'Tickets' },
  { page: 'simCards', label: 'SIM Cards' },
  { page: 'campaigns', label: 'Digital Campaigns' },
  { page: 'gantt', label: 'Campaign Calendar' },
  { page: 'staticCampaigns', label: 'Static Campaigns' },
  { page: 'dashboards', label: 'Dashboards' },
];

function navItem(page, label) {
  if (!canViewPage(page)) return '';
  const active = STATE.page === page ? ' active' : '';
  return `<div class="nav-item${active}" onclick="App.setPage('${page}')">${esc(label)}</div>`;
}

function renderSidebar() {
  const user = STATE.user;
  const items = NAV_ITEMS.map((n) => navItem(n.page, n.label)).join('');
  const adminLinks = isAdmin()
    ? navItem('admin', 'Admin') + navItem('settings', 'Settings')
    : '';
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
        ${items}
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
  procurement: 'Procurement',
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
  dashboards: 'Dashboards',
  admin: 'Admin',
  settings: 'Settings',
  account: 'My Account',
};

export function renderShell(innerHtml) {
  const title = PAGE_TITLES[STATE.page] || '';
  return `
    <div class="shell">
      ${renderSidebar()}
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

export async function doLogout() {
  await logout();
}
