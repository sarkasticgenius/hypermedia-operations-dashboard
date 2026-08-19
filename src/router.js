import { canView, isAdmin, isClientUser } from './auth.js';

// Mirrors the original app's PAGE_AREA gate: null = always visible to any logged-in user,
// 'admin' = admin role required, otherwise the named PERMISSION_AREAS entry must have view=true.
export const PAGE_AREA = {
  opsOverview: null,
  dashboard: null,
  assetsInventory: 'assetsInventory',
  assets: 'assets',
  procurement: 'orders',
  locations: 'locations',
  broadsignPanel: 'maintenancePanels',
  grassfishPanel: 'maintenancePanels',
  iotPanel: 'maintenancePanels',
  permits: 'permits',
  metroPic: 'metroPic',
  tickets: 'tickets',
  simCards: 'simCards',
  campaigns: 'campaigns',
  gantt: 'campaigns',
  staticCampaigns: 'staticCampaigns',
  trafficSheet: 'trafficSheet',
  clientCampaignMonitor: 'clientCampaigns',
  reporting: 'reporting',
  dashboards: 'dashboards',
  workspaceDirectory: 'workspaceDirectory',
  creativeResizer: null,
  admin: 'admin',
  settings: 'admin',
  recycleBin: 'admin',
  account: null,
};

// Filled in by main.js once every page module is imported (avoids a giant static import list
// here that would have to be updated by hand as pages land phase by phase).
const registry = {};
export function registerPage(key, renderFn) {
  registry[key] = renderFn;
}

export function canViewPage(page) {
  // A client-portal login holds no user_permissions rows at all (it's gated by profiles.client_id
  // matching instead, see is_own_client() RLS) - it can only ever view its own monitor page,
  // regardless of what the 'clientCampaigns' permission-area check below would otherwise say.
  if (isClientUser()) return page === 'clientCampaignMonitor';
  const area = PAGE_AREA[page];
  if (area === undefined) return false;
  if (area === null) return true;
  if (area === 'admin') return isAdmin();
  return canView(area);
}

export function renderPage(page) {
  if (!canViewPage(page)) {
    return '<div class="card"><div class="empty">You don\'t have access to this page.</div></div>';
  }
  const fn = registry[page];
  if (!fn) {
    return '<div class="card"><div class="empty">This page hasn\'t been built yet.</div></div>';
  }
  return fn();
}
