import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { listCategories, addCategory, updateCategory, deleteCategory } from '../data/categories.js';
import { listContractors, saveContractor, deleteContractor } from '../data/contractors.js';
import { listClients, saveClient, deleteClient } from '../data/clients.js';
import { listNetworks, ensureNetwork, renameNetwork, countNetworkUsage, deleteNetwork } from '../data/networks.js';
import { getAllSettings, saveSetting } from '../data/settings.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { invalidateAssetInventoryCaches } from './assetsInventory.js';
import { listLocations } from '../data/locations.js';
import { listCampaigns } from '../data/campaigns.js';
import { listBrandLogos, lookupBrandLogos } from '../data/brandLogos.js';
import { brandNameForLocation } from '../data/locationStats.js';
import { brandNameForVenue, brandFallbackForVenue, isBrandedMetroStation } from './trafficSheet.js';
import { supabase } from '../supabaseClient.js';
import { notifySlack } from '../data/slack.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtDateTime } from '../lib/format.js';
import { brandLogoTag } from '../lib/brandLogo.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { renderTabs } from '../lib/tabs.js';

const TABS = [
  { key: 'categories', label: 'Asset Categories' },
  { key: 'contractors', label: 'Contractors' },
  { key: 'networks', label: 'Screen Networks' },
  { key: 'clients', label: 'Clients' },
  { key: 'integrations', label: 'Integrations' },
];

export function renderSettings() {
  const tab = STATE.settingsTab || 'categories';
  let body;
  if (tab === 'contractors') body = renderContractorsTab();
  else if (tab === 'networks') body = renderNetworksTab();
  else if (tab === 'clients') body = renderClientsTab();
  else if (tab === 'integrations') body = renderIntegrationsTab();
  else body = renderCategoriesTab();
  return `${renderTabs(TABS, tab, 'App.setSettingsTab')}${body}`;
}

export function setSettingsTab(tab) {
  setState({ settingsTab: tab });
}

function renderCategoriesTab() {
  const categories = loadData('categories', listCategories);
  if (categories === null) return loadingCard();
  if (categories?.__error) return loadingCard(categories.__error);
  const rows = categories.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="tcenter">${c.is_rental ? '<span class="badge b-amber">Rental-tracked</span>' : '-'}</td>
      <td>
        <button class="btn-sm" onclick="App.editCategoryModal('${c.id}')">Edit</button>
        <button class="btn-sm" onclick="App.removeCategory('${c.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Asset Categories</h3><div class="desc">Rental-tracked categories (Scaffolding, Spider Lift) show a rental period + maintenance location instead of a warranty date on the Asset form.</div></div>
      <table><thead><tr><th>Name</th><th class="tcenter">Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <button class="btn btn-orange" style="margin-top:14px;" onclick="App.editCategoryModal(null)">+ Add Category</button>
    </div>
  `;
}

export function editCategoryModal(id) {
  const categories = STATE.pageData.categories?.data || [];
  const row = id ? categories.find((c) => c.id === id) : null;
  openModal('category', row || {});
}

export async function saveCategoryForm(event) {
  event.preventDefault();
  const id = document.getElementById('cat-id').value || null;
  const name = document.getElementById('cat-name').value.trim();
  const isRental = document.getElementById('cat-rental').checked;
  try {
    if (id) await updateCategory(id, name, isRental);
    else await addCategory(name, isRental);
    await logAudit(id ? 'Edit category' : 'Add category', name);
    invalidate('categories');
    closeModal();
    toast('Category saved');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeCategory(id) {
  if (!confirm('Move this category to the Recycle Bin?')) return;
  try {
    await deleteCategory(id);
    await logAudit('Delete category', id);
    invalidate('categories');
    closeModal();
    toast('Category deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('category', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Category</h3>
  <form onsubmit="App.saveCategoryForm(event)">
    <input type="hidden" id="cat-id" value="${esc(data.id || '')}">
    <div class="field"><label>Name</label><input id="cat-name" value="${esc(data.name || '')}" required></div>
    <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="cat-rental" style="width:auto;" ${data.is_rental ? 'checked' : ''}> Rental-tracked (Date of Rent + Maintenance Location instead of Warranty)</label>
    <div class="modal-actions">
      ${data.id ? `<button type="button" class="btn-sm" style="color:#c0392b;" onclick="App.removeCategory('${data.id}')">Delete</button>` : ''}
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

function renderContractorsTab() {
  const contractors = loadData('contractors', listContractors);
  const assetInventory = loadData('assetInventory', listAssetInventory);
  if (contractors === null || assetInventory === null) return loadingCard();
  if (contractors?.__error) return loadingCard(contractors.__error);
  if (assetInventory?.__error) return loadingCard(assetInventory.__error);

  const screenCounts = {};
  for (const a of assetInventory) {
    if (a.contractor_id) screenCounts[a.contractor_id] = (screenCounts[a.contractor_id] || 0) + 1;
  }

  const sorted = applySort(contractors, 'contractors', {
    name: (c) => c.name || '', company: (c) => c.company || '', phone: (c) => c.phone || '',
    screens: (c) => screenCounts[c.id] || 0,
  });

  const rows = sorted.map((c) => `
    <tr>
      <td>${brandLogoTag(c.company || c.name)} ${esc(c.name)}</td>
      <td>${esc(c.company || '-')}</td>
      <td class="small">${esc((c.emails || []).join(', ') || '-')}</td>
      <td>${esc(c.phone || '-')}</td>
      <td class="tright">${screenCounts[c.id] || 0}</td>
      <td>
        <button class="btn-sm" onclick="App.editContractorModal('${c.id}')">Edit</button>
        <button class="btn-sm" onclick="App.removeContractorRow('${c.id}','${screenCounts[c.id] || 0}')">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Contractors</h3><div class="desc">Notified by email when a ticket is created for a screen assigned to them. Screen assignment happens on the Asset Inventory edit/bulk-edit form.</div></div>
      <table><thead><tr>${sortTh('contractors', 'name', 'Name')}${sortTh('contractors', 'company', 'Company')}<th>Emails</th>${sortTh('contractors', 'phone', 'Phone')}${sortTh('contractors', 'screens', 'Screens')}<th></th></tr></thead><tbody>${rows}</tbody></table>
      <button class="btn btn-orange" style="margin-top:14px;" onclick="App.editContractorModal(null)">+ Add Contractor</button>
    </div>
  `;
}

export function editContractorModal(id) {
  const contractors = STATE.pageData.contractors?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const row = id ? contractors.find((c) => c.id === id) : null;
  const screenCount = id ? assetInventory.filter((a) => a.contractor_id === id).length : 0;
  openModal('contractor', { ...(row || {}), __screenCount: screenCount });
}

export async function saveContractorForm(event) {
  event.preventDefault();
  const id = document.getElementById('ct-id').value || null;
  const name = document.getElementById('ct-name').value.trim();
  const company = document.getElementById('ct-company').value.trim();
  const emails = document.getElementById('ct-emails').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const phone = document.getElementById('ct-phone').value.trim();
  const notes = document.getElementById('ct-notes').value.trim();
  try {
    await saveContractor({ id, name, company, emails, phone, notes });
    await logAudit(id ? 'Edit contractor' : 'Add contractor', name);
    invalidate('contractors');
    closeModal();
    toast('Contractor saved');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeContractorRow(id, screenCount) {
  const count = Number(screenCount) || 0;
  const msg = count > 0
    ? `This contractor is assigned to ${count} screen(s) in Asset Inventory - moving it to the Recycle Bin will clear that assignment on all of them. Continue?`
    : 'Move this contractor to the Recycle Bin?';
  if (!confirm(msg)) return;
  try {
    await deleteContractor(id);
    await logAudit('Delete contractor', `${id} (${count} screens cleared)`);
    invalidate('contractors');
    invalidateAssetInventoryCaches();
    closeModal();
    toast('Contractor deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('contractor', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Contractor</h3>
  <form onsubmit="App.saveContractorForm(event)">
    <input type="hidden" id="ct-id" value="${esc(data.id || '')}">
    <div class="grid2">
      <div class="field"><label>Name</label><input id="ct-name" value="${esc(data.name || '')}" required></div>
      <div class="field"><label>Company (optional, if different)</label><input id="ct-company" value="${esc(data.company || '')}"></div>
    </div>
    <div class="field"><label>Emails</label><textarea id="ct-emails" rows="2" placeholder="One or more, separated by commas or new lines">${esc((data.emails || []).join(', '))}</textarea>
      <div class="small muted" style="margin-top:4px;">All of these are notified when a ticket is logged against a screen assigned to this contractor.</div>
    </div>
    <div class="field"><label>Phone (optional)</label><input id="ct-phone" value="${esc(data.phone || '')}"></div>
    <div class="field"><label>Notes (optional)</label><textarea id="ct-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      ${data.id ? `<button type="button" class="btn-sm" style="color:#c0392b;" onclick="App.removeContractorRow('${data.id}','${data.__screenCount || 0}')">Delete</button>` : ''}
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

// A Client is which Traffic Sheet venues (exact names, matched case-insensitively - see
// normalizeVenueText in trafficSheet.js) belong to a mall/operator for the Client Campaigns
// Monitor - not to be confused with campaigns.client/static_campaigns.client, which are unrelated
// free-text fields on those tables.
function renderClientsTab() {
  const clients = loadData('clients', listClients);
  if (clients === null) return loadingCard();
  if (clients?.__error) return loadingCard(clients.__error);

  const rows = clients.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="small">${esc((c.venue_names || []).join(', ') || '-')}</td>
      <td>
        <button class="btn-sm" onclick="App.editClientModal('${c.id}')">Edit</button>
        <button class="btn-sm" onclick="App.removeClientRow('${c.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Clients</h3><div class="desc">Powers the Client Campaigns Monitor - a client's restricted login only ever sees campaigns whose venue matches one of the names listed here exactly (case-insensitive).</div></div>
      <table><thead><tr><th>Name</th><th>Venue Names</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3"><div class="empty">No clients yet.</div></td></tr>'}</tbody></table>
      <button class="btn btn-orange" style="margin-top:14px;" onclick="App.editClientModal(null)">+ Add Client</button>
    </div>
  `;
}

export function editClientModal(id) {
  const clients = STATE.pageData.clients?.data || [];
  const row = id ? clients.find((c) => c.id === id) : null;
  openModal('client', row || {});
}

