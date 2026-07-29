import { STATE, initRender, render, renderToasts, closeModal } from './state.js';
import { initAuth } from './auth.js';
import { renderLogin, doLogin } from './pages/login.js';
import { renderAccount, saveAccountProfile, saveAccountPassword } from './pages/account.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderOpsOverview } from './pages/opsOverview.js';
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
import * as dashboardsPage from './pages/dashboards.js';
import * as adminPage from './pages/admin.js';
import * as settingsPage from './pages/settings.js';
import * as networkPanelsPage from './pages/networkPanels.js';
import * as bulkImportPage from './pages/bulkImport.js';
import { initContractorPortal, renderContractorPortal, bindContractorPortalForm } from './pages/contractorPortal.js';
import { renderShell, goToPage, doLogout } from './shell.js';
import { registerPage, renderPage } from './router.js';
import { renderModalRoot } from './modals.js';

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
registerPage('opsOverview', renderOpsOverview);
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
registerPage('dashboards', dashboardsPage.renderDashboards);
registerPage('admin', adminPage.renderAdmin);
registerPage('settings', settingsPage.renderSettings);
registerPage('broadsignPanel', networkPanelsPage.renderBroadsignPanel);
registerPage('grassfishPanel', networkPanelsPage.renderGrassfishPanel);

// Every inline onclick="App.xyz(...)" in the HTML-string page templates resolves against this
// single global, assembled here from each page module's exported handlers. Keeps the render-
// functions-returning-HTML-strings pattern from the original app instead of rewriting every
// page to addEventListener wiring.
window.App = {
  doLogin,
  logout: doLogout,
  setPage: goToPage,
  closeModal,
  saveAccountProfile,
  saveAccountPassword,
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
  ...dashboardsPage,
  ...adminPage,
  ...settingsPage,
  ...networkPanelsPage,
  ...bulkImportPage,
};

function rootRender() {
  const body = STATE.user ? renderShell(renderPage(STATE.page) + renderModalRoot()) : renderLogin();
  const toasts = renderToasts();
  return body + (toasts ? `<div class="toast-stack">${toasts}</div>` : '');
}

initRender(appEl, rootRender);
appEl.innerHTML = '<div class="page-loading">Loading...</div>';

initAuth();
}
