import { STATE, initRender, render, renderToasts, closeModal } from './state.js';
import { initAuth } from './auth.js';
import { renderLogin, doLogin, setLoginView, doRequestPasswordReset, renderPasswordRecovery, doSetRecoveredPassword } from './pages/login.js';
import { renderAccount, saveAccountProfile, saveAccountPassword } from './pages/account.js';
import { renderDashboard } from './pages/dashboard.js';
import * as opsOverviewPage from './pages/opsOverview.js';
import * as assetsPage from './pages/assets.js';
import * as assetsInventoryPage from './pages/assetsInventory.js';
import * as locationsPage from './pages/locations.js';
import * as ticketsPage from './pages/tickets.js';
import * as procurementPage from './pages/procurement.js';
import * as permitsPage from './pages/permits.js';
import * as metroPicPage from './pages/metroPic.js';
import * as simCardsPage from './pages/simCards.js';
import * as campaignsPage from './pages/campaigns.js';
import * as ganttPage from './pages/gantt.js';
import * as staticCampaignsPage from './pages/staticCampaigns.js';
import * as trafficSheetPage from './pages/trafficSheet.js';
import * as dashboardsPage from './pages/dashboards.js';
import * as adminPage from './pages/admin.js';
import * as settingsPage from './pages/settings.js';
import * as networkPanelsPage from './pages/networkPanels.js';
import * as bulkImportPage from './pages/bulkImport.js';
import * as recycleBinPage from './pages/recycleBin.js';
import * as clientCampaignMonitorPage from './pages/clientCampaignMonitor.js';
import { initContractorPortal, renderContractorPortal, bindContractorPortalForm } from './pages/contractorPortal.js';
import { renderShell, goToPage, doLogout, goToDashGroup, goToDashLink, goToClientMonitor, goBack, toggleNavExpand, stopImpersonating } from './shell.js';
import { registerPage, renderPage } from './router.js';
import { renderModalRoot } from './modals.js';
import { toggleSort } from './lib/sortableTable.js';
import { toggleTheme } from './theme.js';

const appEl = document.getElementById('app');

// The contractor ticket-closing portal (?portal=close&ticket=<id>) is a standalone, no-login
// flow - it never touches STATE/auth at all, so it gets its own tiny render loop instead of
// going through the main app's router/shell.
if (initContractorPortal()) {
  async function renderPortal() {
    appEl.innerHTML = await renderContractorPortal();
    bindContractorPortalForm(renderPortal);
  }
  renderPortal();
} else {
  bootMainApp();
}

function bootMainApp() {

registerPage('account', renderAccount);
registerPage('dashboard', renderDashboard);
registerPage('opsOverview', opsOverviewPage.renderOpsOverview);
registerPage('assets', assetsPage.renderAssets);
registerPage('assetsInventory', assetsInventoryPage.renderAssetsInventory);
registerPage('locations', locationsPage.renderLocations);
registerPage('tickets', ticketsPage.renderTickets);
registerPage('procurement', procurementPage.renderProcurement);
registerPage('permits', permitsPage.renderPermits);
registerPage('metroPic', metroPicPage.renderMetroPic);
registerPage('simCards', simCardsPage.renderSimCards);
registerPage('campaigns', campaignsPage.renderCampaigns);
registerPage('gantt', ganttPage.renderGantt);
registerPage('staticCampaigns', staticCampaignsPage.renderStaticCampaigns);
registerPage('trafficSheet', trafficSheetPage.renderTrafficSheet);
registerPage('clientCampaignMonitor', clientCampaignMonitorPage.renderClientCampaignMonitor);
registerPage('dashboards', dashboardsPage.renderDashboards);
registerPage('admin', adminPage.renderAdmin);
registerPage('settings', settingsPage.renderSettings);
registerPage('recycleBin', recycleBinPage.renderRecycleBin);
registerPage('broadsignPanel', networkPanelsPage.renderBroadsignPanel);
registerPage('grassfishPanel', networkPanelsPage.renderGrassfishPanel);
registerPage('iotPanel', networkPanelsPage.renderIotPanel);

// Every inline onclick="App.xyz(...)" in the HTML-string page templates resolves against this
// single global, assembled here from each page module's exported handlers. Keeps the render-
// functions-returning-HTML-strings pattern from the original app instead of rewriting every
// page to addEventListener wiring.
window.App = {
  doLogin,
  setLoginView,
  doRequestPasswordReset,
  doSetRecoveredPassword,
  logout: doLogout,
  setPage: goToPage,
  goToDashGroup,
  goToDashLink,
  goToClientMonitor,
  goBack,
  toggleTheme,
  toggleNavExpand,
  stopImpersonating,
  closeModal,
  toggleSort,
  saveAccountProfile,
  saveAccountPassword,
  ...opsOverviewPage,
  ...assetsPage,
  ...assetsInventoryPage,
  ...locationsPage,
  ...ticketsPage,
  ...procurementPage,
  ...permitsPage,
  ...metroPicPage,
  ...simCardsPage,
  ...campaignsPage,
  ...ganttPage,
  ...staticCampaignsPage,
  ...trafficSheetPage,
  ...dashboardsPage,
  ...adminPage,
  ...settingsPage,
  ...networkPanelsPage,
  ...bulkImportPage,
  ...recycleBinPage,
  ...clientCampaignMonitorPage,
};

function rootRender() {
  // Checked before the normal user/renderShell branch - a recovery session (from clicking a
  // password-reset email link) must never silently drop someone straight into the dashboard
  // without setting a new password first, even though Supabase's client does establish a real
  // (recovery-scoped) session for it under the hood.
  const body = STATE.passwordRecoveryMode
    ? renderPasswordRecovery()
    : (STATE.user ? renderShell(renderPage(STATE.page) + renderModalRoot()) : renderLogin());
  const toasts = renderToasts();
  return body + (toasts ? `<div class="toast-stack">${toasts}</div>` : '');
}

initRender(appEl, rootRender);
appEl.innerHTML = '<div class="page-loading">Loading...</div>';

initAuth();
}