export async function saveClientForm(event) {
  event.preventDefault();
  const id = document.getElementById('cl-id').value || null;
  const name = document.getElementById('cl-name').value.trim();
  const venueNames = document.getElementById('cl-venues').value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    await saveClient({ id, name, venue_names: venueNames });
    await logAudit(id ? 'Edit client' : 'Add client', name);
    invalidate('clients');
    closeModal();
    toast('Client saved');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeClientRow(id) {
  if (!confirm('Move this client to the Recycle Bin? Their login (if any) will no longer see any campaigns until restored.')) return;
  try {
    await deleteClient(id);
    await logAudit('Delete client', id);
    invalidate('clients');
    closeModal();
    toast('Client deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('client', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Client</h3>
  <form onsubmit="App.saveClientForm(event)">
    <input type="hidden" id="cl-id" value="${esc(data.id || '')}">
    <div class="field"><label>Name</label><input id="cl-name" value="${esc(data.name || '')}" required></div>
    <div class="field"><label>Venue Names</label><textarea id="cl-venues" rows="4" placeholder="One exact Traffic Sheet venue name per line">${esc((data.venue_names || []).join('\n'))}</textarea>
      <div class="small muted" style="margin-top:4px;">Must match the venue name(s) exactly as they appear in Traffic Sheet (case doesn't matter). One per line.</div>
    </div>
    <div class="modal-actions">
      ${data.id ? `<button type="button" class="btn-sm" style="color:#c0392b;" onclick="App.removeClientRow('${data.id}')">Delete</button>` : ''}
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

function renderNetworksTab() {
  const networks = loadData('networks', listNetworks);
  if (networks === null) return loadingCard();
  if (networks?.__error) return loadingCard(networks.__error);
  const rows = networks.map((n) => `
    <tr>
      <td>${esc(n.name)}</td>
      <td>
        <button class="btn-sm" onclick="App.editNetworkModal('${n.id}')">Edit</button>
        <button class="btn-sm" onclick="App.removeNetworkRow('${n.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Screen Networks</h3><div class="desc">The list of networks selectable on each Asset Inventory screen (also addable directly from that form).</div></div>
      <table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="2"><div class="empty">No networks yet.</div></td></tr>'}</tbody></table>
      <button class="btn btn-orange" style="margin-top:14px;" onclick="App.editNetworkModal(null)">+ Add Network</button>
    </div>
  `;
}

export function editNetworkModal(id) {
  const networks = STATE.pageData.networks?.data || [];
  const row = id ? networks.find((n) => n.id === id) : null;
  openModal('network', row || {});
}

export async function saveNetworkForm(event) {
  event.preventDefault();
  const id = document.getElementById('net-id').value || null;
  const name = document.getElementById('net-name').value.trim();
  try {
    if (id) await renameNetwork(id, name);
    else await ensureNetwork(name);
    await logAudit(id ? 'Rename network' : 'Add network', name);
    invalidate('networks');
    invalidateAssetInventoryCaches();
    closeModal();
    toast('Network saved');
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeNetworkRow(id) {
  try {
    const count = await countNetworkUsage(id);
    const msg = count > 0
      ? `${count} screen(s) in Asset Inventory are tagged with this network - moving it to the Recycle Bin will remove that tag from all of them. Continue?`
      : 'Move this network to the Recycle Bin?';
    if (!confirm(msg)) return;
    await deleteNetwork(id);
    await logAudit('Delete network', `${id} (${count} screens untagged)`);
    invalidate('networks');
    invalidateAssetInventoryCaches();
    closeModal();
    toast('Network deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('network', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} Network</h3>
  <form onsubmit="App.saveNetworkForm(event)">
    <input type="hidden" id="net-id" value="${esc(data.id || '')}">
    <div class="field"><label>Name</label><input id="net-name" value="${esc(data.name || '')}" required></div>
    <div class="modal-actions">
      ${data.id ? `<button type="button" class="btn-sm" style="color:#c0392b;" onclick="App.removeNetworkRow('${data.id}')">Delete</button>` : ''}
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

function integrationField(settings, key, label, fields, testFunctionName) {
  const cfg = settings[key] || {};
  const testing = STATE[`testing_${key}`];
  return `
    <div class="card">
      <div class="card-head"><h3>${esc(label)}</h3></div>
      <form onsubmit="App.saveIntegrationForm(event,'${key}')">
        ${fields.map((f) => `
          <div class="field"><label>${esc(f.label)}</label>
            ${f.type === 'checkbox'
              ? `<label style="display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="int-${key}-${f.name}" style="width:auto;" ${cfg[f.name] ? 'checked' : ''}> Enabled</label>`
              : `<input id="int-${key}-${f.name}" type="${f.type || 'text'}" value="${esc(cfg[f.name] ?? '')}">`}
          </div>
        `).join('')}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          ${testFunctionName ? `<button type="button" class="btn-outline btn-sm" ${testing ? 'disabled' : ''} onclick="App.testIntegration('${testFunctionName}','${key}')">${testing ? 'Testing...' : 'Test'}</button>` : ''}
          ${cfg.lastSync ? `<span class="small muted">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
        </div>
        ${cfg.lastSyncSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSyncSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
      </form>
    </div>
  `;
}

function broadsignEndpointPreview(baseUrl, domainId) {
  const base = (baseUrl || 'https://api.broadsign.com').replace(/\/+$/, '');
  const domainPart = domainId ? '••••••••' : '&lt;Domain ID&gt;';
  return `Endpoint called: GET ${esc(base)}/rest/monitor_poll/v2?domain_id=${domainPart} (with an <code>authorization: Bearer &lt;API Key&gt;</code> header)`;
}

// Direct DOM update, not a setState() re-render (same reasoning as the other onXChange handlers
// in this file) - this fires on every keystroke, so the Base URL field just looked unresponsive
// before: it *was* accepting input, the endpoint preview below it just never reflected what was
// typed until Save, since it read from the saved settings, not the live field.
export function updateBroadsignEndpointPreview(value) {
  const el = document.getElementById('bs-endpoint-preview');
  if (!el) return;
  const settings = STATE.pageData.settings?.data || {};
  el.innerHTML = broadsignEndpointPreview(value, settings.broadsignApi?.domainId);
}

// Broadsign's monitor_status integer codes are undocumented (Broadsign's own docs show an
// example value but never publish what any code means) - guessing that mapping would silently
// invert every screen's status. So this card is two-stage: "Sync Now" first just reports the raw
// monitor_status histogram seen among matched screens (below), then once "Offline Status Values"
// is set (comparing that histogram against screens you know are actually down), subsequent syncs
// apply real online/offline status. See supabase/functions/broadsign-sync for the sync logic.
function renderBroadsignApiCard(settings) {
  const cfg = settings.broadsignApi || {};
  const testing = STATE.testing_broadsignApi;
  const rawCounts = cfg.lastRawStatusCounts || {};
  const rawCountsHtml = Object.keys(rawCounts).length
    ? `<div class="small muted" style="margin-top:6px;">Last raw monitor_status counts (matched screens only): ${Object.keys(rawCounts).map((k) => `${esc(k)} (${rawCounts[k]}x)`).join(', ')}</div>`
    : '';
  const missingHtml = (cfg.lastMissingFromApi || []).length
    ? `<div class="small muted" style="margin-top:2px;">${cfg.lastMissingFromApi.length} inventory Player Box ID(s) had no data back from the API last sync.</div>` : '';
  return `
    <div class="card">
      <div class="card-head"><h3>Broadsign API</h3><div class="desc">Real monitor_poll/v2 sync, matched to Asset Inventory rows tagged Player Type "Broadsign" by Player Box ID.</div></div>
      <form onsubmit="App.saveIntegrationForm(event,'broadsignApi')">
        <div class="field"><label>Base URL</label><input id="int-broadsignApi-baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="https://api.broadsign.com" oninput="App.updateBroadsignEndpointPreview(this.value)"></div>
        <div id="bs-endpoint-preview" class="small muted" style="margin:-6px 0 10px;font-family:monospace;">${broadsignEndpointPreview(cfg.baseUrl, cfg.domainId)}</div>
        <div class="grid2">
          <div class="field"><label>API Key</label><input id="int-broadsignApi-apiKey" type="password" value="${esc(cfg.apiKey || '')}"></div>
          <div class="field"><label>Domain ID</label><input id="int-broadsignApi-domainId" type="password" autocomplete="off" value="${esc(cfg.domainId || '')}"></div>
        </div>
        <div class="field"><label>Offline Status Values</label>
          <input id="int-broadsignApi-offlineStatusValues" value="${esc(cfg.offlineStatusValues || '')}" placeholder="e.g. 2,3">
          <div class="small muted" style="margin-top:4px;">Comma-separated raw monitor_status codes that mean "offline". Leave blank and run Test/Sync Now once first - it'll log the raw values it actually saw below, then compare those against screens you know are online/offline before filling this in.</div>
        </div>
        <div class="field"><label>Missing in Action Status Values</label>
          <input id="int-broadsignApi-missingInActionStatusValues" value="${esc(cfg.missingInActionStatusValues || '')}" placeholder="e.g. 2">
          <div class="small muted" style="margin-top:4px;">A subset of the offline codes above that specifically mean "Missing in Action" (never heard from / long overdue) rather than a generic "Offline". Leave blank to label every offline screen just "Offline".</div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="int-broadsignApi-enabled" style="width:auto;" ${cfg.enabled ? 'checked' : ''}> Enabled</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${testing ? 'disabled' : ''} onclick="App.testIntegration('broadsign-sync','broadsignApi')">${testing ? 'Testing...' : 'Test / Sync Now'}</button>
          ${cfg.lastSync ? `<span class="small muted">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
        </div>
        ${cfg.lastSyncSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSyncSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
        ${rawCountsHtml}
        ${missingHtml}
      </form>
    </div>
  `;
}

// Reverse-engineered live against the real tenant (see supabase/functions/grassfish-sync for the
// full three-step flow: locationlist/init -> locations/list -> per-item locations/{Id} detail).
// "BoxIsOnline" is a real, unambiguous boolean field, so unlike Broadsign's undocumented
// monitor_status codes this needs no raw-sample calibration - just Base URL + API Key. Runs
// automatically every 20 minutes via a pg_cron job (migration 0014) in addition to Test/Sync Now.
function renderGrassfishApiCard(settings) {
  const cfg = settings.grassfishApi || {};
  const testing = STATE.testing_grassfishApi;
  const missingHtml = (cfg.lastMissingFromApi || []).length
    ? `<div class="small muted" style="margin-top:2px;">${cfg.lastMissingFromApi.length} matched Box ID(s) failed to respond last sync.</div>` : '';
  return `
    <div class="card">
      <div class="card-head"><h3>Grassfish API</h3><div class="desc">Matched to Asset Inventory rows tagged Player Type "Grassfish" by Player Box ID. Runs automatically every 20 minutes, plus on demand below.</div></div>
      <form onsubmit="App.saveIntegrationForm(event,'grassfishApi')">
        <div class="field"><label>Base URL</label><input id="int-grassfishApi-baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="https://your-tenant.grassfish.tv"></div>
        <div class="field"><label>API Key</label><input id="int-grassfishApi-apiKey" type="password" value="${esc(cfg.apiKey || '')}"></div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="int-grassfishApi-enabled" style="width:auto;" ${cfg.enabled ? 'checked' : ''}> Enabled</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${testing ? 'disabled' : ''} onclick="App.testIntegration('grassfish-sync','grassfishApi')">${testing ? 'Testing...' : 'Test / Sync Now'}</button>
          ${cfg.lastSync ? `<span class="small muted">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
        </div>
        ${cfg.lastSyncSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSyncSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
        ${missingHtml}
      </form>
    </div>
  `;
}

// aioo IoT Admin Console - both endpoints are confirmed live: POST .../auth with
// username/password returns a token, then GET the Device List Path with that token in a
// "User-Token" header (not Authorization: Bearer) returns {"result":[...]}. Always shows the
// fleet-wide "Devices by platform/state/camera type/version" breakdown on the IoT Panel.
// Connectivity (online/offline, for both the "Devices by ..." breakdown and the per-Location
// heatmap) is computed from status.ts staleness, not a raw-state allowlist - confirmed against
// real data that status.state never actually contains "Offline" (a device offline for 16+ hours
// just freezes at whatever analytics state it was last in), so there's nothing to calibrate;
// "Stale After" below only needs changing if the fleet's normal check-in cadence turns out to be
// longer than 30 minutes (see iot-sync's header comment for the real-data gap that default sits in).
function renderIotApiCard(settings) {
  const cfg = settings.iotApi || {};
  const testing = STATE.testing_iotApi;
  const rawCounts = (cfg.deviceBreakdown && cfg.deviceBreakdown.byState) || {};
  const rawCountsHtml = Object.keys(rawCounts).length
    ? `<div class="small muted" style="margin-top:6px;">Last device state counts: ${Object.keys(rawCounts).map((k) => `${esc(k)} (${rawCounts[k]}x)`).join(', ')}</div>`
    : '';
  return `
    <div class="card">
      <div class="card-head"><h3>IoT Admin Console (aioo)</h3><div class="desc">Logs in via POST /aioo_iot_admin_console/web_api/api/v1/auth, then pulls the device list from the Device List Path, matched to Asset Inventory rows tagged Player Type "IoT" by Player Box ID. Shows on the IoT Panel below Grassfish Console.</div></div>
      <form onsubmit="App.saveIntegrationForm(event,'iotApi')">
        <div class="field"><label>Base URL</label><input id="int-iotApi-baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="https://iotadmin.eu.aiootech.com"></div>
        <div class="grid2">
          <div class="field"><label>Username</label><input id="int-iotApi-username" value="${esc(cfg.username || '')}"></div>
          <div class="field"><label>Password</label><input id="int-iotApi-password" type="password" value="${esc(cfg.password || '')}"></div>
        </div>
        <div class="field"><label>Device List Path</label>
          <input id="int-iotApi-devicePath" value="${esc(cfg.devicePath || '')}" placeholder="/aioo_iot_admin_console/web_api/api/v1/device">
          <div class="small muted" style="margin-top:4px;">Leave blank to use the default above. Sent as GET with a "User-Token" header (not Authorization).</div>
        </div>
        <div class="field"><label>API Key</label>
          <input id="int-iotApi-apiKey" type="password" value="${esc(cfg.apiKey || '')}">
          <div class="small muted" style="margin-top:4px;">Stored for when aioo issues a key-based auth path - not used by the sync yet, which still logs in with Username/Password above.</div>
        </div>
        <div class="field"><label>Stale After (minutes)</label>
          <input id="int-iotApi-staleAfterMinutes" type="number" min="1" value="${esc(cfg.staleAfterMinutes || '30')}">
          <div class="small muted" style="margin-top:4px;">A device counts as Offline once it's gone longer than this without checking in (status.ts vs now) - not based on its reported State, which stays frozen at whatever it was last doing rather than switching to "Offline". Default of 30 minutes is well clear of real check-in cadence (confirmed: online devices check in every 1-2 minutes; genuinely down ones are stale by 11+ hours).</div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="int-iotApi-enabled" style="width:auto;" ${cfg.enabled ? 'checked' : ''}> Enabled</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${testing ? 'disabled' : ''} onclick="App.testIntegration('iot-sync','iotApi')">${testing ? 'Testing...' : 'Test / Sync Now'}</button>
          ${cfg.lastSync ? `<span class="small muted">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
        </div>
        ${cfg.lastSyncSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSyncSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
        ${rawCountsHtml}
      </form>
    </div>
  `;
}

// Inverted from every other card on this tab: those pull FROM a vendor API on our schedule, this
// one accepts a PUSH from scripts/workspace-directory-agent.ps1 running on each PC, authenticated
// by this shared secret (x-agent-secret header) rather than an API key we're calling out with -
// see supabase/functions/workspace-directory-checkin. The download button bakes the current
// secret, this project's Supabase URL, and its anon key (safe to embed - already public in the
// deployed bundle, access is enforced by RLS/the secret check, not by hiding it) directly into
// the generated script, so there's no separate "enter these 3 values" step on each PC.
//
// The installed script itself is a small, fixed outer shell (elevate, register the scheduled
// task, fetch-and-run, POST); WHAT it collects lives in the Data Collector Script below instead,
// fetched fresh by every agent on every run from workspace-directory-collector. Editing that
// textarea and hitting Save is how new fields (another remote-access tool, a new "problem" check,
// etc.) reach every already-installed PC without re-visiting any of them.
function renderWorkspaceDirectoryAgentCard(settings) {
  const cfg = settings.workspaceDirectoryAgent || {};
  const collector = settings.workspaceDirectoryCollector || {};
  const collectorScript = collector.script || defaultCollectorScript();
  const optimizer = settings.workspaceDirectoryOptimizerScript || {};
  const optimizerScript = optimizer.script || defaultOptimizerScript();
  const shell = settings.workspaceDirectoryAgentShell || {};
  const canary = settings.workspaceDirectoryAgentShellCanary || {};
  return `
    <div class="card">
      <div class="card-head"><h3>Jstar Agent</h3><div class="desc">Our own lightweight PC inventory agent (hostname, IP, AnyDesk/TeamViewer ID, Broadsign Player ID/Grassfish Box ID, OS, logged-in user, disk volumes, hardware, antivirus status, installed software, detected problems). The Broadsign/Grassfish ID matches this PC to the same screen in those Consoles (by Player Box ID, same as those syncs already use), so each side can link to the other's AnyDesk/TeamViewer or screen info. Fully headless by design - no tray icon, window, or notification ever appears, since these PCs drive signage screens. Generate a secret, save, then run the .bat as Administrator on each PC once (double-clicking the .ps1 directly just opens it in Notepad - Windows' default for script files). After that one install, every agent self-updates from Published Agent Version below - PCs in remote locations never need a physical reinstall again, including for a secret rotation (the old secret stays valid for 72 hours after rotating so already-installed PCs have a window to self-update onto the new one).</div></div>
      <form onsubmit="App.saveWorkspaceDirectoryAgentForm(event)">
        <div class="field"><label>Shared Agent Secret</label>
          <div style="display:flex;gap:8px;">
            <input id="int-wda-secret" type="password" autocomplete="off" value="${esc(cfg.secret || '')}" style="flex:1;">
            <button type="button" class="btn-outline btn-sm" onclick="App.generateWorkspaceDirectorySecret()">Generate</button>
          </div>
          <div class="small muted" style="margin-top:4px;">Every agent sends this in an x-agent-secret header instead of signing in as a user. Rotating it keeps the OLD value working for 72 hours, so every already-installed PC has time to self-update onto the new one on its own - no reinstall needed.${cfg.previousSecretExpiresAt && new Date(cfg.previousSecretExpiresAt) > new Date() ? ` <b>Old secret still accepted until ${fmtDateTime(cfg.previousSecretExpiresAt)}.</b>` : ''}</div>
        </div>
        <div class="field"><label>Client Uninstall Password</label>
          <input id="int-wda-uninstall-password" type="password" autocomplete="new-password" placeholder="${cfg.uninstallPasswordHash ? 'Set - leave blank to keep it' : 'Not set yet - required before a PC can be uninstalled'}">
          <div class="small muted" style="margin-top:4px;">Whoever runs the Uninstall Launcher on a PC has to enter this to actually remove the agent - stops a store/office employee from just deleting it themselves. Only its hash is saved and baked into the installed agent, never the password itself, so save it somewhere you can read it back later (a password manager, not this field) - there's no way to recover it from here once saved.${cfg.uninstallPasswordHash ? '' : ' Set one, Save, then Publish Latest Agent Version so already-installed PCs pick it up too.'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? '' : 'disabled title="Save a secret first"'} onclick="App.downloadWorkspaceDirectoryAgentScript()">Download Install Script (.ps1)</button>
          <button type="button" class="btn-outline btn-sm" onclick="App.downloadWorkspaceDirectoryAgentBatch()">Download Launcher (.bat)</button>
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? '' : 'disabled title="Save a secret first"'} onclick="App.downloadWorkspaceDirectoryAgentUninstallBatch()">Download Uninstall Launcher (.bat)</button>
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? 'title="Copies a single PowerShell line to your clipboard - paste it into a PowerShell window on the target PC (e.g. over AnyDesk), or feed it to another tool that runs PowerShell commands remotely. Always fetches whatever\'s currently published, live. The install itself runs hidden and the shell running this line always closes itself afterward - nothing to close or type exit on."' : 'disabled title="Save a secret first"'} onclick="App.copyWorkspaceDirectoryInstallCommand()">Copy One-Line Install Command</button>
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? 'title="Same install as the line above, base64-encoded so the secret/URL/agent name are not readable at a glance - useful when the command is visible on screen or held by another tool. Runs in whatever shell it is pasted/typed into (same as the plain line, just opaque), so it self-closes there too. Not hidden from Task Manager, EDR, or PowerShell logging - only from someone eyeballing the raw text."' : 'disabled title="Save a secret first"'} onclick="App.copyWorkspaceDirectoryEncodedInstallCommand()">Copy Short/Encoded Install Command</button>
        </div>
      </form>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border);">
      <div class="field">
        <label>Published Agent Version</label>
        <div class="small muted" style="margin-bottom:6px;">The install script (scheduled task setup, remote-command runner, self-update logic itself) - unlike the Data Collector Script below, this normally requires re-running the installer to change. Publishing pushes the CURRENT version of that logic here; an already-installed agent compares itself against it on each check-in and silently updates itself if different, no physical reinstall needed.<br><br><b>Publishing is a two-step rollout.</b> The first button reaches ONLY the test PCs (${AGENT_CANARY_HOSTNAMES.join(', ')}) - every other machine keeps running the fleet version, untouched. Once you have confirmed the new build behaves on those, the second button rolls that exact same script out to everything else. This exists because most of the fleet drives signage screens in malls that nobody can walk up to and fix.</div>
        <div class="small" style="margin-bottom:8px;display:flex;flex-direction:column;gap:2px;">
          <span><b>Fleet (all PCs):</b> ${shell.version ? `v${shell.version}${shell.publishedAt ? ` - ${fmtDateTime(shell.publishedAt)}` : ''}` : '<span class="muted">nothing published yet</span>'}</span>
          <span><b>Test PCs:</b> ${canary.version ? `v${canary.version}${canary.publishedAt ? ` - ${fmtDateTime(canary.publishedAt)}` : ''}${canary.version > (shell.version || 0) ? ' <span class="badge b-amber">awaiting promotion</span>' : ' <span class="muted">(same as fleet)</span>'}` : '<span class="muted">nothing published yet</span>'}</span>
        </div>
        ${shell.frozen ? `<div class="small" style="margin-bottom:8px;padding:8px 10px;border-radius:6px;background:var(--row-alt);border-left:3px solid #c0392b;"><b>Fleet updates are frozen.</b> Every PC except the test machines (${AGENT_CANARY_HOSTNAMES.join(', ')}) is pinned to v${shell.frozenAtVersion ?? shell.version ?? 0} and will not self-update, even if a newer version is published. The test PCs are unaffected.${shell.frozenAt ? ` Frozen ${fmtDateTime(shell.frozenAt)}.` : ''}</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? '' : 'disabled title="Save a secret first"'} onclick="App.publishWorkspaceDirectoryAgentShell()">Publish to Test PCs</button>
          <button type="button" class="btn-outline btn-sm" ${shell.frozen ? 'disabled title="Fleet updates are frozen - unfreeze first"' : (canary.version && canary.version > (shell.version || 0) ? '' : 'disabled title="Publish to the test PCs first, and confirm it works there"')} onclick="App.promoteWorkspaceDirectoryAgentShell()">Roll Out to All PCs${canary.version && canary.version > (shell.version || 0) ? ` (v${canary.version})` : ''}</button>
          <button type="button" class="btn-outline btn-sm" onclick="App.toggleWorkspaceFleetUpdateFreeze(${shell.frozen ? 'false' : 'true'})">${shell.frozen ? 'Unfreeze Fleet Updates' : 'Freeze Fleet Updates'}</button>
        </div>
      </div>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border);">
      <form onsubmit="App.saveWorkspaceDirectoryCollectorForm(event)">
        <div class="field"><label>Data Collector Script (PowerShell)</label>
          <textarea id="int-wda-collector" rows="14" style="min-height:280px;font-family:monospace;font-size:12px;">${esc(collectorScript)}</textarea>
          <div class="small muted" style="margin-top:4px;">Runs on every PC on every check-in (every 6 hours), fetched fresh - no re-install needed to roll out a change. Must end with a single hashtable as its last expression (the fields the Digital Directory page reads); see the built-in default above for the exact shape. If this fails to fetch or throws, each agent falls back to the same default logic baked into the installed script, so a bad edit here degrades gracefully rather than breaking check-ins.${collector.version ? ` Current version: ${collector.version}.` : ''}</div>
        </div>
        <button class="btn btn-orange" type="submit">Save Collector Script</button>
        <button type="button" class="btn-outline btn-sm" onclick="App.resetWorkspaceDirectoryCollector()">Reset to Default</button>
      </form>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border);">
      <form onsubmit="App.saveWorkspaceDirectoryOptimizerScriptForm(event)">
        <div class="field"><label>Signage PC Optimizer Script (PowerShell)</label>
          <textarea id="int-wda-optimizer" rows="14" style="min-height:280px;font-family:monospace;font-size:12px;">${esc(optimizerScript)}</textarea>
          <div class="small muted" style="margin-top:4px;">Queued on demand from the "Optimize" action on a device, not run automatically like the collector above - it runs once, whenever someone clicks it, as SYSTEM (same as any Run Command; no elevation prompt to worry about even though the script says "Run as Administrator"). Edit and Save here any time you want to add another step - every future click of Optimize picks up whatever is currently saved, no reinstall needed.${optimizer.version ? ` Current version: ${optimizer.version}.` : ''}</div>
        </div>
        <button class="btn btn-orange" type="submit">Save Optimizer Script</button>
        <button type="button" class="btn-outline btn-sm" onclick="App.resetWorkspaceDirectoryOptimizerScript()">Reset to Default</button>
      </form>
    </div>
  `;
}

export function generateWorkspaceDirectorySecret() {
  const el = document.getElementById('int-wda-secret');
  if (el) el.value = crypto.randomUUID().replace(/-/g, '');
}

// Only the hash is ever persisted/embedded in the installed script - the plaintext password
// itself never leaves this form (not saved to app_settings, not sent anywhere but through
// SubtleCrypto locally), so there's deliberately no way to display or recover it later from here.
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// How long a rotated-out secret keeps authenticating after a rotation. Every already-installed
// agent is still running with the OLD secret hardcoded into its script text - it needs to
// authenticate at least once more (its very next self-update poll) to receive a build with the
// NEW secret baked in. Without a grace window, rotating locks every PC out of self-update
// simultaneously: the very request that would deliver the new secret is itself rejected because
// the old one it's sending no longer validates. See the matching check in every edge function that
// reads x-agent-secret (workspace-directory-checkin/-agent-shell/-collector/-force-status).
const AGENT_SECRET_GRACE_HOURS = 72;

export async function saveWorkspaceDirectoryAgentForm(event) {
  event.preventDefault();
  const secret = document.getElementById('int-wda-secret').value.trim();
  if (!secret) { toast('Generate or enter a secret first', 'error'); return; }
  const uninstallPasswordInput = document.getElementById('int-wda-uninstall-password').value.trim();
  const settings = STATE.pageData.settings?.data || {};
  const existing = settings.workspaceDirectoryAgent || {};
  const uninstallPasswordHash = uninstallPasswordInput
    ? await sha256Hex(uninstallPasswordInput)
    : (existing.uninstallPasswordHash || null);
  // Only stash a NEW previous-secret window when the value actually changed - saving the form
  // unchanged (e.g. just to update the uninstall password) must not keep resetting an already-
  // running grace window back to a fresh 72 hours every time.
  const rotated = !!existing.secret && existing.secret !== secret;
  const payload = {
    secret,
    uninstallPasswordHash,
    previousSecret: rotated ? existing.secret : (existing.previousSecret || null),
    previousSecretExpiresAt: rotated
      ? new Date(Date.now() + AGENT_SECRET_GRACE_HOURS * 60 * 60 * 1000).toISOString()
      : (existing.previousSecretExpiresAt || null),
  };
  try {
    await saveSetting('workspaceDirectoryAgent', payload);
    await logAudit('Save integration settings', rotated ? 'workspaceDirectoryAgent (secret rotated - old value stays valid 72h)' : 'workspaceDirectoryAgent');
    invalidate('settings');
    toast(rotated ? `Secret rotated. The old value still works until ${fmtDateTime(payload.previousSecretExpiresAt)} so already-installed PCs can self-update onto the new one.` : 'Settings saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveWorkspaceDirectoryCollectorForm(event) {
  event.preventDefault();
  const script = document.getElementById('int-wda-collector').value;
  const settings = STATE.pageData.settings?.data || {};
  const version = (settings.workspaceDirectoryCollector?.version || 0) + 1;
  try {
    await saveSetting('workspaceDirectoryCollector', { script, version });
    await logAudit('Save Digital Directory collector script', `v${version}`);
    invalidate('settings');
    toast(`Collector script saved (v${version}) - every PC picks it up on its next check-in.`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export function resetWorkspaceDirectoryCollector() {
  const el = document.getElementById('int-wda-collector');
  if (el) el.value = defaultCollectorScript();
}

export async function saveWorkspaceDirectoryOptimizerScriptForm(event) {
  event.preventDefault();
  const script = document.getElementById('int-wda-optimizer').value;
  const settings = STATE.pageData.settings?.data || {};
  const version = (settings.workspaceDirectoryOptimizerScript?.version || 0) + 1;
  try {
    await saveSetting('workspaceDirectoryOptimizerScript', { script, version });
    await logAudit('Save Digital Directory optimizer script', `v${version}`);
    invalidate('settings');
    toast(`Optimizer script saved (v${version}) - the Optimize action on any device now queues this version.`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export function resetWorkspaceDirectoryOptimizerScript() {
  const el = document.getElementById('int-wda-optimizer');
  if (el) el.value = defaultOptimizerScript();
}

// Publishes the CURRENTLY-DEPLOYED outer shell (this build's buildWorkspaceDirectoryAgentScript
// output) to app_settings, keyed by hostname-agnostic content since the shell is identical for
// every PC using the current secret. Every already-installed agent fetches this on its own next
// check-in and self-updates if different (see Invoke-SelfUpdate in the shell template) - this is
// the "centralized deployment" half of the feature; the Data Collector Script above is the other
// half and already worked this way from day one.
// The PCs a Publish is allowed to reach. Deliberately a small, explicit list rather than a
// percentage or a "first N devices" rule: which machines are safe to break is a judgement about
// physical access (an office test bench you can walk over to) and business impact (not a signage
// screen in a mall), and nothing in the device data expresses that.
export const AGENT_CANARY_HOSTNAMES = ['HM-OFFICE-TEST'];

// Publishes to the TEST PCs only (see AGENT_CANARY_HOSTNAMES). Writes the canary slot, which
// workspace-directory-agent-shell serves only to those hostnames - every other device keeps
// running whatever is in the stable slot, untouched, until someone promotes it.
export async function publishWorkspaceDirectoryAgentShell() {
  const settings = STATE.pageData.settings?.data || {};
  const secret = settings.workspaceDirectoryAgent?.secret;
  if (!secret) { toast('Save a secret first', 'error'); return; }
  const script = buildWorkspaceDirectoryAgentScript(secret, settings.workspaceDirectoryAgent?.uninstallPasswordHash);
  // Versioned above BOTH slots so a canary is always numerically newer than the stable build it is
  // being tested against - the agent's own self-update compares versions, so a canary sharing or
  // trailing stable's number would simply never install.
  const version = Math.max(
    settings.workspaceDirectoryAgentShell?.version || 0,
    settings.workspaceDirectoryAgentShellCanary?.version || 0,
  ) + 1;
  try {
    await saveSetting('workspaceDirectoryAgentShellCanary', {
      script, version, hostnames: AGENT_CANARY_HOSTNAMES, publishedAt: new Date().toISOString(),
    });
    await logAudit('Publish Jstar Agent version (test PCs)', `v${version} -> ${AGENT_CANARY_HOSTNAMES.join(', ')}`);
    invalidate('settings');
    toast(`Agent v${version} published to ${AGENT_CANARY_HOSTNAMES.length} test PC(s) only - the rest of the fleet is unchanged.`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Promotes whatever is currently on the test PCs to the whole fleet - the deliberate second step,
// so reaching every signage PC is always an explicit decision rather than a side effect of
// publishing. Copies the canary script verbatim rather than rebuilding from source, so what the
// fleet receives is byte-identical to what was actually tested.
// Pins every non-test PC to the agent version it is already running, so nothing reaches the fleet
// until an admin explicitly lifts it - a hold that survives someone later hitting Publish or Roll
// Out, rather than relying on nobody clicking. Enforced at the endpoint too (see
// workspace-directory-agent-shell): a frozen fleet is served its pinned version, so agents see no
// difference and never even download a script. The test PCs keep updating normally, which is the
// whole point - work continues on them while the fleet holds still.
export async function toggleWorkspaceFleetUpdateFreeze(freeze) {
  const settings = STATE.pageData.settings?.data || {};
  const shell = settings.workspaceDirectoryAgentShell || {};
  if (!shell.version) { toast('Nothing has been published yet, so there is nothing to freeze.', 'error'); return; }
  try {
    await saveSetting('workspaceDirectoryAgentShell', {
      ...shell,
      frozen: !!freeze,
      // Captured at freeze time so the pin is to what the fleet is ACTUALLY running now, not to
      // whatever version happens to be current later on.
      frozenAtVersion: freeze ? shell.version : null,
      frozenAt: freeze ? new Date().toISOString() : null,
    });
    await logAudit(freeze ? 'Freeze Digital Directory fleet updates' : 'Unfreeze Digital Directory fleet updates', freeze ? `pinned at v${shell.version}` : '');
    invalidate('settings');
    toast(freeze ? `Fleet frozen at v${shell.version} - only the test PCs will update.` : 'Fleet updates resumed.');
    setState({});
  } catch (e) { toast(e.message || 'Could not change the freeze state', 'error'); }
}

export async function promoteWorkspaceDirectoryAgentShell() {
  const settings = STATE.pageData.settings?.data || {};
  const canary = settings.workspaceDirectoryAgentShellCanary;
  if (!canary?.script) { toast('Publish to the test PCs first - there is nothing to promote.', 'error'); return; }
  if (!confirm(`Roll agent v${canary.version} out to EVERY PC in the fleet?\n\nIt is currently running on: ${(canary.hostnames || []).join(', ')}`)) return;
  try {
    await saveSetting('workspaceDirectoryAgentShell', {
      script: canary.script, version: canary.version, publishedAt: new Date().toISOString(),
    });
    await logAudit('Promote Jstar Agent version to all PCs', `v${canary.version}`);
    invalidate('settings');
    toast(`Agent v${canary.version} promoted - every PC self-updates on its next check-in.`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// The default/fallback collector, used both as (a) the pre-filled Data Collector Script textarea
// value and (b) baked directly into the installed agent as Invoke-DefaultCollector, so day-one
// installs (and any run where fetching the remote version fails) still work. Ends with a single
// hashtable literal - its shape is exactly the workspace-directory-checkin request body.
// Shared between the Data Collector Script (whose "anydeskInstalls" field the dashboard's Set
// AnyDesk Password modal reads to offer a target) and the outer agent shell's own
// Set-AnyDeskPassword (which needs the exact same list to find which install a given id belongs
// to). These are two INDEPENDENTLY fetched PowerShell documents at runtime - the collector via
// workspace-directory-collector, the shell via workspace-directory-agent-shell - so a function
// defined inside one's text was NOT visible to the other. Confirmed live: Set-AnyDeskPassword
// calling Get-AnyDeskInstalls (previously only defined here, inside the collector script's own
// text) threw "The term 'Get-AnyDeskInstalls' is not recognized" on every single attempt, silently
// swallowed by Invoke-PollCycle's own empty catch block - meaning no AnyDesk password change sent
// from the dashboard had EVER actually applied, on any device, since the feature was added. One JS
// source of truth, embedded into both scripts, instead of two copies that could drift apart.
function anyDeskInstallsScript() {
  return `# Some PCs end up with AnyDesk installed twice under different profiles - a standard install
# AND a separately-branded custom MSI build in its own "ad_*_msi" subfolder (each gets its own
# service/system.conf and its own distinct ID) - so this scans every known conf path instead of
# stopping at the first match, and returns every DISTINCT id found rather than just one, so none of
# them silently go missing from the directory.
# Every AnyDesk installation on this PC, as its own entry: which id it answers on, which exe
# owns it, and whether an unattended-access password is set.
#
# Driven off the SERVICES rather than by scanning for AnyDesk.exe. A custom-branded MSI build
# installs as its own service with its own binary named after itself - on a real device that is
# "AnyDesk-ad_5595aceb_msi.exe", which a search for "AnyDesk.exe" silently misses. Reading the
# service's own PathName is what makes each install addressable, and addressability is the whole
# point: with two installs, "set the AnyDesk password" is ambiguous unless you can say WHICH.
#
# passwordSet reports only WHETHER a password exists, never anything derived from it. AnyDesk
# stores a salted hash (ad.anynet.pwd_hash in service.conf on the standard install, or the
# permission-profile pwd key in system.conf), and the hash itself is deliberately never read,
# logged or transmitted - the dashboard only needs to show set / not set.
function Get-AnyDeskInstalls {
    $installs = @()
    $services = @(Get-CimInstance Win32_Service -Filter "Name like '%AnyDesk%'" -ErrorAction SilentlyContinue)
    foreach ($svc in $services) {
        $exe = $null
        if ($svc.PathName -match '"([^"]+\\.exe)"') { $exe = $matches[1] }
        elseif ($svc.PathName -match '^(\\S+\\.exe)') { $exe = $matches[1] }
        # The standard service is plain "AnyDesk" and keeps its config in ProgramData\AnyDesk;
        # a custom build is "AnyDesk-<folder>" and keeps its own under that folder name.
        $confDir = Join-Path $env:ProgramData 'AnyDesk'
        if ($svc.Name -match '^AnyDesk-(.+)$') { $confDir = Join-Path $confDir $matches[1] }
        $systemConf = Join-Path $confDir 'system.conf'
        $serviceConf = Join-Path $confDir 'service.conf'
        $id = $null
        if (Test-Path $systemConf) {
            $m = (Get-Content $systemConf -ErrorAction SilentlyContinue | Select-String -Pattern 'ad\\.anynet\\.id=(\\d+)')
            if ($m) { $id = $m.Matches[0].Groups[1].Value }
        }
        if (-not $id) { continue }
        # Presence only - the value after '=' is never captured.
        $pwdSet = $false
        foreach ($cf in @($serviceConf, $systemConf)) {
            if (-not (Test-Path $cf)) { continue }
            $hit = (Get-Content $cf -ErrorAction SilentlyContinue |
                Select-String -Pattern '^(ad\\.anynet\\.pwd_hash|ad\\.security\\.permission_profiles\\._unattended_access\\.pwd)=\\S')
            if ($hit) { $pwdSet = $true }
        }
        $installs += @{ id = $id; exe = $exe; service = $svc.Name; passwordSet = $pwdSet }
    }
    return $installs
}`;
}

function defaultCollectorScript() {
  return `${anyDeskInstallsScript()}

function Get-AllAnyDeskIds {
    $paths = [System.Collections.Generic.List[string]]::new()
    $paths.Add("$env:ProgramData\\AnyDesk\\service.conf")
    $paths.Add("$env:ProgramData\\AnyDesk\\system.conf")
    $paths.Add("$env:APPDATA\\AnyDesk\\user.conf")
    $msiConfs = Get-ChildItem -Path "$env:ProgramData\\AnyDesk" -Filter "system.conf" -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -like "ad_*_msi" }
    foreach ($f in $msiConfs) { $paths.Add($f.FullName) }

    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($path in ($paths | Get-Unique)) {
        if (-not (Test-Path $path)) { continue }
        $content = Get-Content -Path $path -ErrorAction SilentlyContinue
        $match = $content | Select-String -Pattern "ad.anynet.id=(\\d+)"
        if ($match) {
            $id = $match.Matches[0].Groups[1].Value
            if ($ids -notcontains $id) { $ids.Add($id) }
        }
    }
    return $ids
}

function Get-TeamViewerId {
    $keys = @('HKLM:\\SOFTWARE\\TeamViewer', 'HKLM:\\SOFTWARE\\WOW6432Node\\TeamViewer')
    foreach ($base in $keys) {
        if (Test-Path $base) {
            $prop = Get-ItemProperty -Path $base -Name ClientID -ErrorAction SilentlyContinue
            if ($prop -and $prop.ClientID) { return [string]$prop.ClientID }
            $sub = Get-ChildItem -Path $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like 'Version*' } | Select-Object -First 1
            if ($sub) {
                $subProp = Get-ItemProperty -Path $sub.PSPath -Name ClientID -ErrorAction SilentlyContinue
                if ($subProp -and $subProp.ClientID) { return [string]$subProp.ClientID }
            }
        }
    }
    return $null
}

# Extra remote-access ids beyond the primary AnyDesk/TeamViewer ones shown in their own columns -
# takes every AnyDesk id after the first (see Get-AllAnyDeskIds - a second install genuinely means
# a second connect option, not a duplicate) plus an extension point for detecting more tools
# (Chrome Remote Desktop, LogMeIn, etc.) as further @{ tool = 'ToolName'; id = '...' } entries,
# since there's no single universal way to enumerate every possible remote-access tool.
function Get-OtherRemoteIds($anydeskIds) {
    $extra = @()
    for ($i = 1; $i -lt $anydeskIds.Count; $i++) {
        $extra += @{ tool = "AnyDesk ($($i + 1))"; id = $anydeskIds[$i] }
    }
    $rustDesk = Get-RustDeskId
    if ($rustDesk) { $extra += @{ tool = "RustDesk"; id = $rustDesk } }
    return $extra
}

# RustDesk keeps its connect id in a TOML config rather than the registry, so this reads the file
# rather than probing HKLM like the AnyDesk/TeamViewer lookups above.
#
# TWO locations, checked in this order and for a reason: when RustDesk is installed as a Windows
# service (the normal unattended-access setup, and the only one that works on a signage PC with
# nobody logged in) the authoritative id lives in the LocalService profile. The per-user copy only
# exists where someone ran the desktop app interactively, and on a PC with several profiles each
# one has its own - so the service copy is the id that actually answers a connection.
#
# Read as SYSTEM, which is what makes the LocalService path reachable at all; a per-user agent
# could not see it. Falls back to scanning user profiles for the machines running RustDesk purely
# interactively.
function Get-RustDeskId {
    # Asks RustDesk itself rather than reading its config. The TOML looked like the obvious source
    # and is not one: on a real install the keys present are enc_id, password, salt, key_pair,
    # key_confirmed - the id is stored ENCRYPTED as enc_id, so no amount of regex tuning would ever
    # have found it, and RustDesk2.toml holds only rendezvous_server/nat_type/serial. --get-id is
    # the documented way to read it and returned 487425731 on the test machine.
    #
    # Backslashes are DOUBLED throughout and the regex is single-quoted: this script is generated
    # inside a JavaScript template literal, which eats single backslash escapes before PowerShell
    # sees them. That is exactly what broke agent v48 and took three PCs offline.
    $exe = @("$env:ProgramFiles\\RustDesk\\rustdesk.exe", "\${env:ProgramFiles(x86)}\\RustDesk\\rustdesk.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) { return $null }
    # Bounded like every other external call in this file. This runs inside the check-in path, so a
    # hung process here would stall the whole check-in, not just the RustDesk lookup - and output is
    # redirected to a file because that is the only way Start-Process can capture stdout.
    $outFile = Join-Path $env:TEMP ("rustdesk-id-" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList "--get-id" -PassThru -WindowStyle Hidden -RedirectStandardOutput $outFile
        if (-not $proc.WaitForExit(10000)) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            return $null
        }
        # The redirected handle is released a moment after the process itself exits.
        Start-Sleep -Milliseconds 250
        $raw = Get-Content -Path $outFile -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        $id = $raw.Trim()
        # Only accept something that actually looks like a RustDesk id. Without this, an error
        # message or a usage banner on stdout would be reported to the dashboard AS the id.
        if ($id -match '^[0-9]{6,}$') { return $id }
        return $null
    } catch {
        return $null
    } finally {
        Remove-Item -Path $outFile -Force -ErrorAction SilentlyContinue
    }
}

# Applies a permanent RustDesk password sent from the dashboard, via --password - the documented
# (source-confirmed) way to set one from the command line. No target/install id needed here unlike
# Set-AnyDeskPassword: Get-RustDeskId only ever reports one id per PC, so there is nothing to
# disambiguate between.
#
# Unlike AnyDesk, RustDesk has no stdin-based way to take a password - --password is a real
# command-line argument, so it IS briefly visible to Get-CimInstance Win32_Process (or any other
# local process listing) for as long as this one process runs. That is a genuine gap next to
# Set-AnyDeskPassword's stdin approach, not an oversight - RustDesk simply does not offer the
# alternative AnyDesk does. Kept as short-lived as possible (WaitForExit below) to narrow the
# window rather than pretend it does not exist.
function Set-RustDeskPassword($password) {
    try {
        $exe = @("$env:ProgramFiles\\RustDesk\\rustdesk.exe", "\${env:ProgramFiles(x86)}\\RustDesk\\rustdesk.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $exe) { return "RustDesk is not installed on this PC." }
        $proc = Start-Process -FilePath $exe -ArgumentList @("--password", $password) -PassThru -WindowStyle Hidden
        if (-not $proc.WaitForExit(10000)) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            return "RustDesk did not respond within 10 seconds."
        }
        if ($proc.ExitCode -eq 0) { return "OK" }
        return "RustDesk exited with code $($proc.ExitCode)."
    } catch {
        return "Could not run RustDesk: $($_.Exception.Message)"
    }
}

# Same discovery approach Broadsign's own player leaves on disk (and the same fallback file/keyword
# search the original Jstar agent used) - matched server-side against Asset Inventory's Player Box
# ID (Player Type = Broadsign), the exact field broadsign-sync itself matches on, so this PC can be
# cross-referenced with the screen it drives in the Broadsign Console.
function Get-BroadsignPlayerId {
    $sharePath = "C:\\ProgramData\\BroadSign\\bsp\\share\\bsp"
    if (-not (Test-Path $sharePath)) { return $null }
    $candidates = @("host_id.txt", "player_id.txt", "config.xml", "settings.json", "bsp.ini")
    $keywords = @("host_id", "playerid", "player_id", "deviceid", "id")
    foreach ($fileName in $candidates) {
        $filePath = Join-Path $sharePath $fileName
        if (-not (Test-Path $filePath)) { continue }
        $content = Get-Content -Path $filePath -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($content)) { continue }
        foreach ($keyword in $keywords) {
            if ($content -match "\\b$keyword\\s*[:=]\\s*\`"?([a-zA-Z0-9\\-_.]+)\`"?") { return $matches[1] }
        }
        if ($fileName -eq "host_id.txt" -and $content.Trim() -match "^[a-zA-Z0-9\\-_.]+$") { return $content.Trim() }
    }
    return $null
}

# Grassfish players expose their own BoxId via a local REST endpoint - the same source
# grassfish-sync matches by (Player Box ID, Player Type = Grassfish), so this PC can be
# cross-referenced with the screen it drives in the Grassfish Console.
function Get-GrassfishBoxId {
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8080/REST/PlayerDetails/MasterDetails" -TimeoutSec 3 -ErrorAction Stop
        if ($resp -and $resp.BoxId) { return [string]$resp.BoxId }
    } catch {}
    return $null
}

function Get-PrimaryIPv4 {
    try {
        return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'Loopback' } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { return $null }
}

function Get-Volumes {
    # Win32_LogicalDisk can hand back a drive with DeviceID and VolumeName populated but Size and
    # FreeSpace NULL - the static properties answer from cache while the dynamic ones fail - and
    # since $null / 1GB rounds to 0 in PowerShell, a drive nobody could measure arrives looking
    # exactly like a genuinely empty one. [System.IO.DriveInfo] calls the Win32 API directly and
    # touches no WMI at all, so it still answers on a PC whose WMI stack is degraded.
    #
    # Confirmed live on DESKTOP-OMM99EM, 1 Sep 2026: Win32_LogicalDisk returned C: and D: with Size
    # and FreeSpace null AND Get-Volume returned nothing whatsoever, while DriveInfo read both
    # correctly - 411.3 GB with 381.7 free and 520.1 GB with 519.1 free, matching what the machine
    # itself showed in Explorer. Get-Volume was the obvious fallback and would have fixed nothing;
    # this one was picked because it was tested on the actual broken PC first.
    #
    # WMI deliberately stays PRIMARY: every PC it already works on keeps sending byte-identical
    # data, and DriveInfo only fills in a drive WMI could not size, or one it never reported at all.
    $byDrive = [ordered]@{}
    foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue)) {
        $id = [string]$d.DeviceID
        if (-not $id) { continue }
        $byDrive[$id] = [ordered]@{
            drive  = $id
            label  = $d.VolumeName
            sizeGb = [math]::Round(($d.Size / 1GB), 1)
            freeGb = [math]::Round(($d.FreeSpace / 1GB), 1)
        }
    }
    try {
        foreach ($di in @([System.IO.DriveInfo]::GetDrives())) {
            if ($di.DriveType -ne [System.IO.DriveType]::Fixed) { continue }
            if (-not $di.IsReady) { continue }
            # "C:" - Substring rather than trimming a path separator, which would need a backslash
            # escape inside the JS template literal this script is authored in.
            $id = $di.Name.Substring(0, 2)
            $sizeGb = [math]::Round(($di.TotalSize / 1GB), 1)
            $freeGb = [math]::Round(($di.AvailableFreeSpace / 1GB), 1)
            if ($sizeGb -le 0) { continue }
            if ($byDrive.Contains($id)) {
                # Only rescues a drive WMI failed to size. A drive WMI measured is left exactly as
                # WMI reported it, so this can never quietly change a figure that already worked.
                if ([double]$byDrive[$id].sizeGb -le 0) {
                    $byDrive[$id].sizeGb = $sizeGb
                    $byDrive[$id].freeGb = $freeGb
                    if (-not $byDrive[$id].label) { $byDrive[$id].label = $di.VolumeLabel }
                }
            } else {
                $byDrive[$id] = [ordered]@{ drive = $id; label = $di.VolumeLabel; sizeGb = $sizeGb; freeGb = $freeGb }
            }
        }
    } catch {
        # Swallowed silently, and deliberately NOT logged with Write-AgentLog: that function is
        # defined in the agent shell, and this collector is also fetched and run as its own
        # standalone document (workspace-directory-collector) where it does not exist at all -
        # calling it there would throw "The term is not recognized" and take the whole of
        # Get-Volumes down with it. Exactly the trap Get-AnyDeskInstalls fell into.
        # A PC where even DriveInfo throws is simply no worse off than before this fallback existed.
    }
    return @($byDrive.Values)
}

function Get-Components {
    $cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
    $ramBytes = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).TotalPhysicalMemory
    $gpu = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -First 1).Name
    $disks = Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | ForEach-Object {
        "$($_.Model) ($([math]::Round($_.Size / 1GB))GB)"
    }
    [ordered]@{
        cpu   = $cpu
        ramGb = if ($ramBytes) { [math]::Round($ramBytes / 1GB) } else { $null }
        gpu   = $gpu
        disks = @($disks)
    }
}

# Reads the registry Uninstall keys directly (32/64-bit + per-user) rather than Win32_Product,
# which silently triggers an MSI repair/consistency check on every single package - slow and
# occasionally disruptive on a kiosk PC. uninstallString prefers the silent/quiet variant
# (QuietUninstallString) when the installer registered one, so the Digital Directory's per-item
# Uninstall action can queue it directly without needing to guess a winget package ID.
function Get-InstalledSoftware {
    $paths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $seen = @{}
    Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
        ForEach-Object {
            if ($seen.ContainsKey($_.DisplayName)) { return }
            $seen[$_.DisplayName] = $true
            [ordered]@{
                name            = $_.DisplayName
                version         = $_.DisplayVersion
                publisher       = $_.Publisher
                uninstallString = if ($_.QuietUninstallString) { $_.QuietUninstallString } else { $_.UninstallString }
            }
        }
}

function Get-AntivirusStatus {
    try {
        Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntivirusProduct -ErrorAction Stop | ForEach-Object {
            # productState's middle byte roughly encodes on/off - a widely-used (if undocumented by
            # Microsoft) heuristic, not a guaranteed API. Good enough for "is something reporting
            # itself enabled", not a substitute for a real endpoint-security report.
            $state = [Convert]::ToString([int]$_.productState, 16).PadLeft(6, '0')
            $enabled = $state.Substring(2, 2) -in @('10', '11')
            [ordered]@{ name = $_.displayName; enabled = $enabled }
        }
    } catch { @() }
}

function Get-NetworkBytesTotal {
    # A raw, ever-increasing counter, not "data left" - the dashboard computes usage by diffing
    # this against the previous reading each check-in. Prefers a cellular/WWAN adapter if one is
    # up (the actual metered SIM link on a kiosk PC); otherwise sums every active adapter, which is
    # still a useful "how much has this PC used" signal on a wired/Wi-Fi machine.
    try {
        $adapters = Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' }
        $cellular = $adapters | Where-Object { $_.InterfaceDescription -match 'cellular|wwan|mobile broadband' }
        $targets = if ($cellular) { $cellular } else { $adapters }
        $total = 0
        foreach ($a in $targets) {
            $s = Get-NetAdapterStatistics -Name $a.Name -ErrorAction SilentlyContinue
            if ($s) { $total += [int64]$s.ReceivedBytes + [int64]$s.SentBytes }
        }
        return $total
    } catch { return $null }
}

function Get-Problems($volumes, $antivirus, $anydeskId, $teamviewerId) {
    $problems = @()
    foreach ($v in $volumes) {
        if ($v.sizeGb -gt 0 -and ($v.freeGb / $v.sizeGb) -lt 0.10) {
            $problems += "Low disk space on $($v.drive) ($($v.freeGb)GB free of $($v.sizeGb)GB)"
        }
    }
    if (-not $antivirus -or $antivirus.Count -eq 0) {
        $problems += "No antivirus product detected"
    } else {
        foreach ($av in $antivirus) {
            if (-not $av.enabled) { $problems += "$($av.name) is reporting disabled" }
        }
    }
    if (-not $anydeskId -and -not $teamviewerId) {
        $problems += "No remote-access tool (AnyDesk/TeamViewer) detected"
    }
    return @($problems)
}

$__volumes = @(Get-Volumes)
$__antivirus = @(Get-AntivirusStatus)
$__anydeskIds = @(Get-AllAnyDeskIds)
$__anydeskId = if ($__anydeskIds.Count -gt 0) { $__anydeskIds[0] } else { $null }
$__teamviewerId = Get-TeamViewerId
$__os = Get-CimInstance Win32_OperatingSystem

@{
    hostname          = $env:COMPUTERNAME
    ip                = Get-PrimaryIPv4
    anydeskId         = $__anydeskId
    teamviewerId      = $__teamviewerId
    otherRemoteIds    = @(Get-OtherRemoteIds $__anydeskIds)
    broadsignPlayerId = Get-BroadsignPlayerId
    grassfishBoxId    = Get-GrassfishBoxId
    os                = $__os.Caption
    osVersion         = $__os.Version
    loggedInUser      = (Get-CimInstance Win32_ComputerSystem).UserName
    volumes           = $__volumes
    components        = Get-Components
    antivirus         = $__antivirus
    software          = @(Get-InstalledSoftware)
    problems          = @(Get-Problems $__volumes $__antivirus $__anydeskId $__teamviewerId)
    anydeskInstalls   = @(Get-AnyDeskInstalls)
    networkBytesTotal = Get-NetworkBytesTotal
    agentVersion      = "3.2"
}`;
}

// The pre-filled/reset value for the Signage PC Optimizer Script box below - originally authored
// as a standalone Optimize-SignagePC.ps1 meant to be run manually (hence its own "Run as
// Administrator" comment), adopted here verbatim except for admin rights: queued through the
// Optimize button, it's dispatched as a Run Command, which already always executes as SYSTEM (see
// Invoke-PendingCommand) - no elevation prompt to worry about, unlike a manual double-click.
//
// EVERY BACKSLASH IN THIS STRING IS DOUBLED. This lives inside a JS template literal, which
// consumes backslash escapes before PowerShell ever sees the text - a single "C:\Windows\Temp"
// here would silently become "C:WindowsTemp" (JS's escape table drops an unrecognised "\W", "\T"
// etc. rather than erroring) - not a parse failure CI would catch, just a script that quietly
// cleans the wrong folder. See the near-identical warning on buildWorkspaceDirectoryAgentScript's
// own backslash-heavy content below, and scripts/generate-agent-script.mjs's header comment for
// the exact incident (agent v48, 25 Aug 2026) that made this something to warn about at all.
export function defaultOptimizerScript() {
  return `# ============================================================
# Digital Signage PC - Windows / Defender Optimization
# Runs as SYSTEM automatically when queued via the dashboard's Optimize button.
# ============================================================

Write-Host "Starting Digital Signage PC optimization..." -ForegroundColor Cyan

# ------------------------------------------------------------
# 1. Limit Microsoft Defender scan CPU usage
# ------------------------------------------------------------
Write-Host "Setting Microsoft Defender scan CPU limit..."

Set-MpPreference -ScanAvgCPULoadFactor 20


# ------------------------------------------------------------
# 2. Disable Defender scanning of files while they are being
#    scanned by another trusted process where applicable
# ------------------------------------------------------------
Set-MpPreference -DisableArchiveScanning $false
Set-MpPreference -DisableEmailScanning $false
Set-MpPreference -DisableRemovableDriveScanning $false


# ------------------------------------------------------------
# 3. Optional exclusions for DIGITAL SIGNAGE CACHE folders
#
# IMPORTANT:
# Change these paths to the actual folders used by your
# signage software before enabling them.
# ------------------------------------------------------------

$SignageFolders = @(
    # "C:\\Signage\\Cache",
    # "C:\\Signage\\Content",
    # "C:\\ProgramData\\YourCMS\\Cache"
)

foreach ($Folder in $SignageFolders) {

    if (Test-Path $Folder) {

        Write-Host "Adding Defender exclusion: $Folder"

        Add-MpPreference -ExclusionPath $Folder

    }
}


# ------------------------------------------------------------
# 4. Clean Windows temporary files
# ------------------------------------------------------------

Write-Host "Cleaning temporary files..."

$TempFolders = @(
    $env:TEMP,
    "C:\\Windows\\Temp"
)

foreach ($Folder in $TempFolders) {

    if (Test-Path $Folder) {

        Get-ChildItem $Folder -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}


# ------------------------------------------------------------
# 5. Clear Windows Update download cache
#    ONLY removes temporary downloaded update files.
# ------------------------------------------------------------

Write-Host "Cleaning Windows Update temporary cache..."

Stop-Service wuauserv -Force -ErrorAction SilentlyContinue

if (Test-Path "C:\\Windows\\SoftwareDistribution\\Download") {

    Get-ChildItem "C:\\Windows\\SoftwareDistribution\\Download" -Force |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Start-Service wuauserv -ErrorAction SilentlyContinue


# ------------------------------------------------------------
# 6. Run Defender quick scan
# ------------------------------------------------------------

Write-Host "Starting Microsoft Defender quick scan..."

Start-MpScan -ScanType QuickScan


# ------------------------------------------------------------
# 7. Display current Defender configuration
# ------------------------------------------------------------

Write-Host ""
Write-Host "Current Defender CPU limit:" -ForegroundColor Yellow

Get-MpPreference |
    Select-Object ScanAvgCPULoadFactor


Write-Host ""
Write-Host "Optimization completed." -ForegroundColor Green
Write-Host "A restart is recommended."
`;
}

// The fixed outer shell: self-elevate, self-update (see Invoke-SelfUpdate below), register the
// 6-hourly scheduled task, then on every run try the remote collector first (Data Collector
// Script above) and fall back to the identical logic baked in here as Invoke-DefaultCollector if
// the fetch fails, the response is empty, or the remote script itself throws - so a bad edit in
// Settings degrades a PC back to default behavior instead of breaking its check-ins. Also handles
// the single-slot remote command: runs whatever pendingCommand comes back in the check-in response
// immediately (no extra request), but only REPORTS the output on the *next* cycle (cached in a
// small local JSON file meanwhile) - so a command never costs a second network round-trip. Check-ins
// run every 6 hours (frequent Online/Offline status), but the SIM-data-usage figure specifically is
// computed server-side only about once a day regardless (see workspace-directory-checkin) - a few KB
// per call either way is negligible next to a typical SIM data plan; the self-update check below
// adds one more GET of the same order.
function buildWorkspaceDirectoryAgentScript(secret, uninstallPasswordHash) {
  const checkinUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-checkin`;
  const collectorUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-collector`;
  const agentShellUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-agent-shell`;
  const forceStatusUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-force-status`;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const uninstallHash = (uninstallPasswordHash || '').toLowerCase();
  const indented = defaultCollectorScript().split('\n').map((l) => `    ${l}`).join('\n');
  return `# Jstar Agent
# Collects PC inventory and checks in with the Hypermedia Operations Dashboard every 6 hours via a
# scheduled task (the SIM-data-usage figure itself is only recomputed about once a day regardless -
# see workspace-directory-checkin), since several of these PCs run on metered cellular SIM data
# rather than broadband. What gets collected is fetched fresh from the dashboard on every run
# (Settings > Integrations > Jstar Agent > Data Collector Script) - this outer shell
# itself never needs to change or be re-installed to pick up a new field. Re-run this script any
# time to update the install (e.g. after rotating the secret).
#
# The 6-hourly and 20-minute cycles (-Once/-PollOnce below) are always fully headless - no window,
# tray icon, or notification - since these PCs drive signage screens and nothing there may ever show
# up over the content on screen. There IS a taskbar tray icon (-Tray below, in whichever user is
# logged in) for at-a-glance status and a manual "Force Inventory Pull" button - but it auto-hides
# itself the instant Broadsign's or Grassfish's own player process is
# actually running, so it can never appear over live public-facing content either.

param([switch]$Once, [switch]$Uninstall, [switch]$PollOnce, [string]$RunCommandFile, [switch]$Tray, [switch]$DuScrapeOnce, [switch]$Service)

$CheckinUrl = "${checkinUrl}"
$CollectorUrl = "${collectorUrl}"
$AgentShellUrl = "${agentShellUrl}"
$ForceStatusUrl = "${forceStatusUrl}"
$AgentSecret = "${secret}"
$AnonKey = "${anonKey}"
$TaskName = "WorkspaceDirectoryAgent"
$PollTaskName = "WorkspaceDirectoryAgentPoll"
$TrayTaskName = "WorkspaceDirectoryAgentTray"
$DuScrapeTaskName = "WorkspaceDirectoryAgentDuScrape"
# The test machines, baked in so ONE script behaves correctly everywhere - the build promoted to the
# fleet is byte-identical to the one signed off on the test PCs, which is the whole point of having
# a canary. Anything host-specific therefore has to be decided at runtime, by the agent, rather than
# by generating a second variant that was never actually tested.
$TestPcHostnames = @(${AGENT_CANARY_HOSTNAMES.map((h) => `'${h}'`).join(', ')})
$IsTestPc = $TestPcHostnames -contains $env:COMPUTERNAME
# Test PCs poll every minute instead of every 20 so a queued command, a forced check-in or a newly
# published build lands while someone is still sitting there watching for it - waiting out a
# 20-minute cycle for each step made verifying a fix take most of a day. The fleet keeps the
# 20-minute cadence: these PCs are on metered cellular SIMs, and polling 20x more often would cost
# 20x the check-ins on exactly the data plan this whole feature exists to conserve.
$PollIntervalMinutes = if ($IsTestPc) { 1 } else { 20 }
$StateDir = "$env:ProgramData\\WorkspaceDirectoryAgent"
$InstalledScriptPath = Join-Path $StateDir "Install-JstarAgent.ps1"
$PendingResultFile = Join-Path $StateDir "pending-command-result.json"
$StatusFile = Join-Path $StateDir "status.json"
$LogFile = Join-Path $StateDir "agent.log"
$PendingBatchFile = Join-Path $StateDir "pending-command.bat"
$DuScrapeStateFile = Join-Path $StateDir "du-scrape-last.txt"
# Headless Edge stalls indefinitely when launched from Session 0 (see Get-DuDataUsageViaDom), which
# is where every SYSTEM scheduled task runs - confirmed live on 24 Aug 2026: 0 bytes, no exit code
# and empty stderr on every device, with and without --no-sandbox. The scrape therefore has to run
# in the LOGGED-IN USER's interactive session, which is exactly where the tray process already
# lives, and hand its result back for the SYSTEM check-in to report.
#
# It hands it back through a dedicated sub-folder rather than writing $DuScrapeStateFile directly,
# because that would need BUILTIN\Users to have modify rights on $StateDir - and $StateDir also
# holds Install-JstarAgent.ps1, the very script SYSTEM executes every cycle. Granting a limited
# user write access to it would let any logged-in user replace the agent and have SYSTEM run their
# code: a straightforward privilege escalation. Only this one folder is writable by Users.
$DuHandoffDir = Join-Path $StateDir "user-scrape"
$DuHandoffFile = Join-Path $DuHandoffDir "du-result.json"
# Where Save-DuScrapeState writes. SYSTEM keeps the real state file; the user-session scrape
# (-DuScrapeOnce) redirects to the handoff, which SYSTEM folds in on its next check-in.
$Script:DuStateTarget = $DuScrapeStateFile
$Script:DuIsUserSession = $false
$PopupStateFile = Join-Path $StateDir "last-unexpected-windows.txt"
# Written by the Tray's own timer (see -Tray branch below), in the SAME Users-writable folder the
# DU handoff already uses - no separate ACL grant needed. SYSTEM only ever reads this file; it
# never scans for popups itself any more. See the header on Get-UnexpectedWindows for why: a scan
# from Session 0 (where every SYSTEM check-in runs) finds nothing at all, regardless of what is
# actually on screen. Confirmed live on PC-88AEDD6212C8, 26 Aug 2026 - a Windows Security dialog
# ("Actions needed in Microsoft Defender") was visibly covering the signage content, and a
# Get-Process scan from the check-in still returned zero windowed processes. No Slack alert had
# fired, and could never have fired, no matter how the allowlist was configured - the scan itself
# was blind, the same way the DU scrape was blind from Session 0 before it was moved into the
# user's session (see $DuHandoffFile above).
$PopupHandoffFile = Join-Path $DuHandoffDir "popup-result.json"
$ModerateSnapshotFile = Join-Path $StateDir "last-moderate-snapshot.json"
$HeavySnapshotFile = Join-Path $StateDir "last-heavy-snapshot.json"
$DuSnapshotFile = Join-Path $StateDir "last-du-scrape-snapshot.json"
$ShellVersionFile = Join-Path $StateDir "installed-shell-version.txt"
$RenamedFromFile = Join-Path $StateDir "renamed-from.txt"
$CollectorCacheFile = Join-Path $StateDir "collector-cache.ps1"
$CollectorVersionFile = Join-Path $StateDir "collector-cache-version.txt"
$UninstallPasswordHash = "${uninstallHash}"
# Windows Service identity (see the WinSW install block and the -Service branch far below). One
# fixed, pinned build - github.com/winsw/winsw v2.12.0, WinSW.NET461.exe - verified by SHA-256
# before it is ever executed, never trusted just because the download succeeded.
$ServiceName = "WorkspaceDirectoryAgentSvc"
$ServiceExePath = Join-Path $StateDir "$ServiceName.exe"
$ServiceXmlPath = Join-Path $StateDir "$ServiceName.xml"
$WinSwUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe"
$WinSwSha256 = "B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F"

# Hides THIS process's OWN console window immediately, before anything else runs - a backstop for
# when -WindowStyle Hidden at the launch site isn't honored, which is exactly what happens to the
# -Verb RunAs re-elevation just below: the elevation broker (consent.exe/AppInfo), not this script's
# own launcher, is what actually creates that new process, and it does not reliably pass the
# STARTUPINFO window-style hint through - especially on Windows 11 machines where Windows Terminal
# (not classic conhost) hosts the console. Confirmed live: PC-E89C258BF220 and HM-OFFICE-TEST both
# reported "Unexpected window/popup detected: Administrator: ...powershell.exe (WindowsTerminal)" -
# a visible elevated console left sitting on screen/taskbar after exactly that re-elevation, despite
# -WindowStyle Hidden being passed on both Start-Process and inside -ArgumentList. Hiding from INSIDE
# the process instead needs nothing from whoever/whatever created the window, so it works regardless
# of the broker, the host (conhost vs Windows Terminal), or a future spawn point that forgets the
# flag - every invocation of this script (elevated child included, since it re-executes this same
# file from the top) hits this line and hides itself. Close-StrayAgentWindows further down is a
# periodic backstop for anything that still somehow gets past this; this is what stops it happening
# in the first place. Silently no-ops (try/catch) rather than risk a P/Invoke failure blocking the
# real check-in logic that follows.
Add-Type -ErrorAction SilentlyContinue -Namespace WorkspaceDirectoryAgent -Name Win32 -MemberDefinition @'
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
try {
    $ownConsoleWindow = [WorkspaceDirectoryAgent.Win32]::GetConsoleWindow()
    if ($ownConsoleWindow -ne [IntPtr]::Zero) { [WorkspaceDirectoryAgent.Win32]::ShowWindow($ownConsoleWindow, 0) | Out-Null } # 0 = SW_HIDE
} catch {}

# Self-elevate if not already running as Administrator (needed to register/unregister the
# SYSTEM-level task either way, install OR uninstall). Skipped for -Once/-PollOnce - both only ever
# run FROM an already-SYSTEM-elevated scheduled task, so re-elevating would pop a UAC prompt on a
# signage screen for no reason (there's no interactive user to click through it anyway). Also skipped
# for -Tray: that one needs to stay running AS the logged-in user in their own interactive desktop
# session so its icon can actually appear - elevating it would either fail silently (Session 0
# isolation) or, if it somehow succeeded, run it as a different, non-visible session instead.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Once -and -not $PollOnce -and -not $RunCommandFile -and -not $Tray -and -not $DuScrapeOnce -and -not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $reElevateArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$PSCommandPath\`""
    if ($Uninstall) { $reElevateArgs += " -Uninstall" }
    try {
        Start-Process powershell.exe -ArgumentList $reElevateArgs -Verb RunAs -WindowStyle Hidden -ErrorAction Stop
    } catch {
        # -Verb RunAs needs an interactive desktop session to show the UAC consent prompt - it
        # cannot succeed over PsExec/WinRM/an RMM tool running as a plain admin ACCOUNT (as opposed
        # to SYSTEM), and fails immediately and totally: nothing past this point ever runs, so the
        # PC never even attempts a check-in and simply never appears on the dashboard, with nothing
        # anywhere to explain why. Confirmed live 27 Aug 2026 - rolled out to many PCs at once over
        # a remote/bulk tool, none of them registered. $StateDir/$LogFile don't exist yet this early
        # (that copy-into-place happens further down), so this is surfaced to $env:TEMP instead -
        # the one place guaranteed writable and findable without already having a working install.
        $msg = "Could not self-elevate - this needs an interactive desktop for the UAC prompt, which fails silently when run over PsExec/WinRM/an RMM tool as a plain admin ACCOUNT. Run it AS SYSTEM instead (e.g. 'psexec -s ...', or your RMM's 'run as SYSTEM/LocalSystem' option) - SYSTEM already satisfies the admin check above and skips this step entirely. $($_.Exception.Message)"
        Write-Warning $msg
        try { Add-Content -Path (Join-Path $env:TEMP "JstarAgent-install-error.log") -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg" -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
        exit 1
    }
    exit
}

# Copies the running script into a protected, permanent location the FIRST time it's needed - every
# scheduled task, self-update, and Run Command from here on operates on THIS copy (see
# $InstalledScriptPath above), never on wherever the installer .ps1/.bat happened to be downloaded
# and double-clicked from (Desktop, Downloads, a USB stick...). Without this, deleting those original
# files after a successful install - which looks like harmless cleanup - silently breaks every future
# check-in: the scheduled tasks would keep pointing at a file that no longer exists, fail at the OS
# level before this script can even run, and never report anything back to the dashboard to explain
# why. A no-op on every run after the first, since the scheduled tasks below are registered to invoke
# $InstalledScriptPath directly, so $PSCommandPath already matches it from then on. Skipped for
# -RunCommandFile's own child process for the same reason - it's spawned via $InstalledScriptPath by
# its parent, so it's already running from there. Not skipped for -Uninstall: relocating first is
# harmless (Invoke-UninstallCleanup deletes $StateDir - and this copy along with it - moments later
# anyway), and keeping this check unconditional means one code path instead of a special case.
if ($PSCommandPath -and $PSCommandPath -ne $InstalledScriptPath) {
    try {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        Copy-Item -Path $PSCommandPath -Destination $InstalledScriptPath -Force
        & $InstalledScriptPath @PSBoundParameters
        exit
    } catch {
        Write-Warning "Could not relocate to a protected install location, continuing from the current path instead: $($_.Exception.Message)"
    }
}

# Signage PCs should show ONLY their own player/browser content full-screen - Windows Update's own
# "Setup"/"restart to finish installing" prompt, or some other app's error dialog, is itself the
# problem regardless of what caused it (real examples: a fuel-pump screen showing a stray app
# window, a Yas Mall totem with an open Windows dialog and taskbar visible over the ad content).
# Reports EVERY window that's actually visible and not minimized right now (there can genuinely be
# more than one stacked on screen at once), excluding the player/browser/remote-access tools below -
# a background/minimized Task Manager or admin console that isn't actually covering the player
# doesn't count, but anything currently rendered on screen does, regardless of whether it happens to
# have keyboard focus. Get-Process already exposes each window's handle with no extra API call
# needed to find it; checking whether THAT handle is visible/not-minimized takes two small Win32
# calls (IsWindowVisible/IsIconic) per already-titled window, not a raw system-wide enumeration.
# An earlier version instead enumerated EVERY window in the system (EnumWindows) and captured a
# screenshot on top of that, which got blocked twice by Windows Defender's AMSI scanner (window
# enumeration + screenshot + network upload is close to a textbook spyware signature); this is a
# much smaller, more ordinary use of the Windows API that does neither of those two things.
#
# Defined up here, well ABOVE where it is actually called from (the -Tray branch immediately below,
# and Invoke-Checkin far below) rather than down with the rest of the SYSTEM-side collector
# functions, because PowerShell does not hoist function definitions - a "function Foo {...}"
# statement only becomes callable once the interpreter's linear top-to-bottom pass actually reaches
# it (see the near-identical note on Invoke-DuScrape's placement further down). The -Tray branch
# runs almost immediately after this point in the script, so this has to be defined before it, not
# after.
$Script:ExpectedVisibleProcesses = @(
    'explorer', 'dwm', 'ApplicationFrameHost', 'ShellExperienceHost', 'SearchHost',
    'TextInputHost', 'ScreenClippingHost', 'LockApp',
    # StartMenuExperienceHost is deliberately NOT here - see the player-aware check in
    # Get-UnexpectedWindows below. It's only harmless when nothing is supposed to be on screen.
    # Broadsign's/Grassfish's actual player processes are the short "bsp"/"gfPlayer", not
    # "broadsignplayer"/"broadsign"/"grassfishplayer"/"grassfish" - none of those longer strings is a
    # substring of the real short name, so both were being flagged as an "unexpected" popup on every
    # single networked screen. Kept the older/longer names too in case some builds still use them.
    'bsp', 'broadsignplayer', 'broadsign', 'gfplayer', 'grassfishplayer', 'grassfish',
    'chrome', 'msedge', 'iexplore',
    # MicrosoftEdge/MicrosoftEdgeCP are the deprecated pre-Chromium Edge engine's process names
    # (main + content process) - NOT the same as 'msedge' above, which is modern Chromium Edge.
    # Windows itself still spins this old engine up internally for some shell features (Search/
    # Widgets web content, SmartScreen, etc.), with a blank window title and no user ever having
    # opened a browser. Confirmed live on PC-94C691A39CE3, 3 Sep 2026: both processes launched
    # together, blank MainWindowTitle, parent process svchost (a Windows service) - not
    # explorer.exe, not a double-click. Flagged as an "unexpected popup" every single check-in
    # with nothing on screen a person standing at the PC would ever see.
    'microsoftedge', 'microsoftedgecp',
    'powershell', 'powershell_ise', 'pwsh', 'conhost', 'cmd',
    # The remote-access tools this whole agent depends on (Get-Problems elsewhere in this script
    # separately flags their ABSENCE as its own problem) - their own window should never itself count
    # as an unexpected popup, they're required to be there.
    'anydesk', 'teamviewer'
)
# SystemSettings (the Settings app) is deliberately NOT allowlisted, unlike a normal office PC -
# Windows Update's own "restart to finish installing" / setup prompts often render through it, and
# an unattended signage PC has no legitimate reason for that app to ever be open on screen anyway.

function Get-UnexpectedWindows {
    # IsWindowVisible/IsIconic already exist on WorkspaceDirectoryAgent.Win32 - it's defined once,
    # unconditionally, near the top of the script (see the own-console-hiding Add-Type above), with
    # all four P/Invoke members this file needs. Redefining it here used to fail EVERY single time,
    # on every PC, on every invocation: Add-Type's "type already exists" is a terminating exception
    # that -ErrorAction SilentlyContinue does not actually suppress, so it printed straight to the
    # console - exactly the stray-window symptom this function exists to clean up - and, worse, the
    # uncaught throw aborted the function before Close-StrayAgentWindows' own copy of this mistake
    # ever reached its Stop-Process call, so the window it was supposed to close never actually got
    # closed. Confirmed live on AE1PC119, 2 Sep 2026: the console sat in the taskbar printing
    # "Cannot add type... already exists" once per cycle, forever, instead of self-closing.

    # Same two process names and same question the Jstar Agent tray icon already asks
    # (Test-SignagePlayerRunning, -Tray branch above) to decide whether it must stay hidden - but
    # defined again here rather than shared, because -Tray and this SYSTEM check-in are separate
    # invocations of the script that never run in the same process and so can't share a variable.
    # Checked once per call, not once per window, since every window this cycle gets the same answer.
    $playerRunning = [bool](Get-Process -Name 'bsp', 'gfplayer' -ErrorAction SilentlyContinue)

    $found = New-Object System.Collections.Generic.List[object]
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -and $_.MainWindowTitle.Trim()
    } | ForEach-Object {
        $hWnd = $_.MainWindowHandle
        # A minimized or otherwise not-actually-visible window (Task Manager sitting in the
        # taskbar, an admin console tucked away) still reports a MainWindowTitle via Get-Process
        # regardless of its on-screen state - these two checks are what actually distinguish
        # "genuinely displayed right now" from "merely exists somewhere".
        if (-not [WorkspaceDirectoryAgent.Win32]::IsWindowVisible($hWnd)) { return }
        if ([WorkspaceDirectoryAgent.Win32]::IsIconic($hWnd)) { return }

        $procName = $_.ProcessName
        # The Start Menu is ordinary desktop use on a back-office PC, or a signage PC between
        # content-player restarts - nothing is supposed to be showing there anyway. The moment the
        # player IS running, though, this PC is supposed to be full-screen on live public-facing
        # content, and the Start Menu sitting on top of that is exactly the case this whole detector
        # exists to catch - so it's the one process name that isn't unconditionally allowed the way
        # every other entry in $Script:ExpectedVisibleProcesses is.
        if ($procName -eq 'StartMenuExperienceHost' -and -not $playerRunning) { return }

        $isExpected = $false
        foreach ($allowed in $Script:ExpectedVisibleProcesses) {
            if ($procName -match [regex]::Escape($allowed)) { $isExpected = $true; break }
        }
        if (-not $isExpected) {
            $found.Add([pscustomobject]@{ title = $_.MainWindowTitle.Trim(); process = $procName })
        }
    }
    return $found
}

# Every automated spawn point in this script (scheduled tasks, self-elevation, the tray's "Force
# Inventory Pull") already launches powershell.exe with -WindowStyle Hidden - none of them should
# ever show a real window. This is the backstop for when one does anyway: a leftover process still
# running an OLDER copy of this script from before a window-hiding fix was published (old instances
# don't get killed off by a new version landing - they just run to completion on their own old
# code), a future spawn point that forgets -WindowStyle Hidden, or -WindowStyle Hidden itself being
# ignored on some Windows build/launch combination. Matches on the command line actually containing
# THIS script's own installed path, not just any powershell/cmd window - a staff member's own
# terminal session on an office PC (this agent runs on more than just locked-down totems) is
# deliberately left alone, same as Get-UnexpectedWindows above never flags it either.
function Close-StrayAgentWindows {
    # See the matching comment in Get-UnexpectedWindows above - this redefined the same type a
    # second time and reliably threw "already exists" (a terminating error -ErrorAction
    # SilentlyContinue does not suppress) BEFORE the try block below, aborting this function every
    # time it ran and leaving the stray window it exists to close sitting open indefinitely.
    try {
        $ownProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter (
            "Name='powershell.exe' or Name='powershell_ise.exe' or Name='pwsh.exe' or Name='cmd.exe'"
        ) | Where-Object {
            $_.CommandLine -and $_.CommandLine -like "*$InstalledScriptPath*" -and $_.ProcessId -ne $PID
        }
        foreach ($op in $ownProcs) {
            $proc = Get-Process -Id $op.ProcessId -ErrorAction SilentlyContinue
            if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { continue }
            if (-not [WorkspaceDirectoryAgent.Win32]::IsWindowVisible($proc.MainWindowHandle)) { continue }
            if ([WorkspaceDirectoryAgent.Win32]::IsIconic($proc.MainWindowHandle)) { continue }
            Write-AgentLog "Closing a stray visible PowerShell window from the agent's own script (PID $($op.ProcessId), title '$($proc.MainWindowTitle)') - every automated launch of this script sets -WindowStyle Hidden, so a visible one here should never happen."
            Stop-Process -Id $op.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# The Jstar Agent taskbar icon: a status window on double-click (last check-in
# time/result), "Force Inventory Pull" and "View Agent Logs" on the context menu. Runs as the
# logged-in user (see the AtLogOn task registered below, and -Tray excluded from self-elevation
# above), NOT as SYSTEM - a SYSTEM-run task executes in the non-interactive Session 0 and can never
# show a window or tray icon on anyone's actual desktop.
#
# Auto-hides itself whenever Broadsign's or Grassfish's own player process is actually running (a
# timer re-checks every 30 seconds, so it disappears/reappears live as playback starts and stops) -
# this can NEVER show up on top of live public-facing signage content, which is exactly why an
# earlier "Jstar tray status app" was removed outright (see the header at the top of this file). On a
# back-office PC with no player at all, or a signage PC between content-player restarts, it stays
# visible the whole time.
if ($Tray) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # Newer Windows builds can delegate a freshly-spawned console to Windows Terminal instead of the
    # classic conhost.exe, per-user, via HKCU:\Console\%%Startup. That is a completely different
    # window (a separate WindowsTerminal.exe process, not a plain conhost child of the powershell.exe
    # that owns it) with its own show/hide behaviour - -WindowStyle Hidden and the GetConsoleWindow/
    # ShowWindow calls elsewhere in this script both assume the classic console model and have no
    # handle to reach a Windows Terminal window at all, so on a PC where this delegation is active,
    # every hidden spawn (this Tray included) can flash or stay visible with nothing in this script
    # able to catch or close it - not even Close-StrayAgentWindows, since that still only ever sees
    # what a classic console model exposes. Forcing the classic host, exactly what Windows Settings ->
    # For Developers -> Terminal's "Windows Console Host" option does under the hood, sidesteps the
    # gap entirely rather than trying to also hide a second, structurally different window type.
    #
    # Confirmed live on AE1PC119, 2 Sep 2026: a Tray relaunch spawned a real WindowsTerminal.exe at
    # the exact same moment, sitting visibly in the taskbar and reopening every time it was closed
    # (the watchdog simply relaunching the Tray, which hit the same delegation again); setting these
    # two values first, then relaunching, produced a plain conhost.exe child instead and the window
    # stayed gone. Runs here (not SYSTEM) because the key is per-user (HKCU) and the Tray already runs
    # AS that logged-in user - SYSTEM's own HKCU would be the wrong hive entirely. Only writes when a
    # value is actually missing/different, so a healthy PC pays for one registry read most cycles.
    try {
        $consoleStartupKey = "HKCU:\Console\%%Startup"
        $classicConsoleGuid = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}"
        if (-not (Test-Path $consoleStartupKey)) { New-Item -Path $consoleStartupKey -Force | Out-Null }
        $delegation = Get-ItemProperty -Path $consoleStartupKey -ErrorAction SilentlyContinue
        if ($delegation.DelegationConsole -ne $classicConsoleGuid -or $delegation.DelegationTerminal -ne $classicConsoleGuid) {
            New-ItemProperty -Path $consoleStartupKey -Name 'DelegationConsole' -Value $classicConsoleGuid -PropertyType String -Force | Out-Null
            New-ItemProperty -Path $consoleStartupKey -Name 'DelegationTerminal' -Value $classicConsoleGuid -PropertyType String -Force | Out-Null
            Write-AgentLog "Forced classic Console Host delegation (was defaulting to/set to something else) - takes effect on the next console spawn in this session."
        }
    } catch {
        Write-AgentLog "Could not set Console Host delegation: $($_.Exception.Message)"
    }

    $Script:SignagePlayerProcessNames = @('bsp', 'gfplayer')

    function Test-SignagePlayerRunning {
        foreach ($procName in $Script:SignagePlayerProcessNames) {
            if (Get-Process -Name $procName -ErrorAction SilentlyContinue) { return $true }
        }
        return $false
    }

    function Get-TrayStatusText {
        if (-not (Test-Path $StatusFile)) { return "No check-in recorded yet." }
        try {
            $status = Get-Content -Path $StatusFile -Raw | ConvertFrom-Json
            $lastCheckin = try { [DateTime]::Parse($status.lastCheckin).ToLocalTime().ToString("g") } catch { $status.lastCheckin }
            "Last check-in: $lastCheckin\`nResult: $(if ($status.success) { 'OK' } else { 'Failed' })\`n$($status.message)"
        } catch {
            "Could not read status: $($_.Exception.Message)"
        }
    }

    # Custom "J" tray icon (the same brand orange as the dashboard's own HM logo, white glyph) in
    # place of the generic default Windows application icon - embedded as base64 so the agent stays
    # a single file with no separate .ico to ship or lose track of. Falls back to the plain default
    # icon if the embedded bytes ever fail to decode for any reason, so a cosmetic detail can never
    # be the thing that breaks the tray icon outright.
    $JstarTrayIconBase64 = "AAABAAMAEBAAAAEAIADtAwAANgAAACAgAAABACAA/QsAACMEAAAwMAAAAQAgABUWAAAgEAAAiVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOCSURBVDhPJdPdT1t1AMbxc2GUrrScl/a0PS30nNOX01NeLAM2oHSwCQX2wgiMWjbG2xiMvSgsQWbYVMaygZKZSQxzC5ElXqkXRuOV8UL/Au+8I7vc1e+KxEQvvqbbP/B58uTJI2Ubtw7chofCce+JtLMqkunbwk7eEpY9L0xzWkRrx4URGxMRY1iEwoNC13uFFjwh1ECHUJSWAynbuHVY3/Q5bv06jrtGylnBtm5gxudIpBZJpheoi18iGDlLIDJAKNxPQO9BDXYhy62Hktu0JbKND8lkPyHtrJIwb+Lk79N8Zof2vq8odG3Tf/wxxYYHuLUT+PUCWrAbNdCJorQKKdPwQGQbNt6kJ27jlp/TMPqUROYmkdAoSmAAWe8nGhthNPWI7thNPIE2NK0CtAgpk/1UuPWfkbZuk7z4jNTwE+pCk8StWdp6trlY/o1b5/7keseP5OJXKEfXyeszVGnNbwDHXROZ5B0Spx5hTuxihWax6j/gveXfWd6Fx5vw/RJsFv8ibZRQg91cC24S1gr4lJyQUs6KcMxlYgt7WC2rmLVzpDvv0jryDV1DzyiN/Mzu1X/obVynSj1GlX6MorrAoDzPW3JaSMnkkkjUrxBe2seyr2HZ89RFL1JnXkbW+jhd3GPvOnRnP8ZX6R3swlSLDPtv8HYFsO0bwmy9Q/jq11jGFPH4FGZ6jqbBLWLx9/now1c8XfwPN14B86/nC6p5mmvO4/VnhWSZc8LMLROa38E0LmHoIxydfkHLzD4Zd5EvNmCt/DeqdgI1UEAOtGMoBWy5B68vIyTTnBGmOUt49kti9mUioWFOPn+JM7hBz8AuO9tQOvmC6ppW1EAeWTuGIefJ+otU+VJCisUnRJ0+RmTsPpGBVSLyIKe+e0XnrZ+4svaSjXv/4iYm8SttqFoHHqWJo/IQrr+Xd6otIUVjJRGLlYja40QXnqAHirSu/MLcH3B3H8qlX1GUdhStA5/STETpIK+U8PlcjnhtIUWMERGNjRIJnMbITVN3YZ2oU6Zj6lsGJn7Asi/g9efwyjnMYC/HgyUC/hye6gSeI3EhhY0zh5HoecLGWUJKL4ZTJjl4j2hy7PVpguGTmLFz5O1FOqNTKDXv4qlO4q0AntpDSdf7D/Rwv9D1PhGsXFUtCE0riLA9JKzMuMg4kyJrl0VcPyU81SlxxJsSXq8tKulVVcbB/8tntPvtrwieAAAAAElFTkSuQmCCiVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAuSSURBVFhHjZdpcBT3mYen4hTomJ6Znpmenuk5e+5LBwJdSEhIgC6wAKMTCwSDQFwCWRcgwFwyYGTsGBKMYy+bBDt2HOxUtnYdmzibxLvZ2iNHlSu1u1Wp9bdUqnbdvVvFpmo3cfnZ6tYIXN4v+dDVH3/P+3vf/3tYshVXP85ULuqp3IKezp7X09mn9VTmtJ5Mn9ATqTk9npzS48lJPZo4pkfjR/VIbFxXo2N6RC3oYXVUD0ZGdH9wSFcC/bri79N9yg7dq/Tqsq9Hl+VO3SN36JJno+6W1usuaZ3udDfqoqtedzrrdIe46mNLrvLZB/nqr5CpeJZsfoFs/iKZ3DnS2TOkMvMkU3MkUjPEkk8RSxwnGj9CNHYQNbqfiFogrO4mGH6SQGiIQHAQf6Afxb8dn9KL17cZ2deFx9uBJLfj8rTilJpwutbidDZgd6x6YMlVXtNyVc+RqXiGTO4CmawhfvaheDw1Q3xZPHEU9fPikT2EIiMEQsP4gwNF8R34/Fvx+rYge7uL4htxe9pwSetwutfidDXidNYjijWaJV+1aAKkKxb+JIBIdJxQYDd+3xCKMogS6Ef2bcfp7cEpd+Hx9S4BKH8iwJIDi6TzRYCH9p8imT5h2m8ARGNHCSt7UZNHqG5fZH3/6/SOvEv/0Hvs2nGfXd3fZ2vjLWoSE7h9Pdjl9i8ArP8cQMMjgEzlVS1bea0IcJ509mlS2dMkM6dIGA6kZ4gGxomlJqnZ+yatsz+hde/3aOj6Gqvqz5OrmqWqco6m1ZcYaL7DZNv7HGt4h02J01g9LbjkDXjkTbilRwCiCVCHQ1ylWdIVl7VMxRUy+eXoDftPk0qfJJGaJeYbJ93zFepvfETN3jeIZY4R8A7j9w0TCAyjBAbx+vuQfL2IchdObzc5dYwLa+5zpfI+HrkDm9SMJLXhcq9DdH0BIJV/RsuaBbgc/RmSmXlShv2+Q6QLd6m+/RHJhqcJyruJRPajqvsIR/YSDI/g8/fj8W3FJffgkrtxeruwye2Uyy0Ukl/lVvpDAp5urFLDF1Kw7EDugpbNXzLFjdyb4ob93sMk9n2L9J1fEYtPEAnsJxI/hKqOEQrtxq8MmwC5iinqay+wvvZZWqsv0pw5SSYyisvbicVdxdbQGe6oP0WW2hHcdaYDRv5NAEe1AfC0ZhTf58WToePEOhaJfuPnxLLTREMHURNHCUfHCatjJCqOU7vxBUaO/YqnL37K9dPw8hTc3Q/fHYZvdv2O2eq32RCZNiH2K4vcVt5lhbsa0dWIaALUYndUaZZU5oyWzp0zn10qfYpkfIZ47gSB1/6J6LoLxPzjRBMTqLFDhMIFcusX2HLq79l3XWP2eTh3Ca6e+IybE3CnAG8M/ZHr7b9kY/wESWUAj2cjj0k13PG+z4D7BF9y5U0AUazFYQAk0/Nayig8Qzw9R9J3mMCJtwhOvU5MGiOaOIaaOEIoWCCxeo62+Q8ZfPG3FBb/g8krDzhz/g88WwT41hj8WZ9OXt2LTWrB5dmAx7OBcqmRGmmIe86fILjWIDprEcXV2B2VmiWZOqml0vNmxSeS08QzM8gv/5ho5SzR6BGi8aOEI/uJ18zSMP0Dmib+krbC99h57jfsnf1XDh79F6YP/Ibrh3/Pq3v+m5kNf41dasHj7USSO5A87eYTtEg5XnLcY8gxw5edmSJAlWaJJ2c1o+HEk9MkgkcJ9b+IdPdviCsHzL4fiR0iEhsnlp0gHNtHNHmQbMMpoqn9BCLDxJL76H/8LRb2/Y4bIxqT7e/j9LSZz08y37/RAVvM/PeKE7wqvM2XnGnjBSDYKzVLLDGlGdHHk5Mk5API5+/hufwOMU8BNX4YNTqOGj1AJFIgHB4lEi8QCO7EHxpCkreQyR5hz+AHXBn7hLv7P+PQuns4pSKAZ7kDNuNwN+B1tnDDehe3WIdNrEKwVxgAk1o8OUU0foy4PIbz5R+i7L6B6i2YwkuDZ+ndh8K7lp5e81mCkSdxSd20td1gfuK3vHD4f3j9APStuYngaja7n2m/MQHdzebzK3FVc856k4yjk3KxYgkgGp/QYslJs9KjwXEcd35EoPMCUb8BMPZQPKyOosg7qNh0mcqNz+CVt+L2dDO65+9YPG0U4We8eQDa8+cQnE3F6Jfsd7qXRvBjrhyjwgmabQOsdKQR7HnNosaPaIa4kWs1sgQQbJlHDYwWR+6SeEAZJF47RevMfSrWX0D2bCGsPsnMyU+4MvdHbh2HF0c+IR4awCmt/3/Ri656RGcdFY4tKPZGrI4KBCGnWSKxg5pqFJthd6iA4xsfEGibJ6LsLorvJhTZhSJtp2HuPTqvfUS+5SxOezvVdfOcvfQpV+Y+5etTcKznR4juVlNckozqN1pvk9l8bM7VxMVN1Di2IhjidgMgo1nU6H4tahSaOobqHUG8/QOUbZeIeIeL284Ifl8/avVROr7zn2xa+AWx/DiivY3OJ17j4lXMPvDyUzDQ/Ao2Z2PReiN6Y/g0msPHAAiKLay19ROwNVJuz2C1pjVLRC1oRqEZ0aquQaQTf47nyNcIS30EzW1nJ17nZnKjr7DtH2DjpV8gu7rwKr2MTv3aBLh2Em4e/QNN+dkiwPLoXYre6P12cTWKo4kG2xPItjUItixWa0qzhCOj2lKh7SEsD+HrOYP78psEPX3mnucPDeIVe6g590O2/xyaJv8Kl9BCrm6a45d/z7kFeP40HOv7GUH/44iudbjN6Jtwuo3oG3GKxuSrQXLUskXYh9WexWbLYbUmNUsoskszisyINhjcaUbseu3HKOunCUjb8Af78bp6WHP5Q7b/IzRPvYvH2U7nnneYuwHnL8Ll2f+lu+l53O5Ws+rNub+8eLjqcYq1rBQzNNsH6RMO85hNRRCylJcnNEswvFMz8mwsluZm6+hFPn4L+bl7+IVu/IE+vI4Oas5/wNafQe8r/07j0CsUrmnMvAALV+CpsX+mKn0Am2jM/OVn1/hw7tvFVZQ5chyynydla6fElkAQ0pSXxzSLPzSkBcI78RsrtbHZKjtQIoP4vv1T/E0TKGIPHvsGcoWv8/jfwsDbUPg2HL4N08/B+UufsbXzDn6lB4cx693NpvUuQ1ysQxTXsFJMsVYcYNgxWYzeKMAkZeWqZlGCfZqZ60C/Ga35ObpRNp8idPs+itKL7NiAEh+g87v/xfB7sOebcPglOHsLxsZ/SXX+EA7nI/FHW+9qM/KYs52drhkkew1lQhLBmsJqjVNWHtEsin+HFgj24/fvMHd646hQ/Nvw2jcR3Hed6IW38Hq7cZU2EG+dZfOtf2PfG3DsVdgz/WvWty0SCGzGLtYXF86lhcMhrjHFVVc7OzxPkXC0sUKIYhPSpni5NUppWUSz+JRtmj/wBD7/NnOf9/l78fofx+vdjOxoJzL6HOn57+BPDOB4rMpsMKmG42TrjpPM7SUS3fFQ3Ijc6HbljgqsjkoafLvZpkyhiq2sEGJF8STl5VHDfkrLwppF9m3Rlg8Jr7J56aDwbcbr7cErd+IRWgi1Hqf67F+Q6r2Ex9OOdUUeoawau8MosFozauMv2KqwOarJ+fvYnV5ke3gOr6OOlUK8mPcl68uXxCkpDRoAPdqSaI95SMjerqWDwrhyDAC5A5ewFn92J/ldN6keeIFsyxyhxAAer7FqN5st1690UKGOMLz6BoWql6gLjFBuy1AmpMymIwhFcatq5J7SshAlJX7NInu7HiyfUY8+A2JJ3ByrxmLhbEEU6pGUTajVBfJNs9S3LdDUskBr40W6Gq7SXnmKfGgAh72alUISqz2PYMs9rHoj70XrKSsLUlqiPLB4PB0fy3KX7pE36ZK80TylJc8GXfK0626prfi1FE/rdbrobNBtQo1us63WXe61ukdu1SX3WuPU1kusSfOzCjldELK6VcjoVmtKLy9P6GXlUb20LKKXlob10lK/XlKi6CtKvB//H2kE2ypG7hOnAAAAAElFTkSuQmCCiVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAABWqSURBVGhD1ZktjBNBFMcrkUjUe0iCwpAgTyIQ50AiEMhKDAnuEswldIYLmCoCwYAh4C44gqmjCqro7kKOEi5HCSFZ8mY/cvtmlu7He235J7/kMjt78/7T+XgzOxgoKX6IV6IR7pyG19kaJQYvRRbvxRYmscV0NTBNLOxv1FR0gOcTAwexgZkfYBtgEVsYUyfwNlS02Mez1HuxgaUfTF/gaWLwHG9TTJHBO1mP8YYFcR0De7MxnuHtdxb1emzhtdeYKjAR+TVorDefnLJEFiJazXhMjUUTS33IrMLAMhrhDR7bSuU9v9ngCzITzZfcfMxPvX+0UWDx+QFe4LEGtf4J2xADM+pcHm9F2VIZeLknR8+vpT/e3q3wZXzZq7eKxMALHnMpWrZ0Nih0AXORKV6vCbW7ttthAy9IIGsg8CvQBNHqfULSADE3eLVigBIqXkkSaQOxhcOKAbfreZXkEDdgYFmuSLRJeBWEETdAqYbBm8Xw2eMPpdEwQOl3YUB911UysMgN8Afy6BjANE/a/AfSqBmgfJsXaqBnwOIuL9RAzcDc4m1eqIGaATrt8EINfn18w+NPk8cXvXptWcsmRoTE63RBfBX6+mTHKwsNn58fnnn1ujCg+xde2AcK9s/3T+nxu/vu79DQIS1e3fLe7UKxE4sd3kO9zfV7/t57ryuFAbFUuomBLkfJMHlKLbkS/cvAyeSRyMpTQOd3Z8DNA8HTGD/Af3t5XTTwAlqAnIF8GG3nVUotMC2DzwysJ6UQY4TDioHMxP/yK8A0eP2eXebyylvJLo+9lOSSqgNMeMwVuYvd3t+9lDCwrL2VOy3tS64e1A8drm1blcpNq420bqrbA2MeW2O5NGODw4k+oPOYWis7+MtlrI3o+m2sTvk3s0OvIRXcJ9bVq00XZZNb6bOrgVl536mtLAUXupKkfWeEw2B6oC03tEY4bD+8YEITtO9Q+QtN4EOM4LaqMAAAAABJRU5ErkJggg=="
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    try {
        $iconBytes = [Convert]::FromBase64String($JstarTrayIconBase64)
        # The unary comma is load-bearing: New-Object spreads an array argument's ELEMENTS as
        # separate positional constructor arguments unless told otherwise, so without it this fails
        # every time with "Cannot find an overload... argument count: 1861" (one per byte) - caught
        # below and silently falling back to the default icon, so the fix would have looked like it
        # shipped while quietly never actually working. Confirmed live before shipping.
        $iconStream = New-Object System.IO.MemoryStream(,$iconBytes)
        $notifyIcon.Icon = New-Object System.Drawing.Icon($iconStream)
    } catch {
        $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
    }
    $notifyIcon.Text = "Jstar Agent"
    $notifyIcon.Visible = -not (Test-SignagePlayerRunning)

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $menuForce = $menu.Items.Add("Force Inventory Pull")
    $menuLogs = $menu.Items.Add("View Agent Logs")
    $menu.Items.Add("-") | Out-Null
    $menuExit = $menu.Items.Add("Close")
    $notifyIcon.ContextMenuStrip = $menu

    # Runs the SAME installed script (not a re-implementation of Invoke-Checkin here) as a plain child
    # process, deliberately without -Verb RunAs - a repeated UAC prompt on every button click would be
    # worse UX than the (rare) admin-only step inside it - registry/task-registration - silently no-op
    # skipping this one time via its own existing try/catch, same as it already does if that step ever
    # fails for any other reason. The actual check-in POST itself needs no special privilege.
    $menuForce.add_Click({
        try {
            Start-Process powershell.exe -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "\`"$InstalledScriptPath\`"", "-Once") -WindowStyle Hidden
            $notifyIcon.ShowBalloonTip(4000, "Jstar Agent", "Forcing a check-in now...", [System.Windows.Forms.ToolTipIcon]::Info)
        } catch {
            $notifyIcon.ShowBalloonTip(4000, "Jstar Agent", "Could not start check-in: $($_.Exception.Message)", [System.Windows.Forms.ToolTipIcon]::Error)
        }
    })
    $menuLogs.add_Click({
        if (Test-Path $LogFile) {
            Start-Process notepad.exe -ArgumentList "\`"$LogFile\`""
        } else {
            $notifyIcon.ShowBalloonTip(4000, "Jstar Agent", "No log file yet.", [System.Windows.Forms.ToolTipIcon]::Info)
        }
    })
    $menuExit.add_Click({ $notifyIcon.Visible = $false; [System.Windows.Forms.Application]::Exit() })

    $notifyIcon.add_DoubleClick({
        [System.Windows.Forms.MessageBox]::Show((Get-TrayStatusText), "Jstar Agent Monitor", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    })

    # Also drives the popup scan every tick (see Get-UnexpectedWindows, defined well above this
    # branch for exactly this reason) - this is the ONLY place in the whole agent that can ever see
    # the actual desktop. A SYSTEM check-in runs in Session 0, which cannot see another session's
    # windows at all: confirmed live on PC-88AEDD6212C8, 26 Aug 2026 - a Windows Security dialog was
    # visibly covering the signage content and a Session-0 scan still found zero windowed processes,
    # so no popup could ever have been reported, regardless of what the allowlist said. Writing an
    # in-process function call onto an already-running Timer costs nothing extra - unlike spawning a
    # new powershell.exe for it, which is exactly what the note right below this warns against.
    # Written on every tick regardless of whether the result changed; SYSTEM's own check-in already
    # does the "is this actually new" comparison against $PopupStateFile; duplicating that logic here
    # would just be a second place for the two to disagree.
    $visibilityTimer = New-Object System.Windows.Forms.Timer
    $visibilityTimer.Interval = 30000
    $visibilityTimer.add_Tick({
        # Belt-and-suspenders alongside the two hides taken at Tray startup (top of script, and again
        # right before Application::Run() below): Close-StrayAgentWindows deliberately excludes its
        # OWN process id (see that function's header) so it can never be the thing that catches the
        # Tray's own console if it is ever visible - nothing else in the agent can see across the
        # SYSTEM/session boundary to do it either. Re-hiding on every tick means even a failure mode
        # nothing above anticipated self-corrects within 30 seconds instead of sitting there until a
        # person notices and closes it by hand.
        try {
            $ownConsoleWindow = [WorkspaceDirectoryAgent.Win32]::GetConsoleWindow()
            if ($ownConsoleWindow -ne [IntPtr]::Zero) { [WorkspaceDirectoryAgent.Win32]::ShowWindow($ownConsoleWindow, 0) | Out-Null } # 0 = SW_HIDE
        } catch {}
        $notifyIcon.Visible = -not (Test-SignagePlayerRunning)
        Close-StrayAgentWindows
        try {
            $unexpected = @(Get-UnexpectedWindows)
            New-Item -ItemType Directory -Path $DuHandoffDir -Force -ErrorAction SilentlyContinue | Out-Null
            (@{ at = (Get-Date).ToUniversalTime().ToString("o"); unexpected = $unexpected } | ConvertTo-Json -Compress -Depth 4) |
                Set-Content -Path $PopupHandoffFile -Encoding utf8 -NoNewline
        } catch {
            # Silently skipped, same as every other best-effort write in this agent - a scan that
            # fails to persist this tick tries again in 30 seconds, and SYSTEM's staleness check
            # (see Invoke-Checkin) already treats an old handoff as "no data" rather than trusting it
            # forever, so a few missed ticks in a row degrade gracefully instead of reporting stale
            # popup state as current.
        }
    })
    $visibilityTimer.Start()

    # NOTE: the tray deliberately does NOT drive the DU scrape. An earlier version had a 5-minute
    # timer here that spawned -DuScrapeOnce, which was replaced by the dedicated
    # WorkspaceDirectoryAgentDuScrape task (see Start-DuScrapeInUserSession) - started by the SYSTEM
    # check-in only when the shared gate says a scrape is actually due. Leaving both in place ran
    # the same work twice AND launched a PowerShell child on the logged-in user's desktop every 5
    # minutes forever: powershell.exe allocates a console window before -WindowStyle Hidden can
    # take effect, so each spawn flashed a visible window on machines that are supposed to show
    # nothing at all. Reported from a real test PC.

    # Second, defensive self-hide, specifically for the Tray. The one hide call every invocation of
    # this script gets (near the very top, before $Tray is even known) runs inside a silent
    # try/catch, so a transient failure there - Add-Type contending with something else on a slow
    # logon, a delayed console handle, anything that never surfaces because the catch swallows it -
    # leaves NOTHING to ever notice or correct it, for a process that unlike every other spawn point
    # never exits on its own. A short-lived spawn (-PollOnce, -DuScrapeOnce) self-resolves within
    # minutes even if its console briefly shows; the Tray runs for as long as the user is logged in,
    # so the same failure here means the window sits there indefinitely - and gets a fresh PID (and a
    # fresh chance to repeat) every time it is closed and the self-healing Start-ScheduledTask call
    # above brings it back. Calling ShowWindow(0) on a window that is already hidden is a harmless
    # no-op, so this costs nothing on every PC where the first hide already worked.
    try {
        $trayConsoleWindow = [WorkspaceDirectoryAgent.Win32]::GetConsoleWindow()
        if ($trayConsoleWindow -ne [IntPtr]::Zero) { [WorkspaceDirectoryAgent.Win32]::ShowWindow($trayConsoleWindow, 0) | Out-Null } # 0 = SW_HIDE
    } catch {}

    [System.Windows.Forms.Application]::Run()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    exit 0
}

# The taskbar tray icon (see the -Tray branch above) is a separate, always-running process in
# whichever user is logged in, not covered by the fire-once-and-exit main/poll tasks, so it
# needs its own explicit stop here rather than just relying on the scheduled task being gone.
# Best-effort only: if it can't be found/killed for some reason, uninstall still proceeds - a leftover
# tray process is harmless (it'll exit at the next logoff either way) compared to blocking removal.
function Stop-TrayProcesses {
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match '-Tray\\b' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
}

# Shared by both uninstall paths below: the interactive -Uninstall (password-gated) and the
# dashboard's remote "Uninstall Agent" button on a removed-but-still-reporting device (::UNINSTALL
# pending command, see Invoke-PendingCommand) - same cleanup either way, just gated differently.
function Invoke-UninstallCleanup {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-ScheduledTask -TaskName $TrayTaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    # Must run BEFORE the Remove-Item below deletes $ServiceExePath out from under it - stop+uninstall
    # via WinSW itself when it's still on disk, falling back to sc.exe delete (which needs no exe at
    # all) for the rare case the wrapper is already gone but Windows still has the service registered.
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        try {
            if (Test-Path $ServiceExePath) {
                & $ServiceExePath stop 2>&1 | Out-Null
                & $ServiceExePath uninstall 2>&1 | Out-Null
            } else {
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
                & sc.exe delete $ServiceName | Out-Null
            }
        } catch {}
    }
    Stop-TrayProcesses
    Remove-Item -Path $StateDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Gated behind the password set in Settings > Integrations > Jstar Agent > Client
# Uninstall Password (stored/baked in as a SHA-256 hash only, never the plaintext) - so removing
# the agent from a kiosk/back-office PC needs someone who actually has that password, not just
# physical/admin access to the machine. Runs before self-update or anything network-related since
# a PC being uninstalled shouldn't matter what version it's currently on.
if ($Uninstall) {
    if (-not $UninstallPasswordHash) {
        Write-Warning "No uninstall password has been set yet (Settings > Integrations > Jstar Agent > Client Uninstall Password on the dashboard). Set one there, Save, then Publish Latest Agent Version before this PC can be uninstalled."
        exit 1
    }
    $securePwd = Read-Host "Enter the Digital Directory client uninstall password" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd)
    $plainPwd = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $enteredHash = ([BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($plainPwd))) -replace '-', '').ToLower()
    if ($enteredHash -ne $UninstallPasswordHash) {
        Write-Warning "Incorrect password. Uninstall cancelled."
        exit 1
    }
    Write-Host "Password confirmed - removing the Jstar Agent from this PC..." -ForegroundColor Yellow
    Invoke-UninstallCleanup
    Write-Host "Jstar Agent uninstalled from this PC (scheduled tasks removed, local state deleted)." -ForegroundColor Green
    Write-Host "Note: this PC's row on the dashboard is left as-is (last known state) - remove it there separately if needed."
    exit 0
}

# Appends one line per attempt (capped to the last 200) and refreshes status.json - a plain text/
# JSON trail on disk for remote troubleshooting (queue "Get-Content $env:ProgramData\WorkspaceDirectoryAgent\agent.log"
# as a Run Command to read it back) since there's no on-screen status window on these signage PCs.
function Write-AgentLog($message) {
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) - $message"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    $lines = @(Get-Content -Path $LogFile -ErrorAction SilentlyContinue)
    if (-not $lines) { return }
    # Every line here is written by this SAME function in a fixed "yyyy-MM-dd HH:mm:ss - ..."
    # shape, so its age is always the first 19 characters - parsed with an explicit format/culture
    # rather than PowerShell's implicit [datetime] cast, which is locale-dependent and could
    # misread a line as a future or ancient date. A line that fails to parse at all (hand-edited,
    # corrupted, or from a build that logged differently) is kept rather than guessed at - "can't
    # tell how old this is" isn't the same as "this is old enough to drop".
    $cutoff = (Get-Date).AddDays(-30)
    $kept = @($lines | Where-Object {
        $ts = $null
        if ($_.Length -ge 19) {
            try { $ts = [datetime]::ParseExact($_.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture) } catch {}
        }
        (-not $ts) -or ($ts -ge $cutoff)
    })
    # The 200-line cap stays alongside the 30-day one rather than being replaced by it - a PC
    # failing loudly can write hundreds of lines within a single day, and date-based pruning alone
    # wouldn't catch that until a month later.
    if ($kept.Count -gt 200) { $kept = $kept[-200..-1] }
    if ($kept.Count -ne $lines.Count) { $kept | Set-Content -Path $LogFile -Encoding utf8 }
}

function Write-AgentStatus($success, $message) {
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    @{ lastCheckin = (Get-Date).ToString("o"); success = $success; message = $message } |
        ConvertTo-Json | Set-Content -Path $StatusFile -Encoding utf8
}

# Centralized-deployment half of the agent: compares this running script's own file content against
# whatever's currently Published in Settings > Integrations > Jstar Agent, and if they
# differ, overwrites itself and re-execs the NEW version immediately (so the rest of this run - task
# registration, poll registration, check-in - already uses the updated logic), then exits so the stale
# in-memory copy never continues. Runs before anything else so a PC in a remote location never needs
# a physical reinstall for a shell-level change again - only the Data Collector Script above already
# worked this way; this is what extends the same idea to the shell itself. Line-ending differences
# are normalized before comparing so a whitespace-only mismatch can't cause a self-update loop.
# $OriginalArgs is passed in from the CALL SITE below rather than read here, because
# $PSBoundParameters inside a function refers to THAT FUNCTION's own bound parameters - and this
# function declares none, so it was always an empty hashtable. Splatting it re-ran the updated
# script with no switches at all: a "-PollOnce" cycle that happened to self-update came back as a
# flagless full run, sailing past the "if ($PollOnce) { ...; exit }" guard into task re-registration
# and a full heavyweight check-in. Confirmed live in the agent log - the tell was
# "Applied signage notification-suppression policy" (a line only a flagless run can reach) appearing
# on 20-minute poll cycles right after each "Agent updated..." entry. At the top-level script scope
# where it is now read, $PSBoundParameters is the SCRIPT's own switches, which is what was intended.
function Invoke-SelfUpdate($OriginalArgs) {
    if (-not (Test-Path $InstalledScriptPath)) { return }
    try {
        # VERSION FIRST, script only if it actually differs. The shell body is ~100KB and this runs
        # on every single cycle, so unconditionally downloading it just to discover it was
        # byte-identical cost roughly 211MB per device per month - on the very metered SIM plan this
        # whole feature exists to measure. The "?meta=1" response is a couple of dozen bytes.
        # hostname identifies this PC to the shell endpoint so a Publish can be scoped to a small
        # set of test machines instead of the whole fleet (see workspace-directory-agent-shell).
        # An agent that does not send it - anything older than this build - is always served the
        # STABLE slot, which is the safe default: an unknown device never receives a canary build.
        $hostQ = "&hostname=" + [uri]::EscapeDataString($env:COMPUTERNAME)
        $metaResp = Invoke-RestMethod -Method Get -Uri ($AgentShellUrl + "?meta=1" + $hostQ) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15
        if (-not $metaResp -or $null -eq $metaResp.version) { return }
        $publishedVersion = [string]$metaResp.version
        $installedVersion = if (Test-Path $ShellVersionFile) { (Get-Content -Path $ShellVersionFile -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }

        # Matching versions means the script on disk is already the published one - nothing to
        # download. The version file is only ever written after a successful overwrite below (or on
        # the first run, once the content comparison has confirmed they match), so it can't claim to
        # be current when it isn't.
        if ($installedVersion -and $installedVersion -eq $publishedVersion) { return }

        # Either a genuinely new version, or this agent has no version file yet (a fresh install, or
        # one upgrading from a build that predates version tracking). Both need the full body: the
        # first to apply it, the second to establish the baseline. This is the ONLY path that
        # downloads ~100KB, and after it runs once the check above short-circuits every later cycle.
        $resp = Invoke-RestMethod -Method Get -Uri ($AgentShellUrl + "?hostname=" + [uri]::EscapeDataString($env:COMPUTERNAME)) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30
        if (-not $resp -or -not $resp.script) { return }
        $normalize = { param($t) $t -replace "\`r\`n", "\`n" -replace "\`r", "\`n" }
        $current = & $normalize (Get-Content -Path $InstalledScriptPath -Raw)
        $incoming = & $normalize $resp.script
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        if ($incoming -ne $current) {
            # NEVER overwrite a working agent with a script that cannot run. PowerShell refuses to
            # execute a file with a syntax error AT ALL - not the bad line, the whole file - so a
            # malformed publish does not degrade the agent, it deletes it: no check-in, no poll, and
            # critically no self-update, which is the very mechanism that would otherwise deliver
            # the fix. The agent cannot heal itself because the healing code is in the file that
            # will not parse, so recovery needs a human at each machine.
            #
            # That is exactly what v48 did to three test PCs on 25 Aug 2026 (a backslash eaten by
            # the JavaScript template this script is generated from). Parsing the incoming text
            # first turns that class of mistake back into a no-op: the agent keeps running the last
            # known-good version, says so in its log, and picks up the corrected build automatically
            # on a later cycle. Costs one parse of ~150KB on the rare cycle where a version differs.
            $parseErrors = $null
            [System.Management.Automation.Language.Parser]::ParseInput($resp.script, [ref]$null, [ref]$parseErrors) | Out-Null
            if ($parseErrors -and $parseErrors.Count -gt 0) {
                $firstError = $parseErrors[0]
                Write-AgentLog "REFUSED published version $publishedVersion - it has $($parseErrors.Count) syntax error(s), first at line $($firstError.Extent.StartLineNumber): $($firstError.Message). Staying on the current version."
                # Deliberately does NOT record the version as installed, so the next cycle re-checks
                # and adopts the moment a corrected build is published.
                return
            }
            Set-Content -Path $InstalledScriptPath -Value $resp.script -Encoding utf8 -NoNewline
            # Written BEFORE the re-exec, so the child process sees the new version as already
            # installed and skips straight past its own self-update instead of fetching again.
            Set-Content -Path $ShellVersionFile -Value $publishedVersion -Encoding utf8 -NoNewline
            Write-AgentLog "Agent updated to published version $publishedVersion - re-running with the new logic now."
            if ($OriginalArgs -and $OriginalArgs.ContainsKey('Service') -and $OriginalArgs['Service']) {
                # A -Service process is meant to run for weeks or months straight. Recursing in-place
                # like the branch below would add one stack frame per future update for as long as it
                # stays up, eventually exhausting it - a slow-motion version of exactly the kind of
                # self-inflicted outage this whole redesign exists to rule out. Exiting non-zero
                # instead hands control back to WinSW, whose onfailure policy (see the service XML
                # below) relaunches the script fresh - a clean process that just reads the file
                # already written above, not a recursive call into it.
                Write-AgentLog "Exiting for a clean service restart onto the new version."
                exit 111
            }
            if ($OriginalArgs -and $OriginalArgs.Count -gt 0) {
                & $InstalledScriptPath @OriginalArgs
            } else {
                & $InstalledScriptPath
            }
            exit
        }
        # Content already matched despite no/stale version file - just record the baseline so this
        # agent never pays for the full download again.
        Set-Content -Path $ShellVersionFile -Value $publishedVersion -Encoding utf8 -NoNewline
    } catch {
        Write-Warning "Self-update check failed, continuing with the currently-installed version: $($_.Exception.Message)"
    }
}
Invoke-SelfUpdate $PSBoundParameters

function Invoke-DefaultCollector {
${indented}
}

# Same version-first treatment as Invoke-SelfUpdate above, except this script is actually NEEDED on
# every run (it's what gathers the data), so instead of just skipping the download it's kept in a
# local cache file and re-read from disk whenever the published version still matches. The collector
# is ~11KB and changes maybe a few times a year, so re-downloading it on every 20-minute poll was
# ~22MB per device per month of pure waste on a metered plan.
#
# Falls back to a full fetch whenever anything is off - no version file, no cache file, a version
# mismatch, or an unreadable cache - so a corrupted or half-written cache can never leave the agent
# running stale collection logic. Returns $null on total failure, which makes Invoke-Checkin use the
# built-in Invoke-DefaultCollector instead, exactly as before.
function Get-RemoteCollectorScript {
    try {
        $metaResp = Invoke-RestMethod -Method Get -Uri ($CollectorUrl + "?meta=1") -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15
        $publishedVersion = if ($metaResp -and $null -ne $metaResp.version) { [string]$metaResp.version } else { $null }

        if ($publishedVersion) {
            $cachedVersion = if (Test-Path $CollectorVersionFile) { (Get-Content -Path $CollectorVersionFile -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }
            if ($cachedVersion -eq $publishedVersion -and (Test-Path $CollectorCacheFile)) {
                $cached = Get-Content -Path $CollectorCacheFile -Raw -ErrorAction SilentlyContinue
                if (-not [string]::IsNullOrWhiteSpace($cached)) { return $cached }
            }
        }

        $resp = Invoke-RestMethod -Method Get -Uri $CollectorUrl -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30
        if ($resp -and $resp.script) {
            try {
                New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
                Set-Content -Path $CollectorCacheFile -Value $resp.script -Encoding utf8 -NoNewline
                # Version written only AFTER the body is safely on disk, so an interrupted write can
                # never leave a version file pointing at a truncated cache.
                if ($null -ne $resp.version) { Set-Content -Path $CollectorVersionFile -Value ([string]$resp.version) -Encoding utf8 -NoNewline }
            } catch { Write-AgentLog "Could not cache the collector script locally: $($_.Exception.Message)" }
            return $resp.script
        }
    } catch {
        Write-Warning "Could not fetch remote collector script: $($_.Exception.Message)"
        # Network failed, but a previously cached copy is still better than falling all the way back
        # to the built-in default - it's whatever was last published, just not re-verified today.
        try {
            if (Test-Path $CollectorCacheFile) {
                $cached = Get-Content -Path $CollectorCacheFile -Raw -ErrorAction SilentlyContinue
                if (-not [string]::IsNullOrWhiteSpace($cached)) {
                    Write-AgentLog "Using the locally cached collector script after a failed fetch."
                    return $cached
                }
            }
        } catch {}
    }
    return $null
}

# Runs an admin-queued command locally and caches its output to report on the NEXT check-in,
# rather than opening a second connection just to report it now. A command whose first line is
# exactly "::BATCH" (a real, valid no-op line in a .bat file, so it doubles as the marker with no
# extra field/column needed) is everything AFTER that line, written out to a temp .bat and run via
# cmd.exe /c instead of Invoke-Expression - lets the dashboard deploy a full batch script, not just
# a single PowerShell one-liner. Runs invisibly either way: this whole task already executes as
# SYSTEM in a non-interactive session (no signage-screen popups), so cmd.exe here never gets a
# window to show even without an explicit -WindowStyle.
# Ends a one-shot command branch that has already POSTed its own result. Exiting 0 is correct for a
# -Once/-PollOnce process, which is what these branches were originally written for - but
# Invoke-PendingCommand is ALSO reached from inside the -Service loop (the loop calls Invoke-Checkin,
# which calls this), and there a clean exit 0 terminates the SERVICE itself. WinSW restarts on
# failure only: a service that exits 0 has "completed successfully" as far as it is concerned, and is
# left stopped.
#
# That is not a theoretical path. It is what took ADCOOP-MINA-AR offline for 3h48m on 1 Sep 2026
# (its service log ends mid-stride on "Checked in successfully", WIN32_EXIT_CODE 0, both Scheduled
# Tasks disabled by the service migration so nothing could restart it), and it took CARREFOURLCD and
# DM02-LED-NESTO- down within minutes of a Check Data Usage being queued against them at 20:25 and
# 20:26 Dubai the same evening. Clicking that button on a service-based PC killed its agent.
#
# 111 is the same deliberate non-zero code Invoke-SelfUpdate already uses to hand control back to
# WinSW for a clean relaunch, so the loop comes back in about ten seconds instead of the PC going
# silent until someone runs sc start by hand.
function Exit-OneShotCommand {
    if ($Service) {
        Write-AgentLog "One-shot command finished inside the service - exiting 111 so WinSW relaunches the loop instead of leaving the service stopped."
        exit 111
    }
    exit 0
}

function Invoke-PendingCommand($command) {
    # A dashboard-queued remote uninstall (the "Uninstall Agent" button on a removed-but-still-
    # reporting device) - distinct from the interactive -Uninstall flow's password prompt above,
    # since queuing this already required being signed into the dashboard with delete permission on
    # this exact device; that authentication IS the authorization; a second local password check
    # would just be unreachable anyway (this runs completely non-interactively as SYSTEM). Reports
    # success back with its own immediate POST instead of the normal cache-for-next-cycle path used
    # below, since there IS no next cycle once the scheduled tasks are gone.
    # A dashboard-queued Windows computer rename: "::RENAME NEW-NAME". Windows only applies a rename
    # at boot, so this reports the result FIRST and reboots afterwards - if it restarted immediately
    # the dashboard would never learn whether the rename succeeded, and the PC would come back under
    # a name nothing was expecting.
    #
    # The hostname is also the key the server upserts on, so a renamed PC checking in would look
    # like a brand-new device and silently orphan its old row (losing its Location, Notes, linked
    # SIM Card and history). To prevent that, the OLD name is recorded to disk here and reported
    # once, as "previousHostname", on the first check-in after the reboot -
    # workspace-directory-checkin uses it to rename the existing row instead of inserting a new one.
    if ($command -like '::RENAME *') {
        $newName = $command.Substring(9).Trim()
        $currentName = $env:COMPUTERNAME
        $result = $null
        # Windows computer-name rules, enforced here as well as in the dashboard's own form: 1-15
        # characters, letters/digits/hyphen only, not entirely numeric. An invalid name would fail
        # at Rename-Computer anyway, but failing here gives a clear message instead of a raw
        # .NET exception, and costs nothing.
        if ([string]::IsNullOrWhiteSpace($newName)) {
            $result = "ERROR: No new name supplied."
        } elseif ($newName.Length -gt 15) {
            $result = "ERROR: '$newName' is $($newName.Length) characters - Windows computer names are limited to 15."
        } elseif ($newName -notmatch '^[A-Za-z0-9\\-]+$') {
            $result = "ERROR: '$newName' contains characters Windows does not allow in a computer name (letters, digits and hyphens only)."
        } elseif ($newName -match '^[0-9]+$') {
            $result = "ERROR: '$newName' is all digits - Windows does not allow an entirely numeric computer name."
        } elseif ($newName -eq $currentName) {
            $result = "This PC is already named '$newName' - nothing to do, and no restart was triggered."
        } else {
            try {
                Rename-Computer -NewName $newName -Force -ErrorAction Stop
                New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
                # Written only AFTER the rename is accepted, so a failed rename never leaves a
                # marker that would make the server migrate a row that never moved.
                Set-Content -Path $RenamedFromFile -Value $currentName -Encoding utf8 -NoNewline
                Write-AgentLog "Renamed this PC from '$currentName' to '$newName' - restarting to apply."
                $result = "Renamed from '$currentName' to '$newName'. Restarting now to apply - this PC will check back in under its new name in a few minutes."
            } catch {
                $result = "ERROR: Rename to '$newName' failed: $($_.Exception.Message)"
            }
        }

        $renameSucceeded = $result -like 'Renamed from *'
        try {
            $renamePayload = @{ hostname = $currentName; light = $true; commandOutput = $result } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $renamePayload -ContentType "application/json" -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 20 | Out-Null
        } catch { Write-AgentLog "Could not report the rename result before restarting: $($_.Exception.Message)" }

        if ($renameSucceeded) {
            # Restart-Computer rather than shutdown.exe: no countdown balloon or console message on
            # the signage screen, which is the whole point of this agent running headless. The short
            # sleep is only to let the POST above finish flushing before the box goes down.
            Start-Sleep -Seconds 5
            try { Restart-Computer -Force -ErrorAction Stop } catch { Write-AgentLog "Rename applied but the restart failed - it will apply at the next reboot: $($_.Exception.Message)" }
        }
        # Reached when the rename did NOT restart the box (it failed, or renameSucceeded was false),
        # so the process really does carry on afterwards - and inside the service that must not be a
        # clean exit. See Exit-OneShotCommand.
        Exit-OneShotCommand
    }

    # A dashboard-queued "Check Data Usage" (the button on a device's Details panel): re-runs the
    # mydata.du.ae scrape right now instead of waiting for the next daily boundary.
    #
    # Deliberately NOT implemented as the plain Run Command "Get-DuDataUsage | ConvertTo-Json" that
    # an admin could type by hand: that only ever lands as text in Last Command Output, so the
    # figures don't reach du_data_*/du_scrape_outcome and the Data Usage column doesn't move - which
    # makes it useless as the answer to "what is this PC using right now". Going through
    # Invoke-DuScrape and POSTing a real check-in payload means an on-demand check updates exactly
    # what a scheduled one updates.
    #
    # Posts and exits rather than caching a result for the normal report-on-next-cycle path, same as
    # ::UNINSTALL below: the payload has to carry the du fields, which that path can't express (it
    # sends commandOutput only), and commandOutput being present here is also what clears
    # pending_command server-side so this doesn't re-run every cycle forever. Resetting the local
    # gate is what makes it a genuinely fresh reading - and it deliberately consumes the day's
    # attempt, so a manual check at 14:00 means the next automatic one is tomorrow morning, not
    # twenty minutes later.
    if ($command -eq '::DUCHECK') {
        # Hand it to the user session first, exactly as the scheduled path does. A queued command
        # runs as SYSTEM, and headless Edge renders nothing in Session 0 - confirmed live, even
        # about:blank came back as 0 bytes - so scraping inline here would fail on every PC that
        # has a logged-in user, which is precisely the case this button is pressed in. Clearing the
        # local gate first is what makes the delegated run consider a scrape due at all; without it
        # a device that already answered today would simply decline and the button would do nothing.
        Remove-Item -Path $DuScrapeStateFile -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $DuHandoffFile -Force -ErrorAction SilentlyContinue
        if (Start-DuScrapeInUserSession) {
            # That run reports its own figures directly (see the -DuScrapeOnce branch), so there is
            # nothing to POST here - only the acknowledgement that it was started.
            $ackPayload = @{ hostname = $env:COMPUTERNAME; light = $true; commandOutput = "Data usage check started in the logged-in user's session - figures follow within a minute." }
            try {
                Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body ($ackPayload | ConvertTo-Json -Compress) -ContentType "application/json" \`
                    -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30 | Out-Null
            } catch {}
            Exit-OneShotCommand
        }
        # No interactive session to hand it to (nobody logged in). Falling back to scraping here is
        # still worth doing - it costs one browser launch and correctly records 'error' rather than
        # a bogus "no SIM" verdict, so the dashboard shows why instead of going quiet.
        $duResult = Invoke-DuScrape
        $duPayload = @{
            hostname = $env:COMPUTERNAME
            light = $true
            duScrapeAttemptedAt = $duResult.at
            duScrapeOutcome = $duResult.outcome
        }
        if ($duResult.note) { $duPayload.duScrapeNote = $duResult.note }
        Add-DuFiguresToPayload $duPayload $duResult
        $duPayload.commandOutput = switch ($duResult.outcome) {
            "ok" { "Data usage checked: $($duResult.du.dataUsedGb) GB used of $($duResult.du.dataTotalGb) GB ($($duResult.du.phoneNumber))." }
            "nodata" { "Data usage checked - du reported nothing for this connection, so there is no SIM behind this PC (Wi-Fi/LAN)." }
            default { "Data usage check could not complete: $($duResult.note)" }
        }
        try {
            Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body ($duPayload | ConvertTo-Json -Compress) -ContentType "application/json" \`
                -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30 | Out-Null
            Write-AgentLog "On-demand data usage check reported: $($duResult.outcome)"
        } catch {
            # Nothing to fall back on - the figures are already saved to local state, so the next
            # ordinary check-in re-reports the attempt record (see Invoke-Checkin). The pending
            # command stays queued because the server never heard a commandOutput, which means this
            # retries on the next cycle rather than being silently dropped.
            Write-AgentLog "On-demand data usage check could not be reported: $($_.Exception.Message)"
        }
        Exit-OneShotCommand
    }

    if ($command -eq '::UNINSTALL') {
        Invoke-UninstallCleanup
        try {
            $finalPayload = @{ hostname = $env:COMPUTERNAME; light = $true; commandOutput = "Agent uninstalled remotely from the dashboard - scheduled tasks removed, local state cleared." } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $finalPayload -ContentType "application/json" -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15 | Out-Null
        } catch {}
        # Deliberately a plain exit 0, NOT Exit-OneShotCommand: the agent has just uninstalled
        # itself, so the service stopping and staying stopped is the intended end state. Relaunching
        # the loop here would resurrect an agent that was explicitly removed.
        exit 0
    }
    # Runs the actual command in a SEPARATE CHILD process (re-invoking this same script file with
    # -RunCommandFile, see that branch above) with a hard timeout, rather than inline here - a
    # command that launches a browser (Get-DuDataUsage) can take long enough that something else
    # (the scheduled task's own runtime limit, Windows itself) kills this whole process before it
    # ever writes its cached result, which then silently re-queues the exact same command forever
    # since the dashboard never hears back either way (confirmed on a real device: the same
    # Get-DuDataUsage command re-ran identically across three separate check-in cycles with no
    # result ever reported). Killing the CHILD after a bound instead means SOMETHING - even just
    # "timed out" - always makes it into $PendingResultFile.
    $timeoutMs = 3 * 60 * 1000
    $inputFile = Join-Path $StateDir "pending-command-input.txt"
    try {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Content -Path $inputFile -Value $command -Encoding utf8 -NoNewline
        # $InstalledScriptPath/$inputFile are individually double-quoted here (not just passed as
        # plain array elements) - Start-Process -ArgumentList does NOT auto-quote elements containing
        # spaces, and BOTH of these are real-world paths that commonly do (this repo's own path has
        # one) - confirmed live: without the explicit quotes, Windows silently truncates the path at
        # its first space and the child process fails immediately with a bogus ".ps1 extension"
        # error, which would have made every Run Command mysteriously do nothing forever on any PC
        # whose install path has a space in it.
        $proc = Start-Process powershell.exe -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", "\`"$InstalledScriptPath\`"", "-RunCommandFile", "\`"$inputFile\`"") -PassThru -WindowStyle Hidden
        if (-not $proc.WaitForExit($timeoutMs)) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            @{ output = "Command timed out after $([int]($timeoutMs / 1000)) seconds and was terminated."; ranAt = (Get-Date).ToString("o") } |
                ConvertTo-Json | Set-Content -Path $PendingResultFile -Encoding utf8
        }
    } catch {
        @{ output = "Failed to launch command: $($_.Exception.Message)"; ranAt = (Get-Date).ToString("o") } |
            ConvertTo-Json | Set-Content -Path $PendingResultFile -Encoding utf8
    } finally {
        Remove-Item -Path $inputFile -Force -ErrorAction SilentlyContinue
    }
}

# The headless browser every scrape strategy below needs, in the order they prefer it (Edge first -
# it ships with Windows, so it's the one that's actually there on a stock kiosk build; Chrome only
# if Edge somehow isn't). Machine-wide install paths only: a per-user Chrome (%LOCALAPPDATA%) is
# deliberately NOT probed, since the agent runs as SYSTEM and cannot count on any particular user's
# profile being present. Shared rather than repeated inside each strategy so "which browsers do we
# look for" has exactly one answer - the check-in's own attempt note (see Invoke-Checkin) needs to
# ask the same question to report "no browser" as a distinct outcome from "the page told us
# nothing", and a fourth divergent copy of the list is how those two quietly stop agreeing.
# Flags shared by all three scrape strategies to keep a once-a-day page load from costing far more
# than the page itself. These PCs are on metered cellular SIMs, so this is real money, not tidiness.
#
#   --disable-component-update      Chromium otherwise checks for (and downloads) component updates
#                                   on startup - widevine, certificate revocation lists, origin
#                                   trials and so on. That is dwarfed by nothing on a page this
#                                   small, and it repeats on EVERY launch.
#   --disable-background-networking Stops the variations/field-trial and metrics fetches that a
#                                   fresh launch fires off before the page is even requested.
#   --blink-settings=imagesEnabled=false
#                                   The scrape reads text - a phone number and two usage figures.
#                                   Images are pure waste here, and du's portal is image-heavy.
#   --no-default-browser-check      One more startup round-trip nobody needs on a headless run.
$DuBrowserFrugalArgs = @("--disable-component-update", "--disable-background-networking", "--disable-sync", "--no-default-browser-check", "--blink-settings=imagesEnabled=false")

# A STABLE profile directory, reused across scrapes, rather than a fresh GUID one each time.
#
# The original reason for a throwaway profile was to guarantee no cookie or session from a previous
# scrape (or a different SIM) could make du show stale or wrong-account data. --incognito already
# guarantees that - nothing is written back to the profile at all - so the throwaway directory was
# buying isolation that was already paid for, while forcing Chromium through full first-run setup on
# every single launch: creating the profile tree, seeding preferences, and fetching components. That
# first run is a large part of why Edge showed up as one of the heaviest data consumers on a signage
# PC nobody browses on. Reusing one directory keeps the isolation and drops the repeated setup.
$DuBrowserProfileDir = Join-Path $StateDir "du-browser-profile"

function Get-DuScrapeBrowserPath {
    $browserPaths = @(
        "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
        "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
        "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
        "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
    )
    return $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# The last attempt's timestamp, outcome and (for faults) reason, kept locally so ordinary check-ins
# can re-report it without re-running the scrape. Written twice per scrape - once up front to hold
# the once-a-day gate even if the scrape never returns, once after with the real outcome.
# A stable, host-specific spread across the anchor window, not a random one - random would pick a
# different offset every agent restart, which defeats the point: this PC's quiet slot has to stay
# put day to day so it doesn't wander back into the pile-up it was moved out of. Confirmed live on
# 24 Aug 2026: every device in the fleet anchored to the same 08:00 clock second, so eleven
# headless browsers hit mydata.du.ae inside the same 19-minute window and eleven came back empty;
# the one device that DIDN'T pile up that morning (a late gate on a machine returning from an
# outage) was also the one that worked. Spreading each host's own anchor across the window
# is the direct fix for that collision, whatever exactly it is in the du portal or the headless
# launch that a pile-up triggers.
#
# 300 minutes (a 5-hour window, 03:00-07:59 local) rather than the 55 it started as, because that
# 55 was sized for a 12-device fleet and does not survive the planned growth to ~1500 PCs: the same
# 55-minute spread would pack ~27 devices into every minute, a far denser burst than the one that
# already caused the 24 Aug collision, against a root cause that was never actually identified.
# 300 brings that back to ~5 per minute. The window ENDS at 8 AM rather than starting there so
# every device has reported before the 08:00 Dubai daily Slack digest reads the figures - on the
# old 8-9 AM anchor the digest fired first and reported yesterday's numbers for most of the fleet.
#
# .NET's own string hashing is deliberately randomized per process (a security property, not a bug)
# so it can't be used here - this hand-rolled FNV-1a is fixed across restarts by construction, and
# the exact algorithm doesn't matter, only that it's stable and spreads hostnames widely.
#
# The classic C translation of this algorithm masks each step with \`-band 0xFFFFFFFF\` to wrap the
# hash back into 32 bits - which is a silent no-op in PowerShell, confirmed live: 0xFFFFFFFF parses
# as the Int32 literal -1 (all bits set, same as it would be reinterpreted as an unsigned 32-bit
# value, but PowerShell never makes that reinterpretation), so ANDing with it never truncates
# anything. Without the mask actually taking effect, $hash grows without bound every iteration -
# unsigned overflow doesn't wrap in PowerShell the way it does in C, it promotes to a wider type
# instead - and by a 14-character hostname it's a double past 2^53, at which point -band can no
# longer even convert it to compare against the mask and throws outright. True modulo arithmetic
# (\`% 4294967296\`, i.e. 2^32) doesn't have that ambiguity - it's the same operation on every
# numeric type - so $hash is kept as an actual uint64 throughout instead: comfortably wide enough
# that the largest possible intermediate product (a 32-bit value times the FNV prime) never
# approaches uint64's own limit, so nothing here ever needs to overflow at all.
function Get-DuJitterMinutes {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:COMPUTERNAME)
    [uint64]$hash = 2166136261
    foreach ($b in $bytes) { $hash = (($hash -bxor [uint64]$b) * 16777619) % 4294967296 }
    return [int]($hash % 300)
}

${anyDeskInstallsScript()}

# Applies a one-shot secret handed down by workspace-directory-force-status. Currently only an
# AnyDesk password, which AnyDesk reads from STDIN rather than a command-line argument - which
# is also why it never appears in a process command line, where any local user could read it
# with Get-CimInstance Win32_Process.
#
# The value is never logged, never echoed and never written to disk - only whether it worked.
function Set-AnyDeskPassword($password, $targetId) {
    # Wraps the WHOLE body, not just the cmd.exe call below - Get-AnyDeskInstalls/Where-Object
    # threw a terminating "term not recognized" error on every single call for a long time (see
    # anyDeskInstallsScript's own comment on why), and with no try/catch around it that propagated
    # straight out of this function to Invoke-PollCycle's own bare catch{}, which swallowed it
    # completely - not even a failure message ever reached Write-AgentLog. Whatever goes wrong here
    # now always comes back as a return value the caller can log, instead of an exception nothing
    # is positioned to catch.
    try {
        # Targets ONE installation. A PC can run a standard AnyDesk and a custom-branded MSI build
        # side by side, each with its own id, service and exe - so "set the AnyDesk password" is
        # meaningless without saying which, and the previous version picked whichever exe it found
        # first, leaving the admin no way to know which id had actually changed.
        $installs = @(Get-AnyDeskInstalls)
        if (-not $installs -or $installs.Count -eq 0) { return "AnyDesk is not installed on this PC." }
        $match = $installs | Where-Object { $_.id -eq $targetId } | Select-Object -First 1
        if (-not $match) { return "No AnyDesk installation on this PC answers on id $targetId." }
        if (-not $match.exe -or -not (Test-Path $match.exe)) { return "Found id $targetId but its AnyDesk binary is missing." }
        # cmd's pipe rather than PowerShell's: PowerShell's pipeline passes .NET objects, and
        # AnyDesk wants raw bytes on stdin. Passing it on stdin rather than as an argument is
        # also what keeps it out of the process command line, where any local user could read it.
        $null = cmd.exe /c "echo $password| \`"$($match.exe)\`" --set-password" 2>&1
        if ($LASTEXITCODE -eq 0) { return "OK" }
        return "AnyDesk exited with code $LASTEXITCODE."
    } catch {
        return "Could not run AnyDesk: $($_.Exception.Message)"
    }
}

function Save-DuScrapeState($at, $outcome, $note) {
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $Script:DuStateTarget) -Force -ErrorAction SilentlyContinue | Out-Null
    (@{ at = $at; outcome = $outcome; note = $note } | ConvertTo-Json -Compress) |
        Set-Content -Path $Script:DuStateTarget -Encoding utf8 -NoNewline
}

# Reads the last attempt record, folding in anything the user-session scrape left in the handoff
# file first (see $DuHandoffFile). The handoff wins when it is newer, then it is promoted into the
# real state file and deleted - so the handoff never accumulates, and SYSTEM keeps exactly one
# authoritative record regardless of which session actually performed the scrape.
function Get-DuScrapeState {
    $state = $null
    $stateAt = [datetime]::MinValue
    if (Test-Path $DuScrapeStateFile) {
        $raw = Get-Content -Path $DuScrapeStateFile -Raw -ErrorAction SilentlyContinue
        if ($raw) {
            try { $state = $raw | ConvertFrom-Json } catch { $state = $null }
            # Agents updating from a pre-3.2 build have a bare timestamp here with no outcome
            # attached. Treated as "error" (never $null) so it is eligible for the hourly retry
            # rather than silently trusted as done for the day - confirmed live on PC-F44D306862C0,
            # whose legacy timestamp was that morning's actual failure.
            if (-not $state) { try { $state = [pscustomobject]@{ at = ([datetime]$raw).ToString("o"); outcome = "error"; note = "Migrated from a pre-3.2 agent with no recorded outcome - treated as unconfirmed and retried." } } catch {} }
            if ($state -and $state.at) { try { $stateAt = [datetime]$state.at } catch {} }
        }
    }
    # Only SYSTEM promotes the handoff - the user-session run is writing INTO it at this point, and
    # would just be reading back its own work.
    if (-not $Script:DuIsUserSession -and (Test-Path $DuHandoffFile)) {
        try {
            $hoRaw = Get-Content -Path $DuHandoffFile -Raw -ErrorAction SilentlyContinue
            $ho = if ($hoRaw) { $hoRaw | ConvertFrom-Json } else { $null }
            $hoAt = if ($ho -and $ho.at) { [datetime]$ho.at } else { [datetime]::MinValue }
            if ($ho -and $hoAt -gt $stateAt) {
                $state = $ho
                Set-Content -Path $DuScrapeStateFile -Value $hoRaw -Encoding utf8 -NoNewline
                Write-AgentLog "Folded in user-session DU scrape result: $($ho.outcome)"
            }
            Remove-Item -Path $DuHandoffFile -Force -ErrorAction SilentlyContinue
        } catch { Write-AgentLog "Could not read the user-session DU handoff file: $($_.Exception.Message)" }
    }
    return $state
}

# Whether a scrape is due right now, from this host's own jittered slot in the 3-8 AM window plus
# the hourly retry a FAULT earns. 'nodata' is pointedly not retried - it is a stable, correct answer
# (no du SIM behind this connection), and retrying it hourly would relaunch a browser every hour
# forever on every Wi-Fi/LAN machine in the fleet to re-learn the same thing.
function Test-DuScrapeDue($state) {
    $lastAttempt = if ($state -and $state.at) { try { [datetime]$state.at } catch { $null } } else { $null }
    $todayAnchor = (Get-Date -Hour 3 -Minute 0 -Second 0 -Millisecond 0).AddMinutes((Get-DuJitterMinutes))
    $boundary = if ((Get-Date) -lt $todayAnchor) { $todayAnchor.AddDays(-1) } else { $todayAnchor }
    # 'partial' joins the retry set: it means du answered with this SIM's number but no usage
    # figures, which is usually the page's async data not having rendered in time - worth one more
    # go within the hour. It is deliberately a ONE-shot retry, enforced by Invoke-DuScrape recording
    # 'nofigures' on the second consecutive phone-only result rather than 'partial' again, so the
    # outcome itself carries the strike count and there is no counter to persist or reset. Like
    # 'nodata', 'nofigures' is never retried - see the phone-only branch in Invoke-DuScrape for why
    # an unbounded hourly retry is the wrong answer on a permanently phone-only account.
    $faulted = @('nobrowser', 'error', 'pending', 'partial') -contains $state.outcome
    $retryDue = $faulted -and $lastAttempt -and (((Get-Date) - $lastAttempt).TotalMinutes -ge 60)
    return (-not $lastAttempt) -or ($lastAttempt -lt $boundary) -or $retryDue
}

# Runs the scrape in the logged-in user's interactive session by starting a dedicated on-demand
# scheduled task registered under the Users group - the only way a SYSTEM process can get code into
# another session, since Session 0 isolation is precisely what stops the browser rendering here.
#
# Deliberately NOT done by asking the tray to do it. The tray is a long-lived message loop started
# once at logon, so it keeps executing whatever code it was launched with - a published change to
# its timer would not take effect until someone logged off and back on, which on an unattended
# signage PC could be weeks. It also has a "Close" item on its own context menu, so any user could
# silently disable scraping for good. A task started fresh each time always runs the current script
# and cannot be closed away.
#
# Returns $false when there is nobody to run it as (no interactive session) or the task is missing,
# so the caller can fall back to scraping inline - which is no worse than today's behaviour.
function Start-DuScrapeInUserSession {
    try {
        if (-not (Get-ScheduledTask -TaskName $DuScrapeTaskName -ErrorAction SilentlyContinue)) { return $false }
        # An on-demand task under a group principal only actually runs if someone is logged on -
        # Task Scheduler has no session to launch it into otherwise, and reports success regardless.
        $hasUser = $false
        try { $hasUser = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName } catch {}
        if (-not $hasUser) { return $false }
        Start-ScheduledTask -TaskName $DuScrapeTaskName -ErrorAction Stop
        Write-AgentLog "DU scrape delegated to the logged-in user's session."
        return $true
    } catch {
        Write-AgentLog "Could not delegate the DU scrape to the user session, running it here instead: $($_.Exception.Message)"
        return $false
    }
}

# ONE du scrape attempt, start to finish: runs it, records to local state what happened, and hands
# the outcome back for the caller to put in a check-in payload. Shared by the once-a-day gate in
# Invoke-Checkin and by the dashboard's on-demand "Check Data Usage" button (::DUCHECK below), so
# the two cannot drift - an on-demand check that recorded a different shape of answer than the
# scheduled one would be worse than having no button at all.
function Invoke-DuScrape($PriorOutcome) {
    $at = (Get-Date).ToUniversalTime().ToString("o")
    # Written BEFORE the scrape, same as this gate always was, so the once-a-day boundary advances
    # even if what follows never returns - "pending" is what's left behind in that case, and it
    # stays deliberately non-committal (the dashboard reads it as "no answer yet", not as a verdict
    # about the connection) until the real outcome overwrites it below.
    Save-DuScrapeState $at "pending" $null
    # Wiped BEFORE every attempt now, not just after a failed one. Get-DuDataUsageViaSelenium/
    # ViaNetwork/ViaDom all reuse this SAME --user-data-dir across runs as a speed optimisation, and
    # the old cleanup only ran when $outcome -ne "ok" - exactly the branch a stale-but-still-
    # answering cache would never take. mydata.du.ae writes the subscriber's "serviceNo" into the
    # page's own localStorage once it auto-identifies them over a real SIM connection, and its
    # client-side JS is happy to fetch usage for a serviceNo it already has cached rather than
    # re-proving the network path on every visit - so a PC that legitimately had this SIM once
    # (provisioning, a temporary dongle, a profile folder cloned from another PC) kept reporting
    # "ok" with that account's live, still-updating figures forever after, on ANY connection.
    # Confirmed live on DESKTOP-8S3G9M2 (Yas Mall), 3 Sep 2026: reporting a real phone number and
    # current GB figures while actually sitting on a wired connection through an unrelated D-Link
    # home router, no SIM anywhere in the path. Wiping first means every "ok" has to re-earn itself
    # each time, at the cost of paying Chromium's first-run setup on every single scrape instead of
    # only on the rare failure - worth it since a false "ok" is exactly the case
    # dataCheckFailedToday (workspaceDirectory.js) can never catch.
    Remove-Item -Path $DuBrowserProfileDir -Recurse -Force -ErrorAction SilentlyContinue
    $outcome = "error"
    $note = $null
    $du = $null
    try {
        if (-not (Get-DuScrapeBrowserPath)) {
            # Kept separate from "the page told us nothing": this is a fixable fault on the PC, not
            # a fact about its connection, and it's invisible from the software list alone - a
            # per-user Chrome install shows up there but sits outside the paths a SYSTEM task can
            # rely on, so the dashboard would otherwise show a browser that cannot actually be used.
            $outcome = "nobrowser"
            $note = "No machine-wide Chrome or Edge install found, so there was no browser to load mydata.du.ae with."
            Write-AgentLog "DU data-usage scrape skipped: $note"
        } else {
            $du = Get-DuDataUsage
            # A result object with every field empty counts as nothing found, not as success -
            # otherwise it would stamp du_scraped_at server-side and have the dashboard claim the
            # connection was checked and answered when it answered nothing.
            if ($du -and ($null -ne $du.dataUsedGb -or $null -ne $du.dataLeftGb -or $null -ne $du.dataTotalGb)) {
                $outcome = "ok"
                Write-AgentLog "DU data-usage scrape: phone=$($du.phoneNumber) used=$($du.dataUsedGb) left=$($du.dataLeftGb) total=$($du.dataTotalGb)"
            } elseif ($du -and $du.phoneNumber) {
                # A phone number and NO usage figures at all. This used to count as "ok", which was
                # wrong twice over: the server stamped du_scraped_at from it (so yesterday's figures
                # wore today's timestamp - fixed separately in workspace-directory-checkin), and
                # because "ok" is not a fault it earned no retry, so the PC sat until tomorrow's
                # window having learned nothing.
                #
                # Confirmed live on ADCOOP-MINA-AR, 1 Sep 2026: scraped "ok" at 07:59 Dubai and
                # again at 17:04, both phone-number-only, while the figures on display had last
                # actually been read at 18:30 the previous day. 51 devices were in that state at
                # once, every one holding figures byte-identical to its last history row.
                #
                # Two strikes, not an hourly retry forever. The obvious fix - call it a fault so the
                # existing 60-minute retry picks it up - would relaunch a headless browser every
                # hour indefinitely on the 23 devices that have NEVER produced a GB figure (the
                # shared-SIM clusters: +971552724831 across 7 ALFURJAN hosts, +971552724195 across
                # DISCOVERY, and two more), on metered SIMs, to re-learn the same nothing. That is
                # precisely the churn the nodata branch below exists to avoid.
                #
                # So the outcome itself carries the strike count, with no counter to persist or
                # reset: "partial" is retried once an hour later, and if that retry is ALSO
                # phone-only it records "nofigures", which is terminal for the day exactly like
                # nodata. A transient render failure recovers within the hour; a permanently
                # phone-only account costs two attempts a day instead of twenty-four.
                if ($PriorOutcome -eq 'partial') {
                    $outcome = "nofigures"
                    $note = "du returned this SIM's number but no usage figures on two consecutive attempts - treating it as having none to give until tomorrow's scrape."
                    Write-AgentLog "DU scrape phone-only again after a retry - recording 'nofigures' and waiting for tomorrow."
                } else {
                    $outcome = "partial"
                    $note = "du returned this SIM's number but no usage figures - retrying in an hour."
                    Write-AgentLog "DU scrape returned a phone number but no usage figures - will retry in an hour."
                }
            } elseif ($Script:DuIsUserSession) {
                # The browser ran IN A REAL DESKTOP SESSION and the page still gave nothing back.
                # Only then is "nothing" an actual answer: du identifies the subscriber from the
                # connection itself, so a machine reaching the internet over Wi-Fi or the mall LAN
                # has nothing to report and never will. Recorded as its own outcome so the Data
                # Usage column can say exactly that instead of leaving the device on "Not checked".
                $outcome = "nodata"
                $du = $null
                Write-AgentLog "DU data-usage scrape returned nothing - no du SIM behind this connection."
            } else {
                # Same empty result, but from Session 0, where it means nothing about the
                # connection. Headless Edge renders NOTHING there - confirmed live: about:blank
                # itself returned 0 bytes - so a SYSTEM run that finds a browser and gets no data
                # has not learned that there is no SIM, only that it could not ask.
                #
                # Calling that 'nodata' was actively harmful, not just mislabelled: 'nodata' is
                # deliberately excluded from the hourly retry (so Wi-Fi/LAN machines don't relaunch
                # a browser forever), so every Session 0 failure disqualified itself from retrying
                # AND told the dashboard the PC had no SIM - on machines whose own du phone number
                # was displayed directly above that claim. Recorded as a fault instead, so it
                # retries and reads honestly.
                $outcome = "error"
                $du = $null
                $note = "The scrape ran as SYSTEM (Session 0), where a headless browser renders nothing, so this result says nothing about the connection. It will be retried in the logged-in user's session."
                Write-AgentLog "DU data-usage scrape returned nothing under SYSTEM - treated as a fault, not as 'no SIM'."
            }
        }
    } catch {
        $outcome = "error"
        $note = "Scrape failed: $($_.Exception.Message)"
        Write-AgentLog "DU data-usage scrape failed: $($_.Exception.Message)"
    }
    # No end-of-run cleanup needed any more - the wipe at the top of this function already handles
    # both a stale cached identity AND a locked/corrupted profile from a killed process, on every
    # attempt, not just a failed one.
    Save-DuScrapeState $at $outcome $note
    return [pscustomobject]@{ at = $at; outcome = $outcome; note = $note; du = $du }
}

# Copies a successful scrape's carrier figures into a check-in payload. Split out from the attempt
# record itself (duScrapeAttemptedAt/Outcome/Note), which every check-in reports whether or not
# there were any figures to go with it.
function Add-DuFiguresToPayload($payload, $result) {
    if (-not $result.du) { return }
    if ($result.du.phoneNumber) { $payload.duPhoneNumber = $result.du.phoneNumber }
    if ($null -ne $result.du.dataUsedGb) { $payload.duDataUsedGb = $result.du.dataUsedGb }
    if ($null -ne $result.du.dataLeftGb) { $payload.duDataLeftGb = $result.du.dataLeftGb }
    if ($null -ne $result.du.dataTotalGb) { $payload.duDataTotalGb = $result.du.dataTotalGb }
}

# Scrapes mydata.du.ae once a day for this SIM's own carrier-reported number/usage, as an
# alternative to the network-adapter-counter estimate above. No login is needed: browsing to that
# page over the SIM's OWN mobile-data connection auto-identifies the subscriber (the whole reason
# this works without ever touching a password/OTP) - so this only produces useful data on a PC
# whose internet actually egresses through that SIM, not over Wi-Fi/office LAN. Queue
# "Get-DuDataUsage | ConvertTo-Json" as a Run Command from the dashboard to see the raw result for
# tuning either method below.
#
# Tries three methods in order, each one only reached if the previous came back with no usable
# GB figures - a PC where an earlier method doesn't pan out is no worse off than before:
#   1. Get-DuDataUsageViaSelenium - a real WebDriver session (see below), which can actually WAIT
#      for the page's async data to finish rendering instead of guessing a fixed timing budget or
#      racing a raw CDP network event. Most reliable when it can find/fetch a matching driver.
#   2. Get-DuDataUsageViaNetwork - reads the page's own underlying API response directly over a
#      hand-rolled CDP WebSocket connection. No driver executable needed, but the timing around
#      catching the right network event has proven flaky on real devices.
#   3. Get-DuDataUsageViaDom - the original --dump-dom + keyword-proximity text scan. Least
#      reliable (a single fixed --virtual-time-budget guess for when the async JS is "done"), kept
#      only as a last resort.
function Get-DuDataUsage {
    $viaSelenium = $null
    try { $viaSelenium = Get-DuDataUsageViaSelenium } catch { Write-AgentLog "DU Selenium-based scrape failed: $($_.Exception.Message)" }
    if ($viaSelenium -and ($null -ne $viaSelenium.dataUsedGb -or $null -ne $viaSelenium.dataTotalGb)) { return $viaSelenium }

    $viaNetwork = $null
    try { $viaNetwork = Get-DuDataUsageViaNetwork } catch { Write-AgentLog "DU network-based scrape failed: $($_.Exception.Message)" }
    if ($viaNetwork -and ($null -ne $viaNetwork.dataUsedGb -or $null -ne $viaNetwork.dataTotalGb)) { return $viaNetwork }

    return Get-DuDataUsageViaDom
}

# ---------------------------------------------------------------------------------------------
# Get-DuDataUsageViaSelenium - a real WebDriver session, spoken over the standard W3C WebDriver
# HTTP protocol (the same protocol Selenium's own client libraries use under the hood) via plain
# Invoke-RestMethod calls, rather than pulling in Python/Selenium itself (not something this
# PowerShell-only agent can assume is installed). This is what actually earns the name "Selenium
# based": a managed browser session with real navigation/wait/script-execution primitives, not
# hand-rolled DevTools Protocol message-watching (see Get-DuDataUsageViaNetwork) or a fixed-budget
# DOM dump (see Get-DuDataUsageViaDom). Tried FIRST because it can genuinely WAIT for the page's
# async data call to finish - polling the live page's own rendered text on an interval - instead
# of guessing a timing budget or racing to catch one specific network event within a window.
#
# Edge OR Chrome, whichever already has a version-matched driver sitting on the PC - mirroring the
# Edge-then-Chrome preference the Network/DOM tiers below already use (Edge ships with Windows by
# default, so it's the more universally available of the two; Chrome only enters the picture on a
# PC where it happens to already be installed, e.g. TOTEM-8). Strictly opportunistic either way:
# nothing is ever installed or downloaded to make this tier work. See the comment on
# Get-DuDataUsageViaSelenium below for the real-device evidence behind that (short version: the
# Chocolatey route was tried, and proved both expensive and incapable of producing a matched driver).
# ---------------------------------------------------------------------------------------------

# Locates an already-present browser + driver pair whose major versions match - a mismatch fails
# every WebDriver session-create call outright, so a pair that doesn't line up is treated the same
# as no pair at all. Pure disk inspection: no network, no installs, nothing that costs metered SIM
# data, so this is cheap enough to just run on every scrape.
function Test-DuDriverVersionMatch($browserPath, $driverPath) {
    try {
        $browserMajor = ((Get-Item $browserPath).VersionInfo.ProductVersion -split '\\.')[0]
        $verOutput = & $driverPath --version 2>$null
        return ($verOutput -match "(\\d+)\\.\\d+\\.\\d+\\.\\d+" -and $matches[1] -eq $browserMajor)
    } catch { return $false }
}

# Chocolatey shims every package's exe into its own bin folder - that shim is normally on PATH, but
# PATH as this already-running process sees it can be stale right after a fresh choco install in
# the SAME run, so the well-known shim path is checked directly first rather than trusting
# Get-Command alone. Falls back to the package's own tools folder, then to wherever Selenium
# Manager caches a driver (used by modern Selenium/Python installs, including the reference GLPI
# script mentioned above - it may already have left a matching one there).
function Find-DuChromedriverPath {
    $shim = "$env:ProgramData\\chocolatey\\bin\\chromedriver.exe"
    if (Test-Path $shim) { return $shim }
    $found = Get-ChildItem -Path "$env:ProgramData\\chocolatey\\lib\\selenium-chrome-driver" -Filter "chromedriver.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
    foreach ($base in @($env:USERPROFILE, "$env:SystemRoot\\System32\\config\\systemprofile")) {
        $found = Get-ChildItem -Path (Join-Path $base ".cache\\selenium\\chromedriver") -Filter "chromedriver.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

# Same idea as Find-DuChromedriverPath, for Edge's driver - no Chocolatey package involved (there
# isn't a usable one - see settings.js history), so this only ever finds one via Selenium Manager's
# own cache.
function Find-DuEdgedriverPath {
    foreach ($base in @($env:USERPROFILE, "$env:SystemRoot\\System32\\config\\systemprofile")) {
        $found = Get-ChildItem -Path (Join-Path $base ".cache\\selenium\\edgedriver") -Filter "msedgedriver.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Find-DuBrowserAndDriver {
    $edgePath = "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe"
    if (-not (Test-Path $edgePath)) { $edgePath = "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe" }
    if (Test-Path $edgePath) {
        $edgeDriver = Find-DuEdgedriverPath
        if ($edgeDriver -and (Test-DuDriverVersionMatch $edgePath $edgeDriver)) {
            return [ordered]@{ browser = $edgePath; driver = $edgeDriver; browserName = 'MicrosoftEdge'; optionsKey = 'ms:edgeOptions' }
        }
    }

    $chromePath = "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe"
    if (-not (Test-Path $chromePath)) { $chromePath = "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe" }
    if (Test-Path $chromePath) {
        $chromeDriver = Find-DuChromedriverPath
        if ($chromeDriver -and (Test-DuDriverVersionMatch $chromePath $chromeDriver)) {
            return [ordered]@{ browser = $chromePath; driver = $chromeDriver; browserName = 'chrome'; optionsKey = 'goog:chromeOptions' }
        }
    }

    return $null
}

# NOTHING is downloaded or installed to make this tier work - it runs only when a matching
# browser+driver pair ALREADY exists on the PC (see Find-DuBrowserAndDriver above), and is skipped
# entirely otherwise, falling through to the Network/DOM tiers which need no driver at all. Two
# findings on real devices, in order, led to this being opportunistic-only rather than self-installing:
#   1. "choco install googlechrome" burns a large amount of data (close to 300MB on one real
#      device) even when Chrome is ALREADY present, because Chocolatey tracks "installed" via its
#      OWN local package database, not by checking whether chrome.exe exists on disk - a Chrome
#      that got onto the PC some other way (manually, by IT, pre-imaged) isn't in that database,
#      so choco doesn't recognize it and re-downloads the full installer every single time.
#   2. Chocolatey's chromedriver package can't satisfy this tier anyway. Confirmed live: it reports
#      "selenium-chrome-driver v114.0.5735.90 already installed" while placing no chromedriver.exe
#      on disk at all - and even if it had, v114 against the Chrome 151 actually installed on that
#      same PC fails Test-DuDriverVersionMatch outright. That package trails Chrome by years and
#      Chrome auto-updates itself, so the gap only ever widens; no amount of retrying makes it fit.
#      There is no equivalent Chocolatey package for Edge's driver at all (see settings.js history),
#      so Edge was never a candidate for a self-install approach to begin with.
# So the install attempt was removed rather than kept "just in case": on a METERED cellular SIM -
# the very thing this feature exists to measure - a daily subprocess that provably cannot produce a
# usable driver is pure cost. The tier stays because a matching driver may legitimately already be
# present from the separate GLPI/Selenium-wire agent on some of these same PCs, in which case this
# runs and is the most reliable of the three. Pointing this at Google's/Microsoft's own official
# per-version driver CDN would make it work everywhere for a small download per browser version, if
# that trade is ever wanted.
function Get-DuDataUsageViaSelenium {
    $chromeAndDriver = Find-DuBrowserAndDriver
    if (-not $chromeAndDriver) { return $null }
    $driverPath = $chromeAndDriver.driver

    $port = Get-Random -Minimum 9900 -Maximum 10299
    $tempProfile = $DuBrowserProfileDir
    # Redirected for the same reason as the CDP method above: chromedriver/msedgedriver announce
    # themselves on stdout and pass the browser's own stderr through, which would otherwise print
    # over an interactive installer's console. Everything this method needs comes back over the
    # WebDriver HTTP API, never from these streams.
    $wdOut = Join-Path $env:TEMP ("du-wd-" + [guid]::NewGuid().ToString("N") + ".log")
    $wdErr = "$wdOut.err"
    $driverProc = $null
    $sessionId = $null
    $base = "http://127.0.0.1:$port"
    try {
        $driverProc = Start-Process -FilePath $driverPath -ArgumentList @("--port=$port") -PassThru -WindowStyle Hidden -RedirectStandardOutput $wdOut -RedirectStandardError $wdErr

        $ready = $false
        $startDeadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $startDeadline -and -not $ready) {
            Start-Sleep -Milliseconds 300
            try { Invoke-RestMethod -Uri "$base/status" -TimeoutSec 2 | Out-Null; $ready = $true } catch {}
        }
        if (-not $ready) { return $null }

        # A fresh --user-data-dir every run, same reasoning as the other two methods: no chance a
        # cookie/session from a previous scrape (or a different SIM that used to be in this PC)
        # lingers and shows stale or wrong-account data. binary explicitly points at the browser
        # Find-DuBrowserAndDriver found above, rather than trusting the driver to locate one on its
        # own. The capability key and private-browsing flag both depend on which browser this
        # actually is - Edge uses "ms:edgeOptions"/--inprivate, Chrome uses
        # "goog:chromeOptions"/--incognito - so both are read from what was already detected rather
        # than assumed.
        $privateFlag = if ($chromeAndDriver.browserName -eq 'MicrosoftEdge') { '--inprivate' } else { '--incognito' }
        $newSessionBody = @{
            capabilities = @{
                alwaysMatch = @{
                    browserName = $chromeAndDriver.browserName
                    "$($chromeAndDriver.optionsKey)" = @{
                        binary = $chromeAndDriver.browser
                        args = @("--headless=new", "--disable-gpu", $privateFlag, "--no-first-run", "--disable-extensions", "--user-data-dir=$tempProfile") + $DuBrowserFrugalArgs
                    }
                }
            }
        } | ConvertTo-Json -Depth 6
        $session = Invoke-RestMethod -Uri "$base/session" -Method Post -Body $newSessionBody -ContentType "application/json" -TimeoutSec 20
        $sessionId = $session.value.sessionId
        if (-not $sessionId) { return $null }

        Invoke-RestMethod -Uri "$base/session/$sessionId/url" -Method Post -Body (@{ url = "http://mydata.du.ae/" } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 20 | Out-Null

        # Polls the LIVE page for up to 25s instead of guessing a fixed render budget - the page's
        # own async data call finishes whenever it finishes, and this just keeps checking rather
        # than picking a number and hoping it was long enough.
        $bodyText = $null
        $pollDeadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $pollDeadline) {
            try {
                $exec = Invoke-RestMethod -Uri "$base/session/$sessionId/execute/sync" -Method Post -Body (@{ script = "return document.body.innerText;"; args = @() } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 10
                $bodyText = $exec.value
                # Same broadened "up to 12 non-digit characters between the two figures" match as
                # Get-DuUsageFromLines below, for the same reason - kept consistent so this early-
                # exit check and the actual parsing agree on what counts as "the data is ready" (a
                # real innerText newline is \s-matched fine either way, so this specific check
                # likely still worked with the old strict pattern, but there's no reason for it to
                # drift from the one pattern that's actually confirmed against the real page).
                # GB-or-MB on both sides, not just GB - the used side switches to MB below ~1GB (see
                # ConvertTo-DuGb), and a GB-only check here never exits early for that page, wasting
                # the full 25s poll before Get-DuUsageFromLines parses it correctly anyway.
                if ($bodyText -match '\\d+(?:\\.\\d+)?\\s*(GB|MB)[^0-9]{1,12}\\d+(?:\\.\\d+)?\\s*(GB|MB)') { break }
            } catch {}
            Start-Sleep -Milliseconds 750
        }
        if (-not $bodyText) { return $null }

        $lines = $bodyText -split "\`n" | ForEach-Object { ($_ -replace '\\s+', ' ').Trim() } | Where-Object { $_ }
        $usage = Get-DuUsageFromLines $lines

        # Same source the reference script uses for the phone number - the page's own localStorage
        # - rather than regexing it out of visible text. Best-effort: the GB figures above are the
        # part that actually matters, so a failure here just leaves phoneNumber unset.
        $phoneNumber = $null
        try {
            $phoneExec = Invoke-RestMethod -Uri "$base/session/$sessionId/execute/sync" -Method Post -Body (@{ script = "return window.localStorage.getItem('serviceNo');"; args = @() } | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 10
            $phoneNumber = ConvertTo-DuPhoneNumber $phoneExec.value
        } catch {}

        return [ordered]@{
            phoneNumber = $phoneNumber
            dataUsedGb  = $usage.dataUsedGb
            dataLeftGb  = $usage.dataLeftGb
            dataTotalGb = $usage.dataTotalGb
            rawSnippet  = $usage.rawSnippet
        }
    } catch {
        return $null
    } finally {
        if ($sessionId) { try { Invoke-RestMethod -Uri "$base/session/$sessionId" -Method Delete -TimeoutSec 5 | Out-Null } catch {} }
        if ($driverProc) { try { Stop-Process -Id $driverProc.Id -Force -ErrorAction SilentlyContinue } catch {} }
        # Not deleted here - $DuBrowserProfileDir is deliberately reused so Chromium skips first-run
        # setup on every scrape (see its definition). It's wiped at the START of every attempt, in
        # Invoke-DuScrape, not here at the end - both a locked/corrupted profile from a killed
        # process AND a stale cached du identity (see Invoke-DuScrape's own comment) need to be gone
        # BEFORE the next launch reads from this same directory, not just cleaned up after.
        Remove-Item -Path $wdOut -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $wdErr -Force -ErrorAction SilentlyContinue
    }
}

# Turns the raw digits DU stores in the page's own localStorage ('serviceNo') into a normal
# display format. Shared by both methods that read localStorage directly (Selenium and Network) -
# the DOM-dump method instead regexes a phone number straight out of visible page text, a
# different source entirely, so it doesn't go through this.
function ConvertTo-DuPhoneNumber($rawServiceNo) {
    if (-not $rawServiceNo) { return $null }
    $raw = [string]$rawServiceNo
    if ($raw.Length -lt 9) { return $null }
    return "+971" + $raw.Substring(2, 2) + $raw.Substring(4, 3) + $raw.Substring(7)
}

# mydata.du.ae switches the USED figure to MB below ~1GB (confirmed live, 3 Sep 2026: a real 15GB-
# plan account reading "482.03 MB / 15.00 GB" - the plan/total side stays in GB regardless). Every
# figure this file parses off that page has to go through this rather than assuming GB, or a light
# user's real reading is silently invisible to a "GB" pattern.
function ConvertTo-DuGb($value, $unit) {
    if ($unit -eq 'MB') { return $value / 1024 }
    return $value
}

# Given the page's rendered text broken into one "line" per element/block, extracts the used/
# total/left GB figures. Shared by both methods that parse rendered text (Selenium and DOM-dump)
# so a layout-parsing fix made for one doesn't silently drift out of sync with the other.
function Get-DuUsageFromLines($lines) {
    if (-not $lines) { return [ordered]@{ dataUsedGb = $null; dataLeftGb = $null; dataTotalGb = $null; rawSnippet = $null } }
    $joined = $lines -join ' | '

    # The real mydata.du.ae "Your Data usage" row renders as a single "X GB / Y GB" (used/total)
    # value, not separate used/left/total labels - confirmed against a live account page. Tried
    # first since it's an exact match for the real markup; the keyword-proximity scan below is
    # kept only as a fallback for account states that might render differently (e.g. a different
    # plan type), so a layout change degrades gracefully instead of returning nothing.
    #
    # The gap between the two figures is matched as "up to 12 non-digit characters", not a literal
    # "/" with optional whitespace - confirmed live on a real account, "4.67 GB" / "/" / "6.00 GB"
    # render as three SEPARATE block elements, which the line-joining logic above (both here and in
    # Get-DuDataUsageViaDom) turns into "4.67 GB | / | 6.00 GB", not "4.67 GB / 6.00 GB" - the old
    # "\s*/\s*" pattern doesn't match a literal "|" character, so it silently never matched at all
    # on the real page, no matter how the DOM/Selenium capture itself was done. This was confirmed
    # to be the actual reason usage figures were never being read even when the raw page text
    # plainly contained them.
    #
    # Each side matches GB OR MB independently, not just GB on both - the used side specifically is
    # exactly what switches to MB below ~1GB (see ConvertTo-DuGb above), so "482.03 MB | / | 15.00
    # GB" is a completely real, common render, not an edge case. Matching GB-only here silently
    # dropped every account whose current usage happened to be under 1GB at scrape time - confirmed
    # live, 3 Sep 2026: 15GB/28GB-plan (lighter-traffic) devices landed in this exact gap 3-6x more
    # often than 43GB-plan ones, simply because they spend more of the month still under 1GB used.
    $used = $null
    $total = $null
    if ($joined -match '(\\d+(?:\\.\\d+)?)\\s*(GB|MB)[^0-9]{1,12}(\\d+(?:\\.\\d+)?)\\s*(GB|MB)') {
        $used = ConvertTo-DuGb ([double]$matches[1]) $matches[2]
        $total = ConvertTo-DuGb ([double]$matches[3]) $matches[4]
    }

    function Find-GbNear($lines, $keywords) {
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $isLabel = $false
            foreach ($kw in $keywords) { if ($lines[$i] -match "(?i)$kw") { $isLabel = $true; break } }
            if (-not $isLabel) { continue }
            foreach ($idx in @($i, ($i + 1), ($i - 1))) {
                if ($idx -ge 0 -and $idx -lt $lines.Count -and $lines[$idx] -match '(\\d+(?:\\.\\d+)?)\\s*(GB|MB)') { return ConvertTo-DuGb ([double]$matches[1]) $matches[2] }
            }
        }
        return $null
    }
    $left = Find-GbNear $lines @('left', 'remaining', 'balance')
    if (-not $used) { $used = Find-GbNear $lines @('used', 'consumed') }
    if (-not $total) { $total = Find-GbNear $lines @('total', 'allocat', 'plan', 'bundle') }
    # "Data available" (what's left to use) isn't shown on the real page at all - only used and
    # total are - so it's always computed from those two rather than scraped directly.
    if (-not $left -and $used -and $total) { $left = [math]::Round($total - $used, 2) }
    if (-not $total -and $used -and $left) { $total = [math]::Round($used + $left, 2) }

    # Deliberately NO plausibility ceiling on these figures. A very large total is not necessarily a
    # misparse: the fleet genuinely includes a SIM whose plan reads in the petabytes (a real device
    # reported 10,239,016 GB total against 87.72 GB used), alongside ordinary 6 GB kiosk SIMs.
    # An earlier version rejected anything over 10,000 GB as nonsense, which would have thrown away
    # that account's real data. Whatever the page reports is passed through as-is; making an
    # enormous-but-real number readable is a display concern, handled in the dashboard's own
    # formatting rather than by discarding it here.
    return [ordered]@{
        dataUsedGb  = $used
        dataLeftGb  = $left
        dataTotalGb = $total
        rawSnippet  = if (-not $used -or -not $total) { $joined.Substring(0, [Math]::Min(1500, $joined.Length)) } else { $null }
    }
}

# Modeled on a working reference script (Python + Selenium-wire, already deployed via a separate
# Jstar/GLPI agent on some of these same PCs) that reads the SAME underlying API call the page's own
# JavaScript uses to render the usage bar - a request whose URL contains "dashboard/query", returning
# resultBody.dashBoardValue.{monthTotal,monthUsed,monthLeft} in KB - plus the phone number straight
# from the page's own localStorage ('serviceNo'). Far more reliable than parsing whatever text
# happens to be visible once the page's async JS finishes rendering (see Get-DuDataUsageViaDom's
# fragility below), since this reads the structured data directly rather than guessing at rendered
# markup we don't control or get to preview ahead of time.
#
# Talks to headless Edge/Chrome's own DevTools Protocol over a plain WebSocket - no Selenium/Python
# needed on the PC, just the browser already required for the DOM method. Every step is wrapped in a
# generous but firm timeout (nothing here can hang indefinitely - the worst case is returning $null a
# few seconds later than usual, letting the DOM method take over).
function Get-DuDataUsageViaNetwork {
    $browser = Get-DuScrapeBrowserPath
    if (-not $browser) { return $null }

    $port = Get-Random -Minimum 9300 -Maximum 9899
    $tempProfile = $DuBrowserProfileDir
    # Browsers write a lot of unsolicited diagnostics to stderr - "DevTools listening on ws://...",
    # and on Edge a stream of SmartScreen DNS-resolver timeouts for whatever URL is being loaded.
    # Without redirecting, a Start-Process child INHERITS this console, so during an interactive
    # install those lines pour red text over the installer window and read like the agent is
    # failing when it installed perfectly well. Captured to throwaway files instead (nothing reads
    # them - this method takes its data over the DevTools socket, not from stdout).
    $cdpOut = Join-Path $env:TEMP ("du-cdp-" + [guid]::NewGuid().ToString("N") + ".log")
    $cdpErr = "$cdpOut.err"
    $proc = $null
    $client = $null
    try {
        $proc = Start-Process -FilePath $browser -ArgumentList @(
            "--headless=new", "--disable-gpu", "--incognito", "--user-data-dir=$tempProfile", "--disable-component-update", "--disable-background-networking", "--disable-sync", "--no-default-browser-check", "--blink-settings=imagesEnabled=false",
            "--no-first-run", "--disable-extensions", "--remote-debugging-port=$port"
        ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $cdpOut -RedirectStandardError $cdpErr

        # The debug port takes a moment to start listening after the process launches.
        $wsUrl = $null
        $startDeadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $startDeadline -and -not $wsUrl) {
            Start-Sleep -Milliseconds 300
            try {
                $target = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/new?http://mydata.du.ae/" -Method Put -TimeoutSec 3
                $wsUrl = $target.webSocketDebuggerUrl
            } catch {}
        }
        if (-not $wsUrl) { return $null }

        $client = New-Object System.Net.WebSockets.ClientWebSocket
        $connectCts = New-Object System.Threading.CancellationTokenSource
        $connectCts.CancelAfter(8000)
        $client.ConnectAsync([Uri]$wsUrl, $connectCts.Token).GetAwaiter().GetResult() | Out-Null

        function Send-CdpMessage($sock, $obj) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 6))
            $seg = New-Object System.ArraySegment[byte] (,$bytes)
            $sock.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
        }
        # Reassembles a message across multiple WebSocket frames (a real CDP response body can
        # easily exceed one 64KB read) rather than assuming a single ReceiveAsync call is the whole
        # thing.
        function Receive-CdpMessage($sock, $timeoutMs) {
            $localCts = New-Object System.Threading.CancellationTokenSource
            $localCts.CancelAfter($timeoutMs)
            $ms = New-Object System.IO.MemoryStream
            $seg = New-Object System.ArraySegment[byte] (,(New-Object byte[] 65536))
            try {
                do {
                    $result = $sock.ReceiveAsync($seg, $localCts.Token).GetAwaiter().GetResult()
                    $ms.Write($seg.Array, 0, $result.Count)
                } while (-not $result.EndOfMessage)
                return ([System.Text.Encoding]::UTF8.GetString($ms.ToArray())) | ConvertFrom-Json
            } catch { return $null }
        }

        Send-CdpMessage $client @{ id = 1; method = "Network.enable" }

        # Watches every network event until it sees the response we care about AND that response has
        # finished loading (a body can't be fetched reliably before then) - or the deadline passes,
        # in which case it tries anyway with whatever requestId it has, best-effort.
        $requestId = $null
        $finished = $false
        $findDeadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $findDeadline -and -not $finished) {
            $msg = Receive-CdpMessage $client 2000
            if (-not $msg -or -not $msg.method) { continue }
            if ($msg.method -eq "Network.responseReceived" -and $msg.params.response.url -match "(?i)dashboard/query") {
                $requestId = $msg.params.requestId
            }
            if ($requestId -and $msg.method -eq "Network.loadingFinished" -and $msg.params.requestId -eq $requestId) {
                $finished = $true
            }
        }
        if (-not $requestId) { return $null }

        Send-CdpMessage $client @{ id = 2; method = "Network.getResponseBody"; params = @{ requestId = $requestId } }
        $bodyMsg = $null
        $bodyDeadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $bodyDeadline -and -not $bodyMsg) {
            $m = Receive-CdpMessage $client 2000
            if ($m -and $m.id -eq 2) { $bodyMsg = $m }
        }
        if (-not $bodyMsg -or -not $bodyMsg.result -or -not $bodyMsg.result.body) { return $null }

        $bodyText = if ($bodyMsg.result.base64Encoded) {
            [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($bodyMsg.result.body))
        } else { $bodyMsg.result.body }

        $json = $bodyText | ConvertFrom-Json
        $dv = $json.resultBody.dashBoardValue
        if (-not $dv) { return $null }

        $du = [ordered]@{
            dataTotalGb = [math]::Round([double]$dv.monthTotal / 1024 / 1024, 2)
            dataUsedGb  = [math]::Round([double]$dv.monthUsed / 1024 / 1024, 2)
            dataLeftGb  = [math]::Round([double]$dv.monthLeft / 1024 / 1024, 2)
            phoneNumber = $null
        }

        # Same source the reference script uses for the phone number - the page's own localStorage,
        # rather than trying to regex it out of rendered text. Best-effort: the GB figures above are
        # the part that actually matters, so a failure here just leaves phoneNumber unset.
        try {
            Send-CdpMessage $client @{ id = 3; method = "Runtime.evaluate"; params = @{ expression = "window.localStorage.getItem('serviceNo')"; returnByValue = $true } }
            $evalMsg = $null
            $evalDeadline = (Get-Date).AddSeconds(5)
            while ((Get-Date) -lt $evalDeadline -and -not $evalMsg) {
                $m = Receive-CdpMessage $client 2000
                if ($m -and $m.id -eq 3) { $evalMsg = $m }
            }
            if ($evalMsg -and $evalMsg.result -and $evalMsg.result.result -and $evalMsg.result.result.value) {
                $du.phoneNumber = ConvertTo-DuPhoneNumber $evalMsg.result.result.value
            }
        } catch {}

        return $du
    } catch {
        return $null
    } finally {
        if ($client) { try { $client.Dispose() } catch {} }
        if ($proc) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
        # Not deleted here - $DuBrowserProfileDir is deliberately reused so Chromium skips first-run
        # setup on every scrape (see its definition). It's wiped at the START of every attempt, in
        # Invoke-DuScrape, not here at the end - both a locked/corrupted profile from a killed
        # process AND a stale cached du identity (see Invoke-DuScrape's own comment) need to be gone
        # BEFORE the next launch reads from this same directory, not just cleaned up after.
        Remove-Item -Path $cdpOut -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $cdpErr -Force -ErrorAction SilentlyContinue
    }
}

# The original method - headless Edge/Chrome's --dump-dom flag, then keyword-proximity text parsing
# (looks for a number near "used"/"left"/"total" etc) since the exact page layout isn't something we
# have visibility into ahead of time. Kept as a fallback for whenever the network-based method above
# doesn't pan out (browser too old to support the DevTools Protocol flags used there, a redirect or
# different response shape than expected, etc.) rather than replaced outright.
function Get-DuDataUsageViaDom {
    $browser = Get-DuScrapeBrowserPath
    if (-not $browser) { return $null }

    # The same reused --user-data-dir the other two methods use (see $DuBrowserProfileDir) - reused
    # for the first-run-setup speedup, but wiped at the START of every Invoke-DuScrape attempt so no
    # cookie/localStorage identity (a du "serviceNo") from a previous scrape or a different SIM that
    # used to be in this PC can linger and make mydata.du.ae show stale or wrong-account data.
    # --incognito on top is defense in depth, not the thing actually preventing that here.
    $tempProfile = $DuBrowserProfileDir
    $dumpFile = Join-Path $env:TEMP ("du-dump-" + [guid]::NewGuid().ToString("N") + ".html")
    $dumpErrFile = "$dumpFile.err"
    try {
        # Bounded via Start-Process/WaitForExit rather than the call operator. "& \$browser ..."
        # blocks for however long the browser takes with no ceiling at all, and this function runs
        # unattended as SYSTEM in a non-interactive session (Session 0), where a headless browser
        # launch can stall in ways it simply doesn't in a signed-in desktop session - the identical
        # scrape run by hand under a real user account on the same PC returns in seconds. A stall
        # there wedges this function past the point where ANY result, even a failure message, could
        # be written or reported, which is exactly the shape of "works when I run it, silent when
        # the schedule runs it". Every other external call in this file is already bounded; this was
        # the last one that wasn't. Output goes to a file because --dump-dom writes the page to
        # stdout, which Start-Process can only capture by redirecting it.
        #
        # --virtual-time-budget was 10000 (10s) - raised to 20000 after comparing against a working
        # reference script (the separate Python/GLPI agent - see Get-DuDataUsageViaNetwork's own
        # comment on that lineage) that escalates from 15s to 20s on a retry rather than staying at
        # 10s. This tier only runs after Selenium and Network/CDP have both already failed, so a
        # 'partial'/'nofigures' outcome here is exactly the "page's async data not having rendered
        # in time" case Test-DuScrapeDue's own comment describes - a longer budget directly targets
        # that, at the cost of the browser process living up to 10s longer per attempt, still well
        # inside the 60s WaitForExit ceiling below.
        $dumpArgs = @("--headless=new", "--disable-gpu", "--incognito", "--user-data-dir=\`"$tempProfile\`"", "--no-first-run", "--disable-extensions") + $DuBrowserFrugalArgs + @("--virtual-time-budget=20000", "--dump-dom", "http://mydata.du.ae/")
        $bp = Start-Process -FilePath $browser -ArgumentList $dumpArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $dumpFile -RedirectStandardError $dumpErrFile
        if (-not $bp.WaitForExit(60000)) {
            Stop-Process -Id $bp.Id -Force -ErrorAction SilentlyContinue
            Write-AgentLog "DU DOM dump did not finish within 60s and was killed."
        }
        # The redirected file handle is released a moment after the process itself exits.
        Start-Sleep -Milliseconds 400
        $html = Get-Content -Path $dumpFile -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrWhiteSpace($html)) {
            Write-AgentLog "DU DOM dump produced no HTML (browser exited without writing a page)."
            return $null
        }

        # Breaks the DOM into one "line" per block-level element (rather than one flattened blob)
        # before matching - a label and its value are almost always in the same or an adjacent
        # block (same table row/cell pair, or a label div followed by a value div), and matching
        # per-line avoids a keyword accidentally pairing with some UNRELATED number that just
        # happens to appear within N characters of it in a flattened string.
        $lineBreak = $html -replace '(?is)<script.*?</script>', ' ' -replace '(?is)<style.*?</style>', ' ' -replace '(?i)</(div|p|li|td|tr|span|h1|h2|h3|h4|h5|h6)>', "\`n" -replace '(?i)<br\\s*/?>', "\`n" -replace '<[^>]+>', ' '
        $lines = $lineBreak -split "\`n" | ForEach-Object { ([System.Net.WebUtility]::HtmlDecode($_) -replace '\\s+', ' ').Trim() } | Where-Object { $_ }
        if (-not $lines) { return $null }

        $joined = $lines -join ' | '
        $phone = $null
        if ($joined -match '(?:\\+?971|0)5\\d{8}') { $phone = $matches[0] }

        $usage = Get-DuUsageFromLines $lines
        [ordered]@{
            phoneNumber = $phone
            dataUsedGb  = $usage.dataUsedGb
            dataLeftGb  = $usage.dataLeftGb
            dataTotalGb = $usage.dataTotalGb
            rawSnippet  = $usage.rawSnippet
        }
    } catch {
        return $null
    } finally {
        # Not deleted here - $DuBrowserProfileDir is deliberately reused so Chromium skips first-run
        # setup on every scrape (see its definition). It's wiped at the START of every attempt, in
        # Invoke-DuScrape, not here at the end - both a locked/corrupted profile from a killed
        # process AND a stale cached du identity (see Invoke-DuScrape's own comment) need to be gone
        # BEFORE the next launch reads from this same directory, not just cleaned up after.
        Remove-Item -Path $dumpFile -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $dumpErrFile -Force -ErrorAction SilentlyContinue
    }
}

# Compares a group of fields against what was last actually SENT to the server (a local JSON
# snapshot file, not just the freshly-collected value) - used to gate the moderate (6-hourly) and
# heavy (8am-anchored) payload tiers below, so a check-in only pays the bytes for them when
# something in the group has genuinely changed, rather than resending the same antivirus/remote-ID/
# software/volumes data every time that tier's schedule comes around regardless of whether anything
# is actually different.
#
# Deliberately PURE - it only reads and compares, never writes. Committing the new snapshot is a
# separate step (Save-AgentSnapshot, called only after the check-in POST actually succeeds): an
# earlier version wrote the snapshot here, at comparison time, which meant a check-in that FAILED
# to send - the normal case on a flaky cellular SIM, which is exactly what these PCs are on - still
# left the agent believing the server had received that data. The fields would then be omitted from
# every subsequent cycle (nothing "changed" any more) and the dashboard would keep showing the
# older values until something happened to change them again.
function Test-AgentSnapshotChanged($current, $stateFile) {
    $currentJson = $current | ConvertTo-Json -Compress -Depth 6
    $previousJson = if (Test-Path $stateFile) { Get-Content -Path $stateFile -Raw -ErrorAction SilentlyContinue } else { $null }
    return ($currentJson -ne $previousJson)
}

function Save-AgentSnapshot($current, $stateFile) {
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    ($current | ConvertTo-Json -Compress -Depth 6) | Set-Content -Path $stateFile -Encoding utf8 -NoNewline
}

function Invoke-Checkin([switch]$Light, [switch]$Forced) {
    # Close-StrayAgentWindows was only ever called from the Tray's own timer loop (see -Tray below),
    # which only runs in a real, logged-in interactive session. On any PC where nobody is currently
    # logged in - or the Tray simply isn't running - nothing ever called it at all, regardless of
    # whether it could successfully close a window once invoked. Fixing the duplicate Add-Type it
    # used to throw on (see that function's own comment) only fixed what happens WHEN it runs; it
    # never made it run anywhere a stray window could actually be waiting. SYSTEM checks in on every
    # PC regardless of who is logged in and already has the rights to close a process in another
    # session, so this is the one call site guaranteed to reach every machine. Confirmed live on
    # multiple PCs, 2 Sep 2026: a stray console sat in the taskbar with no interactive user logged in
    # at all, so the Tray - and therefore this cleanup - had never run since the PC last booted.
    try { Close-StrayAgentWindows } catch {}
    $remoteScript = Get-RemoteCollectorScript
    $data = $null
    if ($remoteScript) {
        try {
            $data = & ([ScriptBlock]::Create($remoteScript))
        } catch {
            Write-Warning "Remote collector script failed, falling back to built-in default: $($_.Exception.Message)"
        }
    }
    if (-not $data) { $data = Invoke-DefaultCollector }
    if ($Light) { $data.light = $true }

    # Which published build this PC is ACTUALLY running, as opposed to which one the dashboard last
    # published - two different questions, and nothing reported the first one. The collector's own
    # agentVersion ("3.2") is the script's hand-maintained internal constant and stayed identical
    # across v64 -> v71, so it could never answer "has this PC taken the fix yet?".
    #
    # Read HERE, in the shell, rather than in the collector: $ShellVersionFile is a shell variable,
    # and the collector is a separately-fetched document where it does not exist - reading it there
    # would be the same cross-document mistake that left Get-AnyDeskInstalls undefined for months.
    #
    # Sent on every cycle rather than gated into the moderate tier: it is a two-or-three character
    # string, and it is precisely the field you want current when a rollout is in flight - gating it
    # behind a 6-hourly "only if changed" check would mean the dashboard learns a PC took the new
    # build up to six hours after it did, which is most of the value gone.
    #
    # NULL/absent on a PC that has never self-updated, which is honest: it is running whatever
    # shipped in its installer and there is no published version to name.
    try {
        if (Test-Path $ShellVersionFile) {
            $__shellVer = (Get-Content -Path $ShellVersionFile -Raw -ErrorAction SilentlyContinue)
            if ($__shellVer) { $data.shellVersion = $__shellVer.Trim() }
        }
    } catch {}

    # First check-in after a dashboard-triggered rename (see the ::RENAME handler): tells the server
    # what this PC used to be called, so it renames the existing row rather than inserting a new one
    # under the new hostname and orphaning all the admin-curated fields attached to the old one.
    # Sent on every check-in until one succeeds - the marker is only cleared after the POST below
    # returns, so a failed check-in retries rather than losing the link.
    if (Test-Path $RenamedFromFile) {
        try {
            $renamedFrom = (Get-Content -Path $RenamedFromFile -Raw -ErrorAction SilentlyContinue).Trim()
            if ($renamedFrom -and $renamedFrom -ne $env:COMPUTERNAME) { $data.previousHostname = $renamedFrom }
        } catch {}
    }

    # Three payload tiers, all collected locally on EVERY cycle regardless (that only costs CPU/
    # WMI/registry time, not metered SIM data) but transmitted on different schedules:
    #   - Identity + Issues (hostname, problems, networkBytesTotal, agentVersion): every cycle,
    #     including the 20-minute poll - this is what keeps Online/Offline and the Issues tile
    #     fresh at 20-minute resolution. Never stripped below.
    #   - Moderate (ip, remote-access IDs, OS info, logged-in user, antivirus): only on a full
    #     (non-Light) check-in, and even then only if something in the group actually changed since
    #     the last time it was SENT - a 6-hourly cycle with nothing new still checks in (Online/
    #     Offline/Issues above still go out), it just omits these specific fields that cycle.
    #   - Heavy (volumes, hardware components, the installed-software list): gated purely by the
    #     SAME daily boundary as the DU scrape below, independent of Light/full - whichever check-in
    #     first crosses this host's slot carries them (if changed), same as it carries that day's DU
    #     numbers, rather than these waiting on the separately-timed 6-hourly schedule. Widening the
    #     DU jitter therefore spreads the heavy inventory refresh across the same window too, which
    #     is the same pile-up argument applied to the other once-a-day burst of work.
    # anydeskInstalls was omitted here when it was first added, which meant it rode along on every
    # 20-minute check-in uncapped instead of being gated like every other moderate field - exactly
    # the silent per-cycle data cost this tiering exists to prevent.
    $moderateFields = @('ip', 'anydeskId', 'teamviewerId', 'otherRemoteIds', 'anydeskInstalls', 'broadsignPlayerId', 'grassfishBoxId', 'os', 'osVersion', 'loggedInUser', 'antivirus')
    $heavyFields = @('volumes', 'components', 'software')
    $duFields = @('duScrapeAttemptedAt', 'duScrapeOutcome', 'duScrapeNote')

    # Only reported when the detected set actually CHANGES from last time (a local state file
    # tracks the last-reported titles) - the same stray Windows Update prompt sitting there for
    # hours shouldn't get resent every 20 minutes, only the moment something new shows up (or the
    # existing one finally clears).
    #
    # The call below is a deliberate no-op left in place, not a real scan: this check-in runs as
    # SYSTEM in Session 0, which cannot see another session's windows AT ALL - Get-Process there
    # returns zero windowed processes for every process regardless of what is actually on screen.
    # Confirmed live on PC-88AEDD6212C8, 26 Aug 2026: a Windows Security dialog was visibly covering
    # the signage content and this call still found nothing, meaning no popup could ever have been
    # reported from here, independent of the allowlist. The real scan runs continuously in the
    # Tray's own timer (the only part of this agent that actually runs in the interactive session -
    # see its add_Tick handler), which drops its result in $PopupHandoffFile for check-in to read.
    # Left here anyway as a harmless fallback for the (SYSTEM-only) rare edge case where genuinely
    # no one is logged in and yet a window somehow rendered in Session 0 - costs nothing to keep,
    # Get-Process with no matches is effectively free.
    try {
        $__unexpected = @(Get-UnexpectedWindows)
    } catch { $__unexpected = @() }
    # Prefers the Tray's handoff whenever it exists and isn't stale - stale meaning older than two
    # scan intervals (60s), which is generous enough to absorb one missed tick without silently
    # trusting a Tray that crashed or a user who logged off an hour ago. A stale or unparsable
    # handoff is treated as "no data" and simply falls back to the (always-empty) SYSTEM-side result
    # above, rather than reporting a since-resolved popup forever.
    if (Test-Path $PopupHandoffFile) {
        try {
            $popupHandoff = Get-Content -Path $PopupHandoffFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
            # Deliberately (Get-Date), not (Get-Date).ToUniversalTime() - a bare [datetime] cast of a
            # "...Z"-suffixed string returns Kind=Local, correctly SHIFTED to the local-time
            # equivalent of that UTC instant (confirmed live: casting "10:54Z" on a UTC+4 box yields
            # 14:54 Local, not 10:54 relabelled). That's already Test-DuScrapeDue's exact pattern for
            # comparing $lastAttempt against $boundary - both sides Local-kind and mutually
            # consistent. Subtracting a Utc-kind "now" against that Local-kind value here instead
            # would silently produce a huge Sign-flipped offset equal to the machine's UTC offset,
            # which on this fleet (UTC+4) manifests as a large NEGATIVE age - and a negative number
            # is always -le any positive threshold, so the staleness check would never trigger at
            # all, no matter how old the handoff actually was. Caught by an explicit round-trip test
            # before shipping, not left to be discovered on a real device.
            $handoffAgeSeconds = if ($popupHandoff.at) { ((Get-Date) - [datetime]$popupHandoff.at).TotalSeconds } else { [double]::PositiveInfinity }
            if ($handoffAgeSeconds -le 60) {
                $__unexpected = @($popupHandoff.unexpected | ForEach-Object { [pscustomobject]@{ title = $_.title; process = $_.process } })
            }
        } catch {}
    }
    $__unexpectedKey = (($__unexpected | ForEach-Object { "$($_.title)|$($_.process)" }) | Sort-Object) -join ';'
    $__lastPopupKey = if (Test-Path $PopupStateFile) { Get-Content -Path $PopupStateFile -Raw -ErrorAction SilentlyContinue } else { '' }
    # Added to $data.problems on EVERY cycle a popup is present, not only the cycle where the set
    # first changed - workspace-directory-checkin overwrites the stored problems column outright on
    # every check-in rather than merging, so a payload that only carries the popup on the ONE cycle
    # it was first noticed gets silently erased by the very next (unchanged) cycle's payload, which
    # has nothing in it to say the popup is still there. Confirmed live on HM-OFFICE-TEST, 26 Aug
    # 2026: the 16:17:49 check-in successfully reported it, and it was gone from the database again
    # by 16:18:53 - the popup itself never moved, only the report of it did, because that next
    # cycle's key matched the previous one and skipped adding it. The alert-scan runs every 20
    # minutes; a report that only exists in the database for the ~60-70 seconds between two canary
    # polls is realistically never going to be caught by it, which is exactly why no Slack alert
    # ever fired despite the detection genuinely working.
    if ($__unexpected.Count -gt 0) {
        $popupSummary = ($__unexpected | ForEach-Object { "$($_.title) ($($_.process))" }) -join '; '
        # @() wraps the WHOLE filtered pipeline, not just $data.problems going in - piping to
        # Where-Object and assigning its output directly collapses to a bare STRING (not a
        # 1-element array) whenever exactly one problem passes the filter, which made the "+"
        # below silently do STRING concatenation instead of array-append: confirmed live on
        # AE1PC119, 3 Sep 2026, with exactly one pre-existing problem ("Windows Defender is
        # reporting disabled") - stored as one squished string, "...disabledUnexpected window...",
        # with no space between the two messages. Never showed with 0 problems (nothing to
        # concatenate onto) or 2+ (multiple pipeline results already assign as an array), which is
        # exactly why this sat unnoticed until a PC had precisely one.
        $existingProblems = @($data.problems | Where-Object { $_ })
        $data.problems = @($existingProblems + "Unexpected window/popup detected: $popupSummary")
    }
    # The state file and log line stay gated on an actual CHANGE, same as before - that part was
    # never the bug. Logging "still there" every 20-60 seconds for as long as a popup sits on screen
    # would just be noise; the fix above only needed to stop erasing the SERVER's copy, not to make
    # the LOCAL log any chattier.
    if ($__unexpectedKey -ne $__lastPopupKey) {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Content -Path $PopupStateFile -Value $__unexpectedKey -Encoding utf8 -NoNewline
        if ($__unexpected.Count -gt 0) {
            Write-AgentLog "Popup/unexpected window detected: $popupSummary"
        } else {
            Write-AgentLog "Previously-detected popup/unexpected window is gone."
        }
    }

    # A previous cycle's command result, if one is waiting locally - reported on this check-in,
    # then removed so it isn't sent again next time.
    if (Test-Path $PendingResultFile) {
        try {
            $cached = Get-Content -Path $PendingResultFile -Raw | ConvertFrom-Json
            if ($cached.output) { $data.commandOutput = $cached.output }
            Remove-Item -Path $PendingResultFile -Force -ErrorAction SilentlyContinue
        } catch { Write-Warning "Could not read cached command result: $($_.Exception.Message)" }
    }

    # Launching a browser is slow, so this only runs once a day, anchored to this host's own slot in
    # the 3-8 AM local window (see Get-DuJitterMinutes) rather than "N hours since the last attempt" -
    # a rolling window drifts earlier every day it's checked slightly early (a PollOnce cycle that
    # happens to land at, say, 19:55 would push the next day's scrape to 15:55, then 11:55, and so
    # on), which stops lining up with a predictable time of day to look at the numbers. Comparing
    # against the most recent per-host boundary instead means it fires within one ~20-minute poll
    # cycle after that host's slot every day, no matter how the exact check-in timing has wandered -
    # and staggered rather than a flat 8:00 for every device, since a fleet-wide pile-up on the same
    # clock second is exactly what took down 11 of 12 devices on 24 Aug 2026 (see Get-DuJitterMinutes
    # for the evidence). On a brand-new install (no state file yet)
    # this is due immediately, same as before - the first-ever check-in already collects a baseline
    # reading rather than waiting for the next window. The gate still advances on every ATTEMPT, not
    # just success, so a temporarily-unreachable page retries at tomorrow's slot rather than looping
    # every cycle for the rest of today.
    # The state file holds a JSON record of the last attempt ({ at, outcome, note }) rather than the
    # bare timestamp it used to - the outcome has to survive between cycles so it can be re-reported
    # on ordinary check-ins too (see below), not just on the one cycle a day that actually scrapes.
    # Agents updating from an older version still have a plain timestamp sitting there - treated as
    # outcome "error" (never $null) rather than genuinely unknown, so it's eligible for the hourly
    # retry below instead of silently trusted as done for the day. $null would be the wrong default:
    # confirmed live on PC-F44D306862C0, which self-updated fine but whose legacy timestamp was from
    # THIS MORNING'S ACTUAL FAILURE - with no outcome attached, and a jitter slot earlier than that
    # timestamp, the new gate read "already tried today" and would have gone right on trusting a
    # known failure as settled, the exact silent-failure blind spot this whole fix exists to close.
    # The cost is symmetric but one-sided in practice: a device whose legacy attempt actually
    # succeeded gets one unnecessary bonus scrape during the migration window, gone for good the
    # moment any real 3.2 scrape writes a proper outcome - trivial next to a failure going unnoticed
    # for days again, which is exactly what happened to DR2-FOODCOURT before today.
    # Both halves of the scrape - the SYSTEM check-in here and the user-session run launched by the
    # tray - ask these same two functions, so "when is a scrape due" has exactly one definition.
    $duState = Get-DuScrapeState
    # A Force Inventory Pull normally only upgrades a check-in from light to moderate (IP/remote-IDs/
    # OS/antivirus) - the heavy tier below (volumes/components/software/DU scrape) still waited for
    # this PC's own 3-8AM window regardless of Force, so "Force" on a PC outside that window silently
    # did nothing for exactly the fields an admin forcing a pull usually wants to see right now.
    # Confirmed live 2 Sep 2026 on DESKTOP-OMM99EM/PC-E89C258BBD2F: both cleared force_checkin_
    # requested and updated last_seen on a forced pull at 1pm Dubai time, and neither sent volumes or
    # attempted a DU scrape, because $duDue was false at that hour regardless of the force.
    #
    # Bypassing the window entirely on every Force would recreate the exact thundering-herd risk the
    # window exists to prevent - a bulk Force across many devices would blast du.ae with simultaneous
    # logins. Scoped to $IsTestPc instead: only the small, deliberately-picked canary list (see
    # AGENT_CANARY_HOSTNAMES) can force the heavy tier/DU scrape on demand, for exactly this kind of
    # "does the fix actually work" check - the rest of the fleet keeps the safe once-a-day window
    # no matter how Force is used against it, including after this build is ever promoted fleet-wide.
    $duDue = (Test-DuScrapeDue $duState) -or ($Forced -and $IsTestPc)
    if ($duDue) {
        # Headless Edge renders nothing in Session 0 - confirmed live: about:blank itself returned
        # 0 bytes, so this is not about du, the network or the parser. Scraping is handed to the
        # user session where a browser actually works; that run reports its own figures and leaves
        # the result in the handoff file, which Get-DuScrapeState folds in on a later cycle.
        $duDelegated = Start-DuScrapeInUserSession
    }
    if ($duDue -and -not $duDelegated) {
        # Prior outcome decides whether a phone-number-only result is the first strike ('partial',
        # retried in an hour) or the second ('nofigures', done for the day) - see Invoke-DuScrape.
        $duResult = Invoke-DuScrape $duState.outcome
        Add-DuFiguresToPayload $data $duResult
        # Feeds the attempt record straight into the reporting block below rather than
        # setting those fields here, so a scrape that just ran and one that ran days ago
        # travel exactly the same path into the payload.
        $duState = $duResult
    }

    # Reported on EVERY check-in from the stored state, not only on the cycle that runs the scrape.
    # Two reasons. The server used to hear about successful scrapes only, so a PC on Wi-Fi/LAN (which
    # can never succeed, by design) looked identical to one whose scrape is broken, and both looked
    # identical to one that had never tried - all three sat on "Not checked" indefinitely, which is
    # how DR2-FOODCOURT spent four days quietly failing every morning with nothing to show for it.
    # And re-sending it every cycle means an agent that has just updated reports what it already
    # knows on its very next check-in, rather than the answer only appearing after the next slot.
    if ($duState -and $duState.at) {
        $data.duScrapeAttemptedAt = $duState.at
        if ($duState.outcome) { $data.duScrapeOutcome = $duState.outcome }
        if ($duState.note) { $data.duScrapeNote = $duState.note }
    }

    # Now that $duDue is known, actually apply the moderate/heavy tiering decided above - removing
    # a key entirely (not just nulling it) so ConvertTo-Json omits it from the payload altogether,
    # which is what tells workspace-directory-checkin to leave that field's stored value untouched
    # rather than overwriting it with an empty one.
    # Snapshots of whatever tiers this payload ends up carrying, held here and only written to disk
    # AFTER the POST below actually succeeds (see Test-AgentSnapshotChanged for why that ordering
    # matters) - a failed check-in must leave the previous snapshot intact so the same data is
    # retried on the next cycle rather than being silently considered delivered.
    $snapshotsToCommit = New-Object System.Collections.Generic.List[object]
    if ($Light) {
        foreach ($f in $moderateFields) { $data.Remove($f) }
    } else {
        $moderateSnapshot = [ordered]@{}
        foreach ($f in $moderateFields) { $moderateSnapshot[$f] = $data[$f] }
        if (Test-AgentSnapshotChanged $moderateSnapshot $ModerateSnapshotFile) {
            $snapshotsToCommit.Add(@{ data = $moderateSnapshot; file = $ModerateSnapshotFile })
        } else {
            foreach ($f in $moderateFields) { $data.Remove($f) }
        }
    }
    if ($duDue) {
        $heavySnapshot = [ordered]@{}
        foreach ($f in $heavyFields) { $heavySnapshot[$f] = $data[$f] }
        if (Test-AgentSnapshotChanged $heavySnapshot $HeavySnapshotFile) {
            $snapshotsToCommit.Add(@{ data = $heavySnapshot; file = $HeavySnapshotFile })
        } else {
            foreach ($f in $heavyFields) { $data.Remove($f) }
        }
    } else {
        foreach ($f in $heavyFields) { $data.Remove($f) }
    }
    # The scrape-attempt trio rides the same "only if it changed" rule as the moderate tier rather
    # than a schedule of its own. It's re-derived from stored state on EVERY cycle, so an agent that
    # has just updated (or one whose earlier check-in failed to send) reports what it already knows
    # on its very next check-in instead of the answer waiting for tomorrow's slot - but it only
    # actually costs bytes on the cycles where the answer is new, which is at most once a day and
    # usually far rarer, since a device's outcome rarely changes from one day to the next.
    $duSnapshot = [ordered]@{}
    foreach ($f in $duFields) { $duSnapshot[$f] = $data[$f] }
    if (Test-AgentSnapshotChanged $duSnapshot $DuSnapshotFile) {
        $snapshotsToCommit.Add(@{ data = $duSnapshot; file = $DuSnapshotFile })
    } else {
        foreach ($f in $duFields) { $data.Remove($f) }
    }

    $payload = $data | ConvertTo-Json -Depth 6 -Compress
    try {
        $response = Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $payload -ContentType "application/json" \`
            -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30
        Write-Host "Checked in successfully."
        Write-AgentLog "Check-in succeeded."
        Write-AgentStatus $true "Checked in successfully."
        # Only NOW is it true that the server has this data - see Test-AgentSnapshotChanged.
        foreach ($snap in $snapshotsToCommit) { Save-AgentSnapshot $snap.data $snap.file }
        # The rename link has been delivered and acted on, so stop resending it.
        if ($data.previousHostname) { Remove-Item -Path $RenamedFromFile -Force -ErrorAction SilentlyContinue }
        if ($response -and $response.pendingCommand) {
            Write-Host "Running queued command..."
            Write-AgentLog "Running queued command: $($response.pendingCommand)"
            Invoke-PendingCommand $response.pendingCommand
            # Reports the result via an immediate follow-up POST right now, instead of only caching
            # it for the dashboard to pick up on the NEXT scheduled check-in (~20 minutes later,
            # same idea as the ::UNINSTALL branch's own immediate POST above). By this point
            # Invoke-PendingCommand has ALREADY finished - it blocks until the child process exits
            # or its own timeout fires - so $PendingResultFile is already sitting there fully
            # written; the old code just left it for the NEXT cycle's "read cached result" step at
            # the top of this function to pick up, which meant every single Run Command took two
            # full poll cycles end-to-end (one to dispatch, one just to report) even though the
            # actual work was done after the first. Best-effort: only removed from disk once this
            # immediate report actually succeeds, so a dropped connection here still falls back to
            # the existing next-cycle path rather than losing the result.
            if (Test-Path $PendingResultFile) {
                try {
                    $justRan = Get-Content -Path $PendingResultFile -Raw | ConvertFrom-Json
                    if ($justRan.output) {
                        $followUpPayload = @{ hostname = $env:COMPUTERNAME; light = $true; commandOutput = $justRan.output } | ConvertTo-Json -Compress
                        Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $followUpPayload -ContentType "application/json" -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15 | Out-Null
                        Remove-Item -Path $PendingResultFile -Force -ErrorAction SilentlyContinue
                        Write-AgentLog "Reported queued command's result immediately instead of waiting for the next check-in."
                    }
                } catch { Write-AgentLog "Immediate command-result report failed, will report on next check-in instead: $($_.Exception.Message)" }
            }
        }
    } catch {
        Write-Warning "Check-in failed: $($_.Exception.Message)"
        Write-AgentLog "Check-in FAILED: $($_.Exception.Message)"
        Write-AgentStatus $false $_.Exception.Message
    }
}

# The actual body of a queued Run Command - split out from Invoke-PendingCommand above and run in a
# SEPARATE CHILD process specifically so that function can enforce a hard timeout on it (see there
# for why). $RunCommandFile holds the command TEXT itself, not the command inline as a command-line
# argument - a ::BATCH command can contain literal newlines a raw argument can't safely carry through
# process creation, and this sidesteps command-line quoting entirely.
#
# Placed HERE - after every function this command could possibly call (Get-DuDataUsage,
# Get-UnexpectedWindows, Invoke-Checkin, etc.) is already defined - rather than near the top of the
# script alongside -Uninstall. PowerShell does NOT hoist function definitions to the top of a script;
# a "function Foo { ... }" statement only becomes callable once the interpreter's linear top-to-bottom
# pass actually executes that line. Invoke-Checkin (defined earlier) can already call Get-DuDataUsage
# (defined later) because Invoke-Checkin itself isn't CALLED until the bottom of the script, by which
# point every function has been passed through - but this block runs immediately as soon as the
# interpreter reaches it, so placing it before those definitions made every single Run Command fail
# with "the term 'Get-DuDataUsage' is not recognized" (confirmed on a real device). Also must stay
# ABOVE the task-registration block right below - $RunCommandFile invocations never pass -Once, so
# without exiting first they'd re-register the scheduled tasks on every single queued command.
# The user-session half of the DU scrape (see $DuHandoffFile). Spawned by the tray process, which
# is the only part of this agent already running in a real interactive desktop session - the one
# place headless Edge actually renders. Deliberately does NOT check in or POST anything: it scrapes,
# writes the result to the handoff file, and exits. The next SYSTEM check-in folds that in and
# reports it through the existing path, so there is exactly one place that talks to the server.
# Sits with the other dispatch branches for the reason described directly above - Invoke-DuScrape
# is defined far below the tray branch that launches this.
if ($DuScrapeOnce) {
    $Script:DuStateTarget = $DuHandoffFile
    $Script:DuIsUserSession = $true
    try {
        $duState = Get-DuScrapeState
        # $IsTestPc alongside the natural gate, for the same reason Invoke-Checkin's own $duDue
        # carries it (see that comment) - SYSTEM only ever starts this task because ITS OWN $duDue
        # was already true, whether that came from the natural window or the test-PC Force bypass.
        # Without this, that bypass was a no-op for the delegated half of every scrape: SYSTEM would
        # log "DU scrape delegated..." and this separate process, re-deriving Test-DuScrapeDue with
        # no knowledge of why it was started, would find the window still closed and exit having done
        # nothing - the exact silent gap confirmed live on ADCOOP-MINA-AR, 2 Sep 2026: "delegated" in
        # the log, then nothing, Last Result 0 (clean exit, no error), du_scrape_attempted_at never
        # advancing. This process has no $Forced switch of its own to check - it never runs at all
        # except when something already decided a scrape was warranted.
        if ((Test-DuScrapeDue $duState) -or $IsTestPc) {
            Write-AgentLog "User-session DU scrape starting (tray-triggered)."
            # Same strike-count hand-off as the SYSTEM path: 'partial' last time means this run is
            # the retry, and a second phone-only result records 'nofigures' instead of looping.
            $r = Invoke-DuScrape $duState.outcome
            Write-AgentLog "User-session DU scrape finished: $($r.outcome)"
            # Reports its own result immediately rather than waiting for SYSTEM's next check-in to
            # notice the handoff - the figures reach the dashboard the moment they are scraped
            # instead of up to 20 minutes later. Needs no elevation: posting is a plain HTTPS call
            # with the shared secret this script already carries.
            #
            # The handoff file is still written (by Invoke-DuScrape above, via $DuStateTarget) even
            # though the server already has the data. That is not redundant: it is what keeps
            # SYSTEM's own local gate in step, so the 6-hourly check-in sees the day's scrape as
            # done instead of re-running it in Session 0 - where it can only fail, record an error,
            # and start the hourly retry churning against a browser that cannot render there.
            $duPayload = @{
                hostname = $env:COMPUTERNAME
                light = $true
                duScrapeAttemptedAt = $r.at
                duScrapeOutcome = $r.outcome
            }
            if ($r.note) { $duPayload.duScrapeNote = $r.note }
            Add-DuFiguresToPayload $duPayload $r
            try {
                Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body ($duPayload | ConvertTo-Json -Compress) -ContentType "application/json" \`
                    -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30 | Out-Null
                Write-AgentLog "User-session DU result reported straight to the dashboard."
            } catch {
                # Not a failure worth retrying here - the handoff file already holds the result, so
                # SYSTEM's next check-in reports it through the normal path regardless.
                Write-AgentLog "Could not report the user-session DU result directly (the next check-in will carry it): $($_.Exception.Message)"
            }
        }
    } catch {
        Write-AgentLog "User-session DU scrape failed to run: $($_.Exception.Message)"
    }
    exit 0
}

if ($RunCommandFile) {
    $command = Get-Content -Path $RunCommandFile -Raw -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = '' }
    $isBatch = $command -match '^\\s*::BATCH\\r?\\n'
    try {
        if ($isBatch) {
            $batchBody = $command -replace '^\\s*::BATCH\\r?\\n', ''
            New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
            Set-Content -Path $PendingBatchFile -Value $batchBody -Encoding ascii
            $output = & cmd.exe /c "\`"$PendingBatchFile\`"" 2>&1 | Out-String
            Remove-Item -Path $PendingBatchFile -Force -ErrorAction SilentlyContinue
        } else {
            # *>&1, not just 2>&1: Write-Host writes to the Information stream (6), a SEPARATE
            # stream from both Success (1) and Error (2) since PowerShell 5 - "2>&1" only merges
            # Error into Success, so a multi-step queued command that narrates its own progress via
            # Write-Host (exactly what a hand-authored optimization/maintenance script tends to do)
            # would report back almost nothing: only whatever a bare, uncaptured expression happened
            # to emit on the Success stream, with every Write-Host line silently dropped - not an
            # error, just gone, because there is no interactive host here to write to. "*>&1" merges
            # every stream (Warning, Verbose, Debug too) into Success so Out-String actually captures
            # what the command told the console it was doing.
            $output = Invoke-Expression $command *>&1 | Out-String
        }
    } catch {
        $output = "ERROR: $($_.Exception.Message)"
    }
    # A command that returns nothing (a function whose result was $null - "$null | Out-String" is an
    # EMPTY string, not "null") gets an explicit placeholder rather than being stored as "". Both
    # readers of this file downstream guard with a plain truthiness test - "if ($cached.output)" and
    # "if ($justRan.output)" - which an empty string fails, so an empty result was silently dropped:
    # never POSTed, so the server never cleared pending_command, so the SAME command re-ran on every
    # single cycle forever with no trace of why. Confirmed live on a real device: an agent log full of
    # "Running queued command: Get-DuDataUsageViaDom" every 20 minutes for hours, and not one result.
    # That silence also masked the real finding underneath it - that the command was returning $null.
    if ([string]::IsNullOrWhiteSpace($output)) {
        $output = "(command completed but produced no output)"
    }
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    @{ output = $output.Substring(0, [Math]::Min(8000, $output.Length)); ranAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content -Path $PendingResultFile -Encoding utf8
    exit 0
}

# Re-registers both scheduled tasks (and bootstraps Chocolatey) on EVERY real run - a fresh manual
# install AND every recurring 6-hourly -Once cycle - not just at first install. This used to be
# gated behind "if (-not $Once)", which only a flagless run satisfies - meaning a change to the
# TASKS' OWN settings/actions (as opposed to a change to what Invoke-Checkin etc. do, which every
# cycle already picks up via self-update) could NEVER reach an already-installed device short of a
# physical reinstall. Register-/Set-ScheduledTask are idempotent and cheap, so running this every
# cycle costs nothing and means any future task-level fix (like the ExecutionTimeLimit below)
# actually reaches the whole fleet within one 6-hour cycle of publishing, same as everything else.
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$InstalledScriptPath\`" -Once"
# [TimeSpan]::MaxValue as -RepetitionDuration overflows Task Scheduler's XML duration format on
# some Windows builds ("The task XML contains a value which is incorrectly formatted or out of
# range", confirmed live) - Task Scheduler's own convention for "repeat indefinitely" is an
# EMPTY Duration, not the largest representable one, so that's set directly on the trigger
# object instead of passed as a constructor value.
$RepeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)
$RepeatTrigger.Repetition.Duration = ""
# Also fire once right after boot (a couple minutes' random delay so a fleet of PCs rebooting
# together - e.g. after a power cut at a venue - doesn't all hit the checkin endpoint in the
# same instant), on TOP of the every-6-hours repeat above, not instead of it - a task's trigger
# list can hold both and each fires independently. Without this, a PC that reboots mid-cycle
# (or was off across its next scheduled time) sits "stale" until the following 6-hour mark
# instead of checking in - and reporting back in - as soon as it's back up.
$StartupTrigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Minutes 2)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
# Without an explicit ExecutionTimeLimit, Task Scheduler's own default is 3 days - and since
# neither task allows overlapping instances (the default MultipleInstances policy is IgnoreNew),
# a SINGLE hung run - whatever the cause, now or in some future code change - silently blocks
# every subsequent trigger for up to 3 days with nothing forcing it to die. Confirmed live: a PC
# showed "Running" in Task Scheduler for 22+ hours straight on what should be a 20-minute cycle,
# which had also left it wrongly flagged Offline on the dashboard that whole time. These bounds
# are deliberately generous relative to what a normal run should ever need (a full 6-hourly
# check-in with a queued Run Command's own 3-minute child-process timeout baked in) while still
# guaranteeing the fleet self-heals from any hang within well under a day rather than up to 3.
# -AllowStartIfOnBatteries and -DontStopIfGoingOnBatteries on EVERY task this script registers,
# because PowerShell's own defaults for both are the opposite and they are silently fatal here:
# New-ScheduledTaskSettingsSet defaults DisallowStartIfOnBatteries=True AND StopIfGoingOnBatteries
# =True, so Windows refuses to start the task while a machine is on battery and KILLS it mid-run
# the moment the machine switches to battery. The agent then goes completely silent - no check-in,
# no poll, no self-update - on a PC that is powered on and working perfectly, and the dashboard
# correctly-but-uselessly reports it Offline with no way to tell that apart from a real outage.
# Confirmed live on AE1PC119 (26 Aug 2026): running on battery, agent stopped reporting, every
# registered task carried DisallowStartIfOnBatteries=True.
#
# This stayed invisible for as long as the fleet was mains-powered signage PCs, which never leave
# AC. It is not a laptop-only concern though: a signage PC behind a UPS reports as battery-powered
# for the duration of any mains blip, which is exactly the moment monitoring needs to keep working
# rather than switch itself off.
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Preserves a deliberate Disable-ScheduledTask from the service-migration step below, which this
# same refresh would otherwise silently undo. Set-ScheduledTask replaces the whole task definition,
# and $Settings.Enabled defaults to $true - so on a PC that has already migrated to the Windows
# Service, THIS unconditional refresh re-enabled the very task the migration step had just disabled,
# which then saw it "not yet disabled" and disabled it again, forever: every single cycle silently
# re-enabling and re-disabling the same task, logging "Migrated to the Windows Service" every time
# regardless of whether the service had ever actually gone down. Confirmed live on AE1PC119 and
# multiple fleet PCs, 2 Sep 2026 - the message repeating roughly once per poll interval with the
# service reporting Running throughout, which is what exposed this rather than an actual crash loop.
$existingMainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingMainTask -and $existingMainTask.State -eq 'Disabled') { $Settings.Enabled = $false }
try {
    if ($existingMainTask) {
        Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($RepeatTrigger, $StartupTrigger) -Principal $Principal -Settings $Settings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($RepeatTrigger, $StartupTrigger) -Principal $Principal -Settings $Settings -Description "Reports this PC's inventory to the Hypermedia Operations Dashboard." | Out-Null
    }
    Write-Host "Scheduled task '$TaskName' installed (runs on startup and every 6 hours)." -ForegroundColor Green
} catch {
    Write-Warning "Could not register the scheduled task: $($_.Exception.Message)"
}

# The one folder a logged-in (non-admin) user is allowed to write, so the Tray can hand results back
# to SYSTEM - both the once-a-day DU scrape (see $DuHandoffFile) and the continuous popup scan (see
# $PopupHandoffFile) drop their output here now; neither can run anywhere SYSTEM's own Session 0
# could read it directly. Scoped to this sub-folder ONLY, never $StateDir itself: that holds
# Install-JstarAgent.ps1, which SYSTEM executes every cycle, so making it user-writable would let any
# logged-in user swap in their own script and have SYSTEM run it. (OI)(CI)M grants modify on the
# folder and anything created inside it. Re-applied every cycle because this whole block is
# idempotent by design, so a machine that had the folder removed or its ACL reset repairs itself
# within one cycle.
try {
    New-Item -ItemType Directory -Path $DuHandoffDir -Force -ErrorAction SilentlyContinue | Out-Null
    & icacls.exe $DuHandoffDir /grant "*S-1-5-32-545:(OI)(CI)M" /T /C | Out-Null
} catch {
    Write-Warning "Could not grant the logged-in user write access to the handoff folder - the user-session scrape and popup scan will not be able to report back: $($_.Exception.Message)"
}

# Chocolatey's bootstrapper is skipped entirely once choco.exe is already on PATH, so re-checking
# every heavy cycle (rather than fresh-install only) is cheap and self-heals if it's ever removed -
# lets a Run Command queued from the dashboard, or a future bulk deployment, always reach for
# "choco install -y <pkg>" without depending on winget/App Installer already being present (it isn't
# on every Windows 10 build these back-office/kiosk PCs run). A function (not inline) so the
# -Service loop's own heavy branch further down can call it too, the same reason
# Set-NotificationSuppressionPolicy is a function - a check that only ran from the now-disabled
# Scheduled Task fallback would quietly stop self-healing the moment a PC migrates to the service.
function Install-ChocolateyIfMissing {
    if (Get-Command choco.exe -ErrorAction SilentlyContinue) { return }
    try {
        Write-Host "Installing Chocolatey (package manager used by queued Run Commands)..."
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        Write-Host "Chocolatey installed." -ForegroundColor Green
    } catch {
        Write-Warning "Could not install Chocolatey - choco-based Run Commands won't work on this PC until it's installed manually: $($_.Exception.Message)"
    }
}
Install-ChocolateyIfMissing

# Runs -PollOnce every 20 minutes, entirely headless as SYSTEM (no tray icon, no window, no
# notification - these PCs drive signage screens, so nothing may ever pop up on top of the
# content). Does double duty: it's the ONLY way a dashboard "Force Inventory Pull" click can
# reach a specific PC sooner than its next scheduled cycle (these PCs are on metered SIMs behind
# NAT/cellular routers with no inbound reachability; the dashboard can never push to them, only
# they can poll out) - AND, on every cycle that isn't a force, it sends a light check-in
# (see Invoke-Checkin's -Light handling) so Online/Offline status, Issues, and Remote Access stay
# fresh at 20-minute resolution without resending the installed-software list every time. Up to
# ~20 minutes' latency and a small request are an easy trade for both of those.
try {
    $PollAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$InstalledScriptPath\`" -PollOnce"
    $PollTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $PollIntervalMinutes)
    $PollTrigger.Repetition.Duration = ""
    # Tighter bound than the main task's - a poll cycle is either a light check-in or, at worst,
    # a forced full one with a single queued command (already capped at 3 minutes by
    # Invoke-PendingCommand's own child-process timeout), so it should never legitimately run
    # anywhere near this long. Bounding it well under the 20-minute repeat interval means a hang
    # here self-heals in time for the VERY NEXT scheduled trigger, not just "eventually."
    $PollSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    if (Get-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $PollTaskName -Action $PollAction -Trigger $PollTrigger -Principal $Principal -Settings $PollSettings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $PollTaskName -Action $PollAction -Trigger $PollTrigger -Principal $Principal -Settings $PollSettings -Description "Checks for a Force Inventory Pull request from the dashboard - every minute on a test PC, every 20 minutes on the fleet. Runs fully hidden, no UI." | Out-Null
    }
    Write-Host "Scheduled task '$PollTaskName' installed (checks every 20 minutes, no UI)." -ForegroundColor Green
} catch {
    Write-Warning "Could not register the poll task: $($_.Exception.Message)"
}

# Installs (or verifies) the Windows Service that replaces the two Scheduled Tasks just above with
# one long-running process (see the -Service branch far below) - a genuine SCM-managed service can be
# both started at boot AND restarted on a crash, which is the one combination Scheduled Tasks have
# already proven fragile at here (see the -AllowStartIfOnBatteries fix elsewhere in this file). This
# is what makes "install this agent exactly once, everything after that ships from the dashboard"
# actually true, rather than true until the next edge case Scheduled Tasks don't handle.
#
# WinSW (github.com/winsw/winsw) is fetched over plain HTTPS from its own pinned GitHub release and
# verified against a pinned SHA-256 before it is EVER executed - the same never-trust-a-download
# discipline as the self-update parse-check above, just applied to a binary instead of a script. A
# hash mismatch refuses the install outright rather than running unverified code as SYSTEM.
#
# Deliberately never removes the two tasks above - only DISABLES them, and only once the service is
# confirmed actually Running. That keeps them as a real, currently-correct, one-command recovery path
# (Enable-ScheduledTask) for as long as this PC exists, rather than something that would need to be
# fully re-installed from scratch if the service ever needed to be abandoned. A PC where the download
# fails, the hash doesn't match, or the service won't start simply keeps running on the Scheduled
# Tasks exactly as it does today, and retries the service install again on its next 6-hourly cycle.
$ServiceOk = $false
try {
    $existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $existingSvc) {
        if (-not (Test-Path $ServiceExePath)) {
            Write-Host "Downloading service wrapper (WinSW $ServiceName)..."
            $downloadPath = "$ServiceExePath.download"
            Invoke-WebRequest -Uri $WinSwUrl -OutFile $downloadPath -TimeoutSec 60 -UseBasicParsing
            $actualHash = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash
            if ($actualHash -ne $WinSwSha256) {
                Remove-Item $downloadPath -Force -ErrorAction SilentlyContinue
                throw "Downloaded service wrapper hash $actualHash does not match the pinned $WinSwSha256 - refusing to install it."
            }
            Move-Item $downloadPath $ServiceExePath -Force
        }
        $svcArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$InstalledScriptPath\`" -Service"
        # onfailure/restart covers both an actual crash and the deliberate exit(111) in
        # Invoke-SelfUpdate's Service-aware branch above - WinSW cannot tell those apart from the
        # exit code alone, which is fine: a fresh relaunch is the correct response to both.
        # resetfailure keeps a PC that is genuinely crash-looping from ever being seen as "healthy
        # again" just because an hour passed with no restarts - see resetfailure's own 1-hour window.
        $svcXml = @"
<service>
  <id>$ServiceName</id>
  <name>Hypermedia Digital Directory Agent</name>
  <description>Long-running check-in loop for the Hypermedia Operations Dashboard. Installed once - every future change ships from the dashboard's own Publish button, never by touching this PC directly.</description>
  <executable>powershell.exe</executable>
  <arguments>$svcArguments</arguments>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>3</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
</service>
"@
        Set-Content -Path $ServiceXmlPath -Value $svcXml -Encoding utf8
        # Captured (not discarded) specifically for the failure path below - WinSW reports its own
        # errors (e.g. "already exists", a permissions problem) on stdout/stderr, and with 1500 PCs
        # potentially hitting this, "did not reach Running state" with no further detail would mean
        # re-deriving the cause from scratch on every single one instead of just reading the log.
        $installOutput = & $ServiceExePath install 2>&1 | Out-String
        Start-Sleep -Seconds 2
        $startOutput = & $ServiceExePath start 2>&1 | Out-String
    } elseif ($existingSvc.Status -ne 'Running') {
        Start-Service -Name $ServiceName -ErrorAction Stop
    }
    Start-Sleep -Seconds 3
    $checkedSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $ServiceOk = [bool]($checkedSvc -and $checkedSvc.Status -eq 'Running')
    if ($ServiceOk) {
        Write-Host "Service '$ServiceName' is running." -ForegroundColor Green
        # $mainTaskState is $null both when the task genuinely isn't Disabled yet AND when it simply
        # does not exist any more (fully unregistered on an earlier cycle, rather than left disabled
        # as a recovery path - or never created at all on some install paths). $null -ne 'Disabled'
        # is ALWAYS true in PowerShell, so without the explicit existence check below this logged
        # "Migrated to the Windows Service" - and re-ran a no-op Disable-ScheduledTask - on EVERY
        # single healthy poll cycle forever, on any PC where that task no longer exists, drowning the
        # real signal in false alarms. Confirmed live on AE1PC119 and multiple fleet PCs, 2 Sep 2026:
        # the message repeating roughly once per poll interval with the service reporting Running the
        # entire time - not a crash-restart loop, just this one line firing every cycle regardless.
        $mainTaskState = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
        if ($mainTaskState -and $mainTaskState -ne 'Disabled') {
            Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
            Write-AgentLog "Migrated to the Windows Service - the 6-hourly Scheduled Task is now disabled (not removed; still available as a manual recovery path)."
        }
        # The 20-minute poll task stays ENABLED on purpose, and is re-enabled on PCs that a previous
        # build already disabled it on. It is the service's watchdog, and the watchdog logic is the
        # "elseif the service is not Running -> Start-Service" branch a few lines above: every
        # -PollOnce run passes through this same block, so a stopped service is restarted within
        # 20 minutes without anyone touching the PC.
        #
        # Disabling it alongside the 6-hourly task removed the only thing that could ever reach that
        # recovery branch, which turned every clean stop into a PERMANENT outage. WinSW's onfailure
        # restart policy covers a crash, but a service that exits 0 has "completed successfully" as
        # far as WinSW is concerned and is left stopped - and with both tasks disabled nothing else
        # on the PC runs at all.
        #
        # Confirmed live on ADCOOP-MINA-AR, 1 Sep 2026: WorkspaceDirectoryAgentSvc STOPPED with
        # WIN32_EXIT_CODE 0 and SERVICE_EXIT_CODE 0, its own log ending mid-stride on "Checked in
        # successfully" with no error, both Scheduled Tasks Disabled - silent for 3h48m and only
        # recovered by a human running sc start by hand. The one contact in that window came from the
        # user-session DU scrape, which runs under a different mechanism entirely and so made the
        # device look alive for another 30 minutes on top.
        #
        # A healthy PC pays nothing for this: the poll task's own run is a light check-in that would
        # be happening anyway, and hitting an already-Running service here is a single Get-Service.
        $pollTask = Get-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue
        if ($pollTask -and $pollTask.State -eq 'Disabled') {
            Enable-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue | Out-Null
            Write-AgentLog "Re-enabled the 20-minute poll task - it is the service's watchdog, and disabling it left a stopped service with no way back."
        }
    } else {
        $detail = (@($installOutput, $startOutput) | Where-Object { $_ }) -join ' | '
        Write-Warning "Service '$ServiceName' did not reach Running state - keeping the Scheduled Task fallback active. Will retry on the next cycle. $detail"
        Write-AgentLog "Service install/start did not reach Running: $detail"
    }
} catch {
    Write-Warning "Could not install/start the agent service - keeping the Scheduled Task fallback active: $($_.Exception.Message)"
}

# The on-demand task that carries the DU scrape into the logged-in user's session (see
# Start-DuScrapeInUserSession for why that is the only place a headless browser renders). No
# trigger at all - it exists purely to be started by the SYSTEM check-in when a scrape is due, so
# the decision about WHEN to scrape stays in one place instead of being duplicated into a second
# schedule that could drift. Same Users-group principal as the tray, at Limited rights: the scrape
# needs a desktop session, not privilege - SYSTEM already has far more privilege than an
# administrator and still cannot render a page here.
try {
    $DuAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$InstalledScriptPath\`" -DuScrapeOnce"
    $DuPrincipal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited
    # Bounded well above a normal scrape (a browser launch plus page render) but far short of the
    # 3-day default, so a wedged browser cannot block the next attempt indefinitely.
    $DuSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    if (Get-ScheduledTask -TaskName $DuScrapeTaskName -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $DuScrapeTaskName -Action $DuAction -Principal $DuPrincipal -Settings $DuSettings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $DuScrapeTaskName -Action $DuAction -Principal $DuPrincipal -Settings $DuSettings -Description "Runs the once-a-day du data-usage check in the logged-in user's session, where a headless browser can actually render." -ErrorAction Stop | Out-Null
    }
} catch {
    Write-Warning "Could not register the user-session DU scrape task - the scrape will fall back to running as SYSTEM: $($_.Exception.Message)"
}

# Registers the taskbar tray icon (see the -Tray branch far above) to start automatically whenever
# ANYONE logs into this PC's desktop - unlike the two tasks above, this one must run AS the logged-in
# user (BUILTIN\Users, not SYSTEM), since only a task running in that interactive session can ever
# show a window or tray icon there. ExecutionTimeLimit of zero means "no limit" in Task Scheduler's
# own convention (unlike the empty-string convention used for -RepetitionDuration above) - this task
# is meant to keep running for the entire logon session, not exit and re-fire on an interval like the
# other two.
try {
    $TrayAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$InstalledScriptPath\`" -Tray"
    $TrayTrigger = New-ScheduledTaskTrigger -AtLogOn
    # The well-known SID for BUILTIN\Users, not the name string - confirmed live that "BUILTIN\Users"
    # fails on a real device with "No mapping between account names and security IDs was done"
    # (HRESULT 0x80070534, ERROR_NONE_MAPPED) even though the group obviously exists - a known quirk
    # of Register-ScheduledTask's underlying CIM call doing its own name-to-SID lookup, which the
    # well-known SID form sidesteps entirely since it needs no lookup at all.
    $TrayPrincipal = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545" -RunLevel Limited
    $TraySettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    # -ErrorAction Stop on both: Register-/Set-ScheduledTask surface a failed underlying CIM call as a
    # NON-terminating error by default, which a bare try/catch does not catch - confirmed live, this
    # let a real registration failure fall straight through to the unconditional "installed" success
    # message below, masking the exact error above it in the very same log.
    if (Get-ScheduledTask -TaskName $TrayTaskName -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $TrayTaskName -Action $TrayAction -Trigger $TrayTrigger -Principal $TrayPrincipal -Settings $TraySettings -ErrorAction Stop | Out-Null
    } else {
        Register-ScheduledTask -TaskName $TrayTaskName -Action $TrayAction -Trigger $TrayTrigger -Principal $TrayPrincipal -Settings $TraySettings -Description "Shows a taskbar status icon for the Jstar Agent in the logged-in user's session - hidden automatically while Broadsign/Grassfish is playing content." -ErrorAction Stop | Out-Null
    }
    # Also starts it for whoever's ALREADY logged in right now, rather than waiting for their next
    # logon - the common case when this runs during a fresh interactive install or right after
    # publishing this change to an existing device. IgnoreNew above means this is a harmless no-op if
    # an instance from an earlier logon is already running.
    Start-ScheduledTask -TaskName $TrayTaskName -ErrorAction SilentlyContinue
    Write-Host "Scheduled task '$TrayTaskName' installed (taskbar icon, auto-hidden during signage playback)." -ForegroundColor Green
} catch {
    Write-Warning "Could not register the tray task: $($_.Exception.Message)"
}

# Suppresses two known interruption classes at the source, since detecting them after the fact
# turned out to be more trouble than it's worth on a real signage PC (see below):
#  - Windows Action Center/toast notifications, via the Explorer policy key.
#  - Chrome/Edge's own "Show notifications?" permission prompt bar, via a browser policy - this one
#    can't be caught by watching for popups at all, since it renders INSIDE the browser's own window,
#    not as a separate one.
# Deliberately does NOT touch anything under Windows Defender/Security Center - an earlier version
# also disabled its notification toasts via HKLM:\SOFTWARE\Microsoft\Windows Defender Security
# Center\Notifications, which is close to a textbook "malware disables the antivirus" signature -
# Defender's own AMSI scanner flagged the whole script as malicious content and blocked every fresh
# install outright the moment that shipped. A later version also tried detecting arbitrary unexpected
# popups generically (EnumWindows + a screenshot of whatever was found) as a fallback for anything
# not covered by the two keys below - AMSI blocked that too, for the same reason: window enumeration
# + screen capture + uploading the result over the network is close to the definition of spyware,
# regardless of intent, and no amount of removing the Defender-specific key alone fixed it. Both were
# pulled entirely rather than reworked further, since a working install matters far more than being
# able to catch a stray popup on screen.
# Called on every real check-in (the flagless/-Once path below AND the -Service loop's own heavy
# branch further down, never the lightweight poll) rather than install time only - the outer shell
# self-updates from the published agent-shell version on every run (Invoke-SelfUpdate above), so this
# reaches the whole already-installed fleet the same way any other shell change does, no per-machine
# re-install needed. Cheap/idempotent, so calling it every heavy cycle also means it self-heals if
# something else resets these keys.
function Set-NotificationSuppressionPolicy {
    try {
        New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer" -Force -ErrorAction SilentlyContinue | Out-Null
        Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer" -Name "DisableNotificationCenter" -Value 1 -Type DWord -Force
        foreach ($browserKey in @("HKLM:\\SOFTWARE\\Policies\\Google\\Chrome", "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge")) {
            New-Item -Path $browserKey -Force -ErrorAction SilentlyContinue | Out-Null
            Set-ItemProperty -Path $browserKey -Name "DefaultNotificationsSetting" -Value 2 -Type DWord -Force
        }
        Write-AgentLog "Applied signage notification-suppression policy (Action Center + Chrome/Edge permission prompts)."
    } catch {
        Write-Warning "Could not apply notification-suppression policy: $($_.Exception.Message)"
    }
}

# Checks in - lightly (see Invoke-Checkin's -Light handling above) unless a Force Inventory Pull is
# waiting, in which case it does the real thing instead. A cheap GET decides which, first. Shared by
# the old -PollOnce Scheduled Task (still the fallback path - see the WinSW install block above) and
# the new -Service loop below, so both stay behaviorally identical rather than two copies drifting.
function Invoke-PollCycle {
    $forceRequested = $false
    try {
        $resp = Invoke-RestMethod -Method Get -Uri ($ForceStatusUrl + "?hostname=" + $env:COMPUTERNAME) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 10
        $forceRequested = $resp -and $resp.force
        # A one-shot secret rides along on this same poll rather than costing its own request -
        # see the endpoint's own comment for why it travels here and not as a queued command.
        if ($resp -and $resp.secret -and $resp.secret.kind -eq "anydeskPassword") {
            $applyResult = Set-AnyDeskPassword $resp.secret.value $resp.secret.target
            # Confirmed ONLY on success, so a failed attempt leaves the delivery in place to be
            # retried next poll rather than silently discarding the admin's password. The server
            # reaps it by age if it can never be applied.
            if ($applyResult -eq "OK") {
                Write-AgentLog "AnyDesk password updated from the dashboard for id $($resp.secret.target)."
                try {
                    Invoke-RestMethod -Method Get -Uri ($ForceStatusUrl + "?hostname=" + $env:COMPUTERNAME + "&applied=" + $resp.secret.id) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 10 | Out-Null
                } catch {}
            } else {
                # The reason is logged; the password itself never is.
                Write-AgentLog "Could not update the AnyDesk password: $applyResult"
            }
        } elseif ($resp -and $resp.secret -and $resp.secret.kind -eq "rustdeskPassword") {
            $applyResult = Set-RustDeskPassword $resp.secret.value
            if ($applyResult -eq "OK") {
                Write-AgentLog "RustDesk password updated from the dashboard."
                try {
                    Invoke-RestMethod -Method Get -Uri ($ForceStatusUrl + "?hostname=" + $env:COMPUTERNAME + "&applied=" + $resp.secret.id) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 10 | Out-Null
                } catch {}
            } else {
                Write-AgentLog "Could not update the RustDesk password: $applyResult"
            }
        }
    } catch {}
    if ($forceRequested) {
        Invoke-Checkin -Forced
    } else {
        # The common case - keeps Online/Offline, Issues, and Remote Access fresh at 20-minute
        # resolution instead of 6 hours, without resending the installed-software list (the one field
        # actually large enough to matter on a metered cellular SIM) more often than it needs to.
        Invoke-Checkin -Light
    }
}

if ($PollOnce) {
    Invoke-PollCycle
    exit
}

# The permanent, install-once replacement for the two Scheduled Tasks above: one process that stays
# resident for as long as the PC is on, doing exactly what they did (a light poll every
# $PollIntervalMinutes, a full heavy check-in roughly every 6 hours) from inside a single loop instead
# of two independent OS-level triggers. WinSW (see the install block above) launches this via
# "-Service" and restarts it automatically - on a crash, AND deliberately on every self-update (see
# the Service-aware branch in Invoke-SelfUpdate above) - so this PC never again needs anyone
# physically at it for a shell-level change: publishing a new version here is now the ONLY way this
# loop's own behavior ever changes.
#
# $lastHeavy lives only in memory, not on disk - a service restart (self-update or crash) simply
# resets its own 6-hour clock, which in the worst case means one heavy check-in arrives a little
# early. That's a negligible, self-correcting cost next to persisting and parsing a timestamp file on
# every single iteration for a savings that only ever matters in the same rare moment the process was
# about to restart anyway.
if ($Service) {
    Write-AgentLog "Service loop starting (PID $PID)."
    $lastHeavy = [datetime]::MinValue
    while ($true) {
        try {
            Invoke-SelfUpdate $PSBoundParameters
            if (((Get-Date) - $lastHeavy).TotalHours -ge 6) {
                Set-NotificationSuppressionPolicy
                Install-ChocolateyIfMissing
                Invoke-Checkin
                $lastHeavy = Get-Date
            } else {
                Invoke-PollCycle
            }
        } catch {
            # Deliberately swallowed rather than left to crash the process: WinSW's onfailure policy
            # would restart it anyway, but that would also reset every in-memory timer, so it's
            # strictly better to log, wait out this one cycle, and try again in place.
            Write-AgentLog "Service loop iteration failed (continuing): $($_.Exception.Message)"
        }
        Start-Sleep -Seconds ($PollIntervalMinutes * 60)
    }
}

# Flagless/-Once fall-through only (the -Service loop applies this itself on its own heavy branch,
# see Set-NotificationSuppressionPolicy's own header for why it can't just run once at install time).
Set-NotificationSuppressionPolicy

Invoke-Checkin
`;
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadWorkspaceDirectoryAgentScript() {
  const settings = STATE.pageData.settings?.data || {};
  const secret = settings.workspaceDirectoryAgent?.secret;
  if (!secret) { toast('Save a secret first', 'error'); return; }
  downloadTextFile(buildWorkspaceDirectoryAgentScript(secret, settings.workspaceDirectoryAgent?.uninstallPasswordHash), 'Install-JstarAgent.ps1');
}

// A single pasteable line for a remote/AnyDesk session, in place of pushing the .ps1 and .bat over
// separately and double-clicking the batch file - fetches the CURRENTLY PUBLISHED script from the
// same endpoint Invoke-SelfUpdate itself polls (workspace-directory-agent-shell, canary-aware by
// hostname), so this always installs whatever's live right now rather than a build that could have
// gone stale sitting on a USB stick or in Downloads.
//
// Saved to a temp FILE and run via -File rather than piped straight into iex - the installed script
// relocates itself on first run by copying $PSCommandPath to its protected install location (see
// that block's own comment), and $PSCommandPath is only ever populated when PowerShell is executing
// an actual file. Running the fetched text through iex/Invoke-Expression leaves $PSCommandPath
// empty, so that relocation step would silently no-op - not fail loudly, just skip - and every
// scheduled task registered afterward would point at a file that was never actually written,
// failing at the OS level with no explanation ever reaching Write-AgentLog.
//
// No explicit elevation here: the script re-launches itself with -Verb RunAs when it isn't already
// Administrator (see the self-elevation block near the top of buildWorkspaceDirectoryAgentScript),
// so requesting it a second time here would just mean two UAC prompts instead of one.
//
// Two things this line owns that the downloaded script itself can't: the SHELL RUNNING THIS LINE
// closing itself, and the child that actually runs the install never showing a window.
//   - Started life as a plain "powershell.exe -File $f" - a bare exe invocation like that always
//     allocates its OWN new console window (unlike Start-Process, it isn't told not to), so pasting
//     this into an interactive session showed a second, unwanted window. Start-Process ... -WindowStyle
//     Hidden fixes that the same way every automated spawn point in the installed agent itself already
//     does (see buildWorkspaceDirectoryAgentScript's own self-elevation block).
//   - The line finishing was never the same as the SHELL exiting - pasted into an interactive
//     PowerShell window, or run non-interactively from another tool that starts its own PowerShell
//     process to execute this line, the session it ran in stayed open at its prompt afterward
//     regardless, needing "exit" typed by hand. try/finally around the whole thing means that
//     "exit" now always runs - even if the fetch or the temp-file write fails - so a tool driving
//     this unattended (no one there to read an error or type exit) never gets left with a hung
//     process. A failed install is still fully explained - see JstarAgent-install-error.log - just
//     not by anything left on screen for nobody to read.
function buildWorkspaceDirectoryOneLinerInstallCommand(secret) {
  const agentShellUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-agent-shell`;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return `try { $r = Invoke-RestMethod -Uri "${agentShellUrl}?hostname=$env:COMPUTERNAME" -Headers @{ 'x-agent-secret' = '${secret}'; 'apikey' = '${anonKey}' }; $f = Join-Path $env:TEMP 'Install-JstarAgent.ps1'; Set-Content -Path $f -Value $r.script -Encoding utf8 -NoNewline; Start-Process powershell.exe -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$f\`"" -WindowStyle Hidden } finally { exit }`;
}

export function copyWorkspaceDirectoryInstallCommand() {
  const settings = STATE.pageData.settings?.data || {};
  const secret = settings.workspaceDirectoryAgent?.secret;
  if (!secret) { toast('Save a secret first', 'error'); return; }
  navigator.clipboard?.writeText(buildWorkspaceDirectoryOneLinerInstallCommand(secret))
    .then(() => toast('Install command copied - paste into PowerShell on the target PC'))
    .catch(() => toast('Could not copy to clipboard', 'error'));
}

// PowerShell's own -EncodedCommand switch expects UTF-16LE bytes, base64'd - not UTF-8. JS strings
// are already UTF-16 internally, so charCodeAt(i) already gives the right 16-bit code unit; this
// just splits each one into its two little-endian bytes rather than re-encoding through UTF-8 (the
// wrong encoding entirely - powershell.exe would reject it as malformed rather than silently
// misreading it, since it checks for the UTF-16 byte-order pattern before decoding).
function toPowerShellEncodedCommand(text) {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Same install, opaque instead of readable - a bystander glancing at the screen (or at whatever
// tool is holding this string to run it remotely) sees base64 noise, not a URL/secret/"Jstar
// Agent" they could recognize or copy. NOT security through obscurity against anything that
// matters: the decoded command is still exactly what Task Manager's command-line column, Sysmon,
// PowerShell Script Block Logging, or anyone who pastes the base64 into
// [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($s)) already sees - this hides
// nothing from the OS, from EDR, or from an admin who wants to look. It only removes what a person
// eyeballing the raw text on screen would otherwise read at a glance.
//
// First version of this wrapped the whole thing as a fresh "powershell -WindowStyle Hidden
// -EncodedCommand ..." invocation - correct ONLY if whatever runs this text spawns a brand new
// process with it as that process's own command line. Confirmed live on DESKTOP-8792C9C that isn't
// what actually happens: this is pasted/typed into an ALREADY-OPEN, already-visible PowerShell
// window, the same way the readable command always was. In that shape, "powershell ... -EncodedCommand"
// just spawns a SECOND, hidden CHILD process to do the work - the -WindowStyle Hidden and the
// try/finally { exit } inside it only ever applied to that invisible child. The window actually
// on screen is the PARENT that ran this line, which nothing inside a child it spawned can hide or
// close after the fact - same root cause as the very first "need to type exit" report, just
// reintroduced by wrapping in a second process instead of running in place.
//
// iex (Invoke-Expression) fixes that by never spawning anything for the wrapper itself - it decodes
// and runs the exact same plaintext buildWorkspaceDirectoryOneLinerInstallCommand produces (reused
// verbatim, not a second copy of this logic to keep in sync) IN WHATEVER SHELL THIS TEXT IS ACTUALLY
// EXECUTED IN, so that shell's own "exit" - already proven to work for the readable command - closes
// the real, visible window this time instead of a hidden child's window nobody could see anyway.
// Safe to iex here specifically because the decoded text is this small wrapper, not the multi-
// thousand-line AGENT SCRIPT ITSELF - that one still has to run via "& $f" against a real file (see
// buildWorkspaceDirectoryOneLinerInstallCommand's own comment on why: $PSCommandPath, needed for the
// agent's self-relocation step, is only ever populated when PowerShell executes an actual FILE).
function buildWorkspaceDirectoryOneLinerEncodedInstallCommand(secret) {
  const plain = buildWorkspaceDirectoryOneLinerInstallCommand(secret);
  return `iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${toPowerShellEncodedCommand(plain)}')))`;
}

export function copyWorkspaceDirectoryEncodedInstallCommand() {
  const settings = STATE.pageData.settings?.data || {};
  const secret = settings.workspaceDirectoryAgent?.secret;
  if (!secret) { toast('Save a secret first', 'error'); return; }
  navigator.clipboard?.writeText(buildWorkspaceDirectoryOneLinerEncodedInstallCommand(secret))
    .then(() => toast('Encoded install command copied - opaque to read, identical install underneath.'))
    .catch(() => toast('Could not copy to clipboard', 'error'));
}

// Plain double-clickable launcher, same idea as the reference Jstar agent's own .cmd wrapper -
// double-clicking a .ps1 directly just opens it in Notepad (Windows' safety default), so this is
// the intended way to actually run the install. Requests elevation itself (the .ps1 also
// self-elevates, but starting elevated avoids two separate UAC prompts). Closes itself
// automatically on success - the install is fully silent otherwise (no tray icon or confirmation
// UI, by design) - and only pauses if the install itself failed, so an error stays visible instead
// of the window vanishing before anyone can read it.
function buildAgentBatchLauncher() {
  return `@echo off
setlocal

NET SESSION >NUL 2>&1
IF %ERRORLEVEL% NEQ 0 (
    ECHO Requesting Administrator privileges...
    GOTO :ADMIN_ELEVATION
)

ECHO Launching Jstar Agent installation...
ECHO.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-JstarAgent.ps1"
IF %ERRORLEVEL% NEQ 0 (
    ECHO.
    ECHO Installation failed - see the error above.
    ECHO Please press any key to close this window...
    pause >NUL
)

GOTO :EOF

:ADMIN_ELEVATION
    set "batchPath=%~dp0%~nx0"
    ECHO Set UAC = CreateObject^("Shell.Application"^) > "%TEMP%\\elevate.vbs"
    ECHO UAC.ShellExecute "%batchPath%", "", "","runas", 1 >> "%TEMP%\\elevate.vbs"
    "%TEMP%\\elevate.vbs"
    exit /b
`;
}

export function downloadWorkspaceDirectoryAgentBatch() {
  downloadTextFile(buildAgentBatchLauncher(), 'Install-JstarAgent.bat');
}

// Runs the SAME installed Install-JstarAgent.ps1 (must already be in this folder from
// the install above) with -Uninstall instead of a separate script - the .ps1 itself prompts for
// the Client Uninstall Password and does the actual removal (see the $Uninstall block in
// buildWorkspaceDirectoryAgentScript above); this .bat is just the same double-clickable/elevated
// entry point as the installer, pointed at the other switch. Stays open on failure (wrong
// password, none set yet) same as the install launcher, so the reason is visible.
function buildAgentUninstallBatchLauncher() {
  return `@echo off
setlocal

NET SESSION >NUL 2>&1
IF %ERRORLEVEL% NEQ 0 (
    ECHO Requesting Administrator privileges...
    GOTO :ADMIN_ELEVATION
)

ECHO Uninstalling the Jstar Agent from this PC...
ECHO You will be asked for the Client Uninstall Password.
ECHO.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-JstarAgent.ps1" -Uninstall
IF %ERRORLEVEL% NEQ 0 (
    ECHO.
    ECHO Uninstall failed or was cancelled - see the error above.
)
ECHO Please press any key to close this window...
pause >NUL

GOTO :EOF

:ADMIN_ELEVATION
    set "batchPath=%~dp0%~nx0"
    ECHO Set UAC = CreateObject^("Shell.Application"^) > "%TEMP%\\elevate.vbs"
    ECHO UAC.ShellExecute "%batchPath%", "", "","runas", 1 >> "%TEMP%\\elevate.vbs"
    "%TEMP%\\elevate.vbs"
    exit /b
`;
}

export function downloadWorkspaceDirectoryAgentUninstallBatch() {
  downloadTextFile(buildAgentUninstallBatchLauncher(), 'Uninstall-JstarAgent.bat');
}

function renderAssetInventoryApiCard(settings) {
  const cfg = settings.assetInventoryApi || {};
  const testing = STATE.testing_assetInventoryApi;
  return `
    <div class="card">
      <div class="card-head"><h3>Asset Inventory API Sync</h3><div class="desc">Generic JSON API puller - point it at any system and map its fields to our columns. Supports either OAuth2 client-credentials (Client ID/Secret below) or a single static auth header. For a one-off import instead, use the Bulk Import button on the Asset Inventory page.</div></div>
      <form onsubmit="App.saveAssetInventoryApiForm(event)">
        <div class="field"><label>Base URL</label><input id="int-ai-baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="https://api.example.com/v1"></div>
        <div class="grid2">
          <div class="field"><label>Data Path (optional)</label><input id="int-ai-dataPath" value="${esc(cfg.dataPath || '')}" placeholder="/inventory/assets"></div>
          <div class="field"><label>OAuth Token Path (optional)</label><input id="int-ai-tokenPath" value="${esc(cfg.tokenPath || '')}" placeholder="/identity/oauth2"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>OAuth2 Client ID (optional)</label><input id="int-ai-clientId" value="${esc(cfg.clientId || '')}" placeholder="client_id"></div>
          <div class="field"><label>OAuth2 Client Secret (optional)</label><input id="int-ai-clientSecret" type="password" value="${esc(cfg.clientSecret || '')}" placeholder="client_secret"></div>
        </div>
        <div class="small muted" style="margin:-6px 0 10px;">Auth Header fields below are only used when Client ID/Secret above are empty.</div>
        <div class="grid2">
          <div class="field"><label>Auth Header Name (optional)</label><input id="int-ai-authHeaderName" value="${esc(cfg.authHeaderName || '')}" placeholder="Authorization"></div>
          <div class="field"><label>Auth Header Value (optional)</label><input id="int-ai-authHeaderValue" type="password" value="${esc(cfg.authHeaderValue || '')}" placeholder="Bearer ..."></div>
        </div>
        <div class="small muted" style="margin:-6px 0 6px;">Join endpoints (optional) - only fetched when Field Mapping below references them (see "_venue."/"_location."/"_network." below). Leave blank to use each one's default path.</div>
        <div class="grid2">
          <div class="field"><label>Venues Path (optional)</label><input id="int-ai-venuesPath" value="${esc(cfg.venuesPath || '')}" placeholder="/inventory/venues"></div>
          <div class="field"><label>Locations Path (optional)</label><input id="int-ai-locationsPath" value="${esc(cfg.locationsPath || '')}" placeholder="/inventory/locations"></div>
        </div>
        <div class="field"><label>Networks Path (optional)</label><input id="int-ai-networksPath" value="${esc(cfg.networksPath || '')}" placeholder="/inventory/networks"></div>
        <div class="field"><label>Field Mapping (JSON: our column -&gt; source field path)</label>
          <textarea id="int-ai-fieldMapping" rows="4" style="font-family:monospace;font-size:12px;">${esc(JSON.stringify(cfg.fieldMapping || { source_asset_id: 'id', name: 'name', venue: 'venue', location: 'location', category: 'category' }, null, 2))}</textarea>
          <div class="small muted" style="margin-top:4px;">If an asset carries a venue_id/location_id FK instead of a name, map e.g. <code>"venue": "_venue.name"</code> and this pulls the Venues Path above to resolve it. Networks are many-to-many, not a plain column - if the source embeds them directly on the asset (e.g. <code>"networks": [{"id":17,"name":"Retail NW (A) FMCG"}, ...]</code>), just map <code>"networks": "networks"</code> and the name(s) are extracted automatically, no Networks Path needed. Only use <code>"networks": "_network.name"</code> (single network_id FK) or <code>"networks": "_networks"</code> (a network_ids array) if the source instead makes you resolve networks via a separate list at the Networks Path above.</div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="int-ai-enabled" style="width:auto;" ${cfg.enabled ? 'checked' : ''}> Enabled</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${testing ? 'disabled' : ''} onclick="App.testIntegration('asset-inventory-sync','assetInventoryApi')">${testing ? 'Testing...' : 'Test / Sync Now'}</button>
          ${cfg.lastSync ? `<span class="small muted">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
        </div>
        ${cfg.lastSyncSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSyncSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
      </form>
    </div>
  `;
}

export async function saveAssetInventoryApiForm(event) {
  event.preventDefault();
  const settings = STATE.pageData.settings?.data || {};
  const cfg = { ...(settings.assetInventoryApi || {}) };
  cfg.baseUrl = document.getElementById('int-ai-baseUrl').value.trim();
  cfg.dataPath = document.getElementById('int-ai-dataPath').value.trim();
  cfg.tokenPath = document.getElementById('int-ai-tokenPath').value.trim();
  cfg.clientId = document.getElementById('int-ai-clientId').value.trim();
  cfg.clientSecret = document.getElementById('int-ai-clientSecret').value.trim();
  cfg.authHeaderName = document.getElementById('int-ai-authHeaderName').value.trim();
  cfg.authHeaderValue = document.getElementById('int-ai-authHeaderValue').value.trim();
  cfg.venuesPath = document.getElementById('int-ai-venuesPath').value.trim();
  cfg.locationsPath = document.getElementById('int-ai-locationsPath').value.trim();
  cfg.networksPath = document.getElementById('int-ai-networksPath').value.trim();
  cfg.enabled = document.getElementById('int-ai-enabled').checked;
  try {
    cfg.fieldMapping = JSON.parse(document.getElementById('int-ai-fieldMapping').value || '{}');
  } catch (e) {
    toast('Field Mapping must be valid JSON', 'error');
    return;
  }
  try {
    await saveSetting('assetInventoryApi', cfg);
    await logAudit('Save integration settings', 'assetInventoryApi');
    invalidate('settings');
    toast('Settings saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Brand logos (venue/contractor/campaign-client avatars) via Brandfetch's Search API - see
// supabase/functions/brandfetch-lookup. The API key is entered here (masked, admin-only) and
// never reaches the browser; lookups run server-side and cache into brand_logos, which
// src/lib/brandLogo.js reads from on Locations/Contractors/Asset Inventory/Campaigns.
function renderBrandfetchCard(settings) {
  const cfg = settings.brandfetch || {};
  const fetching = STATE.fetching_brandfetch;
  const overridesText = Object.entries(cfg.domainOverrides || {}).map(([name, domain]) => `${name} = ${domain}`).join('\n');
  return `
    <div class="card">
      <div class="card-head"><h3>Brandfetch (Brand Logos)</h3><div class="desc">Looks up a brand logo per venue/contractor/campaign-client name and caches it. Free tier is capped at 100 requests/month, so use "Fetch Missing Logos" rather than fetching live on every page load. The weekly automatic run covers Locations/Contractors/Campaigns only; "Fetch Missing Logos" below also pulls this month's Traffic Sheet venues (only when that integration is enabled).</div></div>
      <form onsubmit="App.saveBrandfetchForm(event)">
        <div class="field"><label>API Key</label><input id="int-brandfetch-apiKey" type="password" value="${esc(cfg.apiKey || '')}" placeholder="Brandfetch Client ID / API Key"></div>
        <div class="field"><label>Domain Overrides</label>
          <textarea id="int-brandfetch-domainOverrides" rows="10" style="min-height:200px;font-family:monospace;" placeholder="AL HAMRA MALL = alhamra.ae">${esc(overridesText)}</textarea>
          <div class="small muted" style="margin-top:4px;">One per line, "Name = domain.com". For names the search-based lookup can't confidently match (e.g. a generic mall name) - resolves the logo directly from the domain instead, via Brandfetch's Logo Link (doesn't use search quota).</div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-bottom:10px;"><input type="checkbox" id="int-brandfetch-enabled" style="width:auto;" ${cfg.enabled ? 'checked' : ''}> Enabled</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${fetching ? 'disabled' : ''} onclick="App.runBrandfetchFetchMissing()">${fetching ? 'Fetching...' : 'Fetch Missing Logos'}</button>
          ${cfg.lastRun ? `<span class="small muted">Last run: ${esc(cfg.lastRun)}</span>` : ''}
        </div>
        ${cfg.lastSummary ? `<p class="small muted" style="margin-top:6px;">${esc(cfg.lastSummary)}</p>` : ''}
        ${cfg.lastError ? `<div class="login-error" style="margin-top:6px;">${esc(cfg.lastError)}</div>` : ''}
      </form>
    </div>
  `;
}

export async function saveBrandfetchForm(event) {
  event.preventDefault();
  const settings = STATE.pageData.settings?.data || {};
  const cfg = { ...(settings.brandfetch || {}) };
  cfg.apiKey = document.getElementById('int-brandfetch-apiKey').value.trim();
  cfg.enabled = document.getElementById('int-brandfetch-enabled').checked;
  const overridesText = document.getElementById('int-brandfetch-domainOverrides').value;
  const domainOverrides = {};
  overridesText.split('\n').forEach((line) => {
    const [name, domain] = line.split('=').map((s) => s && s.trim());
    if (name && domain) domainOverrides[name] = domain;
  });
  cfg.domainOverrides = domainOverrides;
  try {
    await saveSetting('brandfetch', cfg);
    await logAudit('Save integration settings', 'brandfetch');
    invalidate('settings');
    toast('Settings saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Admin-managed venue-name merges for Traffic Sheet (see venueAliasMap()/mergeVenueName() in
// trafficSheet.js) - lets an admin fix a typo/spelling variant splitting one real location into
// several rows in the Summary table, Location dropdown, and every export, without needing a code
// change each time one turns up. Same shape and UI pattern as Brandfetch's Domain Overrides above
// (a plain "raw = canonical" textarea, one merge per line) - stored as its own app_settings row
// rather than nested under trafficSheetApi/brandfetch, since it's a data-normalization concern
// independent of either integration's own connection config.
function renderVenueAliasesCard(settings) {
  const aliases = settings.venueAliases || {};
  const aliasesText = Object.entries(aliases).map(([from, to]) => `${from} = ${to}`).join('\n');
  return `
    <div class="card">
      <div class="card-head"><h3>Traffic Sheet Venue Aliases</h3><div class="desc">Merges venue-name typos/spelling variants from the Traffic Sheet source data into one location - e.g. a stray extra space or misspelling that's currently showing up as its own separate row in the Summary table.</div></div>
      <form onsubmit="App.saveVenueAliasesForm(event)">
        <div class="field"><label>Merges</label>
          <textarea id="int-venue-aliases" rows="8" style="min-height:160px;font-family:monospace;" placeholder="AJMAN CITY CENTRE TYPO = Ajman City Centre">${esc(aliasesText)}</textarea>
          <div class="small muted" style="margin-top:4px;">One per line, "Raw name from Traffic Sheet = Canonical name to display". The raw name only needs to match on spelling/spacing/case - not case-sensitive.</div>
        </div>
        <button class="btn btn-orange" type="submit">Save</button>
      </form>
    </div>
  `;
}

export async function saveVenueAliasesForm(event) {
  event.preventDefault();
  const text = document.getElementById('int-venue-aliases').value;
  const aliases = {};
  text.split('\n').forEach((line) => {
    const [from, to] = line.split('=').map((s) => s && s.trim());
    if (from && to) aliases[from] = to;
  });
  try {
    await saveSetting('venueAliases', aliases);
    await logAudit('Save venue aliases', `${Object.keys(aliases).length} merge(s)`);
    invalidate('settings');
    invalidate('venueAliases');
    toast('Venue aliases saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Branding text for the Reporting workspace's per-campaign download (Excel + PDF) - lives here
// instead of hardcoded in lib/pdfReport.js/excelExport.js so a phone number, address, or tagline
// change is a Settings edit, not a code change/redeploy. reporting.js falls back to these exact
// defaults if the row hasn't been saved yet, so an unconfigured template still looks right.
export const REPORT_TEMPLATE_DEFAULTS = {
  companyName: 'Hypermedia',
  tagline: 'Creators of Impact',
  contactLine: 'Toll-Free +971 4 800 4600  |  info@hypermedia.ae  |  www.hypermedia.ae',
  addressLine1: 'Dubai HQ: Galadari Bldg, 2nd Floor, Dubai Internet City, P.O. Box 502021, Dubai, UAE',
  addressLine2: 'Abu Dhabi: Yas Mall, Cloudspaces, Level 1, Near Apple Store',
};

function renderReportTemplateCard(settings) {
  const t = { ...REPORT_TEMPLATE_DEFAULTS, ...(settings.reportTemplate || {}) };
  return `
    <div class="card">
      <div class="card-head"><h3>Campaign Report Template</h3><div class="desc">Branding text used on every Reporting workspace campaign download (Excel + PDF) - edit this instead of asking for a code change when a phone number, address or tagline changes.</div></div>
      <form onsubmit="App.saveReportTemplateForm(event)">
        <div class="field"><label>Company Name</label><input id="rt-company" value="${esc(t.companyName)}"></div>
        <div class="field"><label>Tagline</label><input id="rt-tagline" value="${esc(t.tagline)}"></div>
        <div class="field"><label>Contact Line</label><input id="rt-contact" value="${esc(t.contactLine)}"></div>
        <div class="field"><label>Address Line 1</label><input id="rt-address1" value="${esc(t.addressLine1)}"></div>
        <div class="field"><label>Address Line 2</label><input id="rt-address2" value="${esc(t.addressLine2)}"></div>
        <button class="btn btn-orange" type="submit">Save</button>
      </form>
    </div>
  `;
}

export async function saveReportTemplateForm(event) {
  event.preventDefault();
  const template = {
    companyName: document.getElementById('rt-company').value.trim() || REPORT_TEMPLATE_DEFAULTS.companyName,
    tagline: document.getElementById('rt-tagline').value.trim(),
    contactLine: document.getElementById('rt-contact').value.trim(),
    addressLine1: document.getElementById('rt-address1').value.trim(),
    addressLine2: document.getElementById('rt-address2').value.trim(),
  };
  try {
    await saveSetting('reportTemplate', template);
    await logAudit('Save campaign report template', template.companyName);
    invalidate('settings');
    invalidate('reportTemplate');
    toast('Report template saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Gathers distinct brand-lookup-worthy names across the 5 places logos are shown (venues,
// contractors, campaign clients, Traffic Sheet venues - Asset Inventory reuses venue names so
// isn't a separate source) PLUS every name in Domain Overrides, skips ones already cached (found
// or a recorded miss) UNLESS an override now points at a different domain than what's cached, and
// looks up the rest in one batch. BRANDFETCH_BATCH_CAP only throttles names that need a real
// Brandfetch Search call (protects the free-tier monthly quota) - Domain Overrides never call
// Search at all (the edge function resolves straight from the configured domain to an image), so
// every override name due for a fetch goes through uncapped, no matter how many there are.
//
// Domain Overrides used to only ever get looked up if the exact same name also happened to be a
// "live" candidate this run (e.g. a venue with a campaign booked this month) - an override typed
// for anything else (a past month's venue, a name that doesn't independently occur anywhere) was
// silently never fetched, and even a live match got skipped forever once any cached row (even a
// stale miss from before the override existed) was on file for that name. See runBrandfetchFetchMissing().
//
// Traffic Sheet venue names come from a live external API, not one of our own tables, so they
// were previously never in this gather at all - a real Traffic Sheet page could have 150+ distinct
// venues in a single month, so this only pulls the current month (not every month ever) to keep
// the candidate list bounded, and only when the integration is actually configured/enabled.
//
// Uses brandNameForVenue() (not the raw venue name) - a first pass that gathered raw names found
// that Brandfetch's Search API fuzzy-matches venue/street/station names to unrelated companies
// far too often (real examples: "LULU" matched lululemon.com, "Energy" matched the US Department
// of Energy, "Stadium" matched a Swedish sports retailer) - brandNameForVenue reduces multi-branch
// chains to one lookup and skips Royals/Gems entirely (no real external brand exists for those).
// Metro/Bridges stations are gated behind isBrandedMetroStation() - only the small curated list of
// CONFIRMED real sponsor-branded stations ("Danube", "Equiti", "OnPassive", ...) ever gets proposed
// for a Search lookup; every other station name (the vast majority - plain Dubai area names like
// "Al Jadaf"/"Business Bay"/"Energy") is skipped entirely, since a real run confirmed Search
// fuzzy-matches those to an unrelated company 100% of the time rather than admitting no match. The
// shared "Dubai Metro Rail" fallback brand (see brandFallbackForVenue) is always added regardless,
// so it stays cached and covers every non-branded station via brandLogoTag's fallback arg. Same
// function Traffic Sheet's own display uses, so the cache key here always matches the lookup key
// there.
const BRANDFETCH_BATCH_CAP = 25;

async function gatherTrafficSheetVenueNames(settings) {
  const cfg = settings.trafficSheetApi || {};
  if (!cfg.enabled || !cfg.apiKey) return [];
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { data, error } = await supabase.functions.invoke('traffic-sheet-proxy', { body: { startMonth: month, endMonth: month } });
    if (error || data?.error) return [];
    const names = new Set();
    (data.campaigns || []).forEach((c) => (c.venues || []).forEach((v) => {
      const fb = brandFallbackForVenue(v);
      const n = brandNameForVenue(v);
      if (n && (!fb || isBrandedMetroStation(v))) names.add(n.trim());
      if (fb) names.add(fb.trim());
    }));
    return [...names];
  } catch (e) {
    return [];
  }
}

export async function runBrandfetchFetchMissing() {
  setState({ fetching_brandfetch: true });
  try {
    const [locations, contractors, campaigns, cached, settings] = await Promise.all([
      listLocations(), listContractors(), listCampaigns(), listBrandLogos(), getAllSettings(),
    ]);
    const cachedByName = new Map(cached.map((r) => [r.name.toLowerCase(), r]));
    const domainOverrides = settings.brandfetch?.domainOverrides || {};
    // Lowercased for matching (admin-typed casing doesn't have to exactly match whatever casing
    // the venue/location/contractor data happens to use), original-cased for the actual lookup
    // name (must match what brandLogoTag/brandNameForVenue produce elsewhere).
    const overrideDomainByLowerName = new Map(
      Object.entries(domainOverrides).map(([n, d]) => [n.trim().toLowerCase(), d])
    );

    const candidateNames = new Set();
    // Domain Overrides go in first - an explicit override typed by the admin is a deliberate
    // instruction and previously never even entered this candidate list unless the exact same
    // name also happened to come from a location/contractor/campaign/Traffic Sheet venue this
    // month - e.g. an override for a station that isn't running any campaign right now was
    // silently ignored. Listing them first also means they win the BRANDFETCH_BATCH_CAP slice
    // over lower-priority candidates when there's a lot to fetch in one click.
    Object.keys(domainOverrides).forEach((n) => { const t = n.trim(); if (t) candidateNames.add(t); });
    locations.forEach((l) => { const n = brandNameForLocation(l); if (n) candidateNames.add(n.trim()); });
    contractors.forEach((c) => (c.company || c.name) && candidateNames.add((c.company || c.name).trim()));
    campaigns.forEach((c) => c.client && candidateNames.add(c.client.trim()));
    (await gatherTrafficSheetVenueNames(settings)).forEach((n) => candidateNames.add(n));

    // A name with no override: skip once cached (found or a recorded miss), same as before. A
    // name WITH an override: skip only once the cached row's domain already matches the override
    // - so a brand-new override, or one whose domain was just edited, always gets (re-)applied
    // even though that exact name already has a (now-stale) cached row from before the override
    // existed or from a different domain.
    const missing = [...candidateNames].filter((n) => {
      if (!n) return false;
      const cachedRow = cachedByName.get(n.toLowerCase());
      const overrideDomain = overrideDomainByLowerName.get(n.toLowerCase());
      if (!cachedRow) return true;
      if (overrideDomain) return (cachedRow.domain || '').toLowerCase() !== overrideDomain.trim().toLowerCase();
      return false;
    });
    if (!missing.length) {
      toast('No new brand names to look up - everything already cached.');
      return;
    }
    // BRANDFETCH_BATCH_CAP exists to protect Brandfetch's own monthly Search quota - it doesn't
    // apply to Domain Overrides at all, since those never call Search (the edge function goes
    // straight from the configured domain to an image, see storeLogoImage). So every override name
    // still due for a (re-)fetch goes through in one click regardless of count; only the
    // non-override names competing for real Search quota get capped.
    const overrideMissing = missing.filter((n) => overrideDomainByLowerName.has(n.toLowerCase()));
    const searchMissing = missing.filter((n) => !overrideDomainByLowerName.has(n.toLowerCase()));
    const batch = [...overrideMissing, ...searchMissing.slice(0, BRANDFETCH_BATCH_CAP)];
    const result = await lookupBrandLogos(batch);
    await logAudit('Fetch brand logos', result.summary);
    invalidate('settings');
    invalidate('brandLogos');
    toast(`${result.summary}${missing.length > batch.length ? ` (${missing.length - batch.length} more left - click again to continue)` : ''}`);
    setState({});
  } catch (e) {
    toast(e.message || 'Brand logo fetch failed', 'error');
  } finally {
    setState({ fetching_brandfetch: false });
  }
}

// Mirrors STALE_AFTER_MINUTES in workspaceDirectory.js / workspace-directory-alert-scan exactly -
// duplicated rather than imported/shared, same call the edge function itself already made (see its
// own matching comment), since a small local constant costs nothing and this only needs the
// number, not any of the rest of that module's device-page state.
const STATUS_SUMMARY_STALE_MINUTES = 30;

// Builds a snapshot of CURRENT status (not a diff against last time, unlike the automatic alerts -
// see workspace-directory-alert-scan) for the "Send Status Summary Now" button. Queried directly
// here rather than through locationStats.js's chain/member-aware helpers (effectiveLocations etc.)
// - those exist to fold a chain's member locations into one card on the Locations page, which is
// more machinery than a flat fleet-wide count needs; this instead mirrors the alert-scan edge
// function's own simpler direct-query approach, since the two are doing the same kind of tally.
async function buildStatusSummaryText() {
  const [{ data: devices, error: devicesErr }, { data: offlineScreens, error: screensErr }, { data: openReports, error: reportsErr }] = await Promise.all([
    supabase.from('workspace_devices').select('last_seen, problems').is('removed_at', null),
    supabase.from('location_sub_assets').select('source, location_id').eq('status', 'Offline').in('source', ['broadsign', 'grassfish']).not('location_id', 'is', null),
    supabase.from('screen_reports').select('id').eq('status', 'New'),
  ]);
  if (devicesErr) throw devicesErr;
  if (screensErr) throw screensErr;
  if (reportsErr) throw reportsErr;

  const staleMs = STATUS_SUMMARY_STALE_MINUTES * 60 * 1000;
  const now = Date.now();
  let onlineCount = 0;
  let offlineCount = 0;
  let problemCount = 0;
  for (const d of devices || []) {
    const isOffline = !d.last_seen || (now - new Date(d.last_seen).getTime()) > staleMs;
    if (isOffline) offlineCount++; else onlineCount++;
    if (Array.isArray(d.problems) && d.problems.length) problemCount++;
  }

  const locIds = [...new Set((offlineScreens || []).map((s) => s.location_id))];
  let locNames = [];
  if (locIds.length) {
    const { data: locRows } = await supabase.from('locations').select('id, name').in('id', locIds);
    locNames = [...new Set((locRows || []).map((l) => l.name))].sort();
  }
  const MAX_NAMES = 10;
  const shownNames = locNames.slice(0, MAX_NAMES).join(', ');
  const moreNames = locNames.length > MAX_NAMES ? ` +${locNames.length - MAX_NAMES} more` : '';

  const lines = [
    `:bar_chart: *Status Summary* (on-demand, ${fmtDateTime()})`,
    `• Digital Directory: ${onlineCount} online, ${offlineCount} offline${problemCount ? `, ${problemCount} with an open issue` : ''}`,
    (offlineScreens || []).length
      ? `• Broadsign/Grassfish screens offline: ${offlineScreens.length} across ${locNames.length} location(s): ${shownNames}${moreNames}`
      : `• Broadsign/Grassfish screens offline: 0`,
    `• Open Screen Reports: ${(openReports || []).length}`,
  ];
  return lines.join('\n');
}

export async function sendWorkspaceStatusSummaryToSlack() {
  setState({ sendingStatusSummary: true });
  try {
    const text = await buildStatusSummaryText();
    await notifySlack(text);
    await logAudit('Send Slack status summary', text.replace(/\n/g, ' | '));
    toast('Status summary sent to Slack.');
  } catch (e) {
    toast(e.message || 'Failed to send status summary', 'error');
  } finally {
    setState({ sendingStatusSummary: false });
  }
}

export async function testIntegration(functionName, settingKey) {
  setState({ [`testing_${settingKey}`]: true });
  try {
    const { data, error } = await supabase.functions.invoke(functionName, { body: {} });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    await logAudit(`Test ${functionName}`, data?.summary || '');
    invalidate('settings');
    toast(data?.summary || 'Test succeeded');
  } catch (e) {
    toast(e.message || 'Test failed', 'error');
  } finally {
    setState({ [`testing_${settingKey}`]: false });
  }
}

function renderIntegrationsTab() {
  const settings = loadData('settings', getAllSettings);
  if (settings === null) return loadingCard();
  if (settings?.__error) return loadingCard(settings.__error);

  return `
    <div class="banner">API keys here are stored server-side and only readable by admins. Live syncs against Broadsign/Grassfish run through Edge Functions, never directly from the browser.</div>
    ${renderBroadsignApiCard(settings)}
    ${renderGrassfishApiCard(settings)}
    ${renderIotApiCard(settings)}
    ${renderWorkspaceDirectoryAgentCard(settings)}
    ${renderAssetInventoryApiCard(settings)}
    ${renderBrandfetchCard(settings)}
    ${integrationField(settings, 'trafficSheetApi', 'Traffic Sheet API (AdLive Center)', [
      { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'traffic-sheet-proxy')}
    ${renderVenueAliasesCard(settings)}
    ${integrationField(settings, 'reportingApi', 'Reporting API (AiOO)', [
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'aioo-reporting-proxy')}
    ${renderReportTemplateCard(settings)}
    ${integrationField(settings, 'slackNotify', 'Slack Notifications', [
      { name: 'webhookUrl', label: 'Incoming Webhook URL', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'slack-notify')}
    ${settings.slackNotify?.enabled && settings.slackNotify?.webhookUrl ? `
    <div class="card">
      <div class="card-head"><h3>Slack Status Summary</h3><div class="desc">The automatic alerts above only fire on a CHANGE (something going offline, a new issue) - this instead posts a one-off snapshot of current status, whenever you click it. Good for a shift handover or just checking in on the channel without opening the dashboard.</div></div>
      <button type="button" class="btn btn-orange btn-sm" ${STATE.sendingStatusSummary ? 'disabled' : ''} onclick="App.sendWorkspaceStatusSummaryToSlack()">${STATE.sendingStatusSummary ? 'Sending...' : 'Send Status Summary Now'}</button>
    </div>` : ''}
    ${integrationField(settings, 'sendgridEmail', 'SendGrid Email', [
      { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'fromEmail', label: 'From Email (must be a Verified Sender in SendGrid)', type: 'email' },
      { name: 'fromName', label: 'From Name (optional)' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'sendgrid-send')}
    ${integrationField(settings, 'campaignFeed', 'Campaign Sheet Feed', [
      { name: 'sheetUrl', label: 'Published Sheet CSV URL' }, { name: 'autoRefreshMinutes', label: 'Auto-refresh (minutes)', type: 'number' },
    ])}
    ${integrationField(settings, 'whatsappFeed', 'WhatsApp Ticket Feed', [
      { name: 'feedUrl', label: 'Feed URL' }, { name: 'autoRefreshMinutes', label: 'Auto-refresh (minutes)', type: 'number' },
    ])}
    ${integrationField(settings, 'closingRelay', 'Contractor Closing Relay', [
      { name: 'webhookUrl', label: 'Webhook URL' }, { name: 'pullUrl', label: 'Pull URL' },
    ])}
    <div class="card">
      <div class="card-head"><h3>Ticket Notifications</h3></div>
      <form onsubmit="App.saveTicketNotifyEmail(event)">
        <div class="field"><label>Notify Email</label><input id="int-ticket-email" type="email" value="${esc(typeof settings.ticketNotifyEmail === 'string' ? settings.ticketNotifyEmail : '')}"></div>
        <button class="btn btn-orange" type="submit">Save</button>
      </form>
    </div>
  `;
}

export async function saveIntegrationForm(event, key) {
  event.preventDefault();
  const settings = STATE.pageData.settings?.data || {};
  const cfg = { ...(settings[key] || {}) };
  document.querySelectorAll(`[id^="int-${key}-"]`).forEach((el) => {
    const field = el.id.replace(`int-${key}-`, '');
    cfg[field] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value || 0) : el.value);
  });
  try {
    await saveSetting(key, cfg);
    await logAudit('Save integration settings', key);
    invalidate('settings');
    toast('Settings saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveTicketNotifyEmail(event) {
  event.preventDefault();
  const email = document.getElementById('int-ticket-email').value.trim();
  try {
    await saveSetting('ticketNotifyEmail', email);
    await logAudit('Save ticket notify email', email);
    invalidate('settings');
    toast('Saved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}
