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
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';
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
  const shell = settings.workspaceDirectoryAgentShell || {};
  return `
    <div class="card">
      <div class="card-head"><h3>Jstar Agent</h3><div class="desc">Our own lightweight PC inventory agent (hostname, IP, AnyDesk/TeamViewer ID, Broadsign Player ID/Grassfish Box ID, OS, logged-in user, disk volumes, hardware, antivirus status, installed software, detected problems). The Broadsign/Grassfish ID matches this PC to the same screen in those Consoles (by Player Box ID, same as those syncs already use), so each side can link to the other's AnyDesk/TeamViewer or screen info. Fully headless by design - no tray icon, window, or notification ever appears, since these PCs drive signage screens. Generate a secret, save, then run the .bat as Administrator on each PC once (double-clicking the .ps1 directly just opens it in Notepad - Windows' default for script files). After that one install, every agent self-updates from Published Agent Version below - PCs in remote locations never need a physical reinstall again for anything except a secret rotation.</div></div>
      <form onsubmit="App.saveWorkspaceDirectoryAgentForm(event)">
        <div class="field"><label>Shared Agent Secret</label>
          <div style="display:flex;gap:8px;">
            <input id="int-wda-secret" type="password" autocomplete="off" value="${esc(cfg.secret || '')}" style="flex:1;">
            <button type="button" class="btn-outline btn-sm" onclick="App.generateWorkspaceDirectorySecret()">Generate</button>
          </div>
          <div class="small muted" style="margin-top:4px;">Every agent sends this in an x-agent-secret header instead of signing in as a user. Rotating it means re-downloading and re-installing on every PC.</div>
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
        </div>
      </form>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border);">
      <div class="field">
        <label>Published Agent Version</label>
        <div class="small muted" style="margin-bottom:6px;">The install script (scheduled task setup, remote-command runner, self-update logic itself) - unlike the Data Collector Script below, this normally requires re-running the installer to change. Publishing pushes the CURRENT version of that logic here; every already-installed agent compares itself against it on each check-in and silently updates itself if different, no physical reinstall needed. Requires PCs already running an agent built after this self-update feature shipped (that batch needs the one-time reinstall above).${shell.version ? ` Currently published: v${shell.version}${shell.publishedAt ? ` (${new Date(shell.publishedAt).toLocaleString()})` : ''}.` : ' Nothing published yet.'}</div>
        <button type="button" class="btn-outline btn-sm" ${cfg.secret ? '' : 'disabled title="Save a secret first"'} onclick="App.publishWorkspaceDirectoryAgentShell()">Publish Latest Agent Version</button>
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

export async function saveWorkspaceDirectoryAgentForm(event) {
  event.preventDefault();
  const secret = document.getElementById('int-wda-secret').value.trim();
  if (!secret) { toast('Generate or enter a secret first', 'error'); return; }
  const uninstallPasswordInput = document.getElementById('int-wda-uninstall-password').value.trim();
  const settings = STATE.pageData.settings?.data || {};
  const uninstallPasswordHash = uninstallPasswordInput
    ? await sha256Hex(uninstallPasswordInput)
    : (settings.workspaceDirectoryAgent?.uninstallPasswordHash || null);
  try {
    await saveSetting('workspaceDirectoryAgent', { secret, uninstallPasswordHash });
    await logAudit('Save integration settings', 'workspaceDirectoryAgent');
    invalidate('settings');
    toast('Settings saved');
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

// Publishes the CURRENTLY-DEPLOYED outer shell (this build's buildWorkspaceDirectoryAgentScript
// output) to app_settings, keyed by hostname-agnostic content since the shell is identical for
// every PC using the current secret. Every already-installed agent fetches this on its own next
// check-in and self-updates if different (see Invoke-SelfUpdate in the shell template) - this is
// the "centralized deployment" half of the feature; the Data Collector Script above is the other
// half and already worked this way from day one.
export async function publishWorkspaceDirectoryAgentShell() {
  const settings = STATE.pageData.settings?.data || {};
  const secret = settings.workspaceDirectoryAgent?.secret;
  if (!secret) { toast('Save a secret first', 'error'); return; }
  const script = buildWorkspaceDirectoryAgentScript(secret, settings.workspaceDirectoryAgent?.uninstallPasswordHash);
  const version = (settings.workspaceDirectoryAgentShell?.version || 0) + 1;
  try {
    await saveSetting('workspaceDirectoryAgentShell', { script, version, publishedAt: new Date().toISOString() });
    await logAudit('Publish Jstar Agent version', `v${version}`);
    invalidate('settings');
    toast(`Agent v${version} published - every PC self-updates on its next check-in.`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// The default/fallback collector, used both as (a) the pre-filled Data Collector Script textarea
// value and (b) baked directly into the installed agent as Invoke-DefaultCollector, so day-one
// installs (and any run where fetching the remote version fails) still work. Ends with a single
// hashtable literal - its shape is exactly the workspace-directory-checkin request body.
function defaultCollectorScript() {
  return `# Some PCs end up with AnyDesk installed twice under different profiles - a standard install
# AND a separately-branded custom MSI build in its own "ad_*_msi" subfolder (each gets its own
# service/system.conf and its own distinct ID) - so this scans every known conf path instead of
# stopping at the first match, and returns every DISTINCT id found rather than just one, so none of
# them silently go missing from the directory.
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
    return $extra
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
    Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            drive  = $_.DeviceID
            label  = $_.VolumeName
            sizeGb = [math]::Round(($_.Size / 1GB), 1)
            freeGb = [math]::Round(($_.FreeSpace / 1GB), 1)
        }
    }
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
    networkBytesTotal = Get-NetworkBytesTotal
    agentVersion      = "3.0"
}`;
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
# Fully headless by design - these PCs drive signage screens, so nothing here may ever show a
# window, tray icon, or notification (an earlier version had a "Jstar" tray status app; removed
# since any visible UI on a signage PC would show up over the content on screen). The only way to
# reach a specific PC sooner than its next 6-hourly cycle is -PollOnce below, which checks in
# completely silently.

param([switch]$Once, [switch]$Uninstall, [switch]$PollOnce)

$CheckinUrl = "${checkinUrl}"
$CollectorUrl = "${collectorUrl}"
$AgentShellUrl = "${agentShellUrl}"
$ForceStatusUrl = "${forceStatusUrl}"
$AgentSecret = "${secret}"
$AnonKey = "${anonKey}"
$TaskName = "WorkspaceDirectoryAgent"
$PollTaskName = "WorkspaceDirectoryAgentPoll"
$StateDir = "$env:ProgramData\\WorkspaceDirectoryAgent"
$PendingResultFile = Join-Path $StateDir "pending-command-result.json"
$StatusFile = Join-Path $StateDir "status.json"
$LogFile = Join-Path $StateDir "agent.log"
$PendingBatchFile = Join-Path $StateDir "pending-command.bat"
$DuScrapeStateFile = Join-Path $StateDir "du-scrape-last.txt"
$PopupStateFile = Join-Path $StateDir "last-unexpected-windows.txt"
$UninstallPasswordHash = "${uninstallHash}"

# Self-elevate if not already running as Administrator (needed to register/unregister the
# SYSTEM-level task either way, install OR uninstall). Skipped for -Once/-PollOnce - both only ever
# run FROM an already-SYSTEM-elevated scheduled task, so re-elevating would pop a UAC prompt on a
# signage screen for no reason (there's no interactive user to click through it anyway).
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Once -and -not $PollOnce -and -not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $reElevateArgs = "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`""
    if ($Uninstall) { $reElevateArgs += " -Uninstall" }
    Start-Process powershell.exe -ArgumentList $reElevateArgs -Verb RunAs
    exit
}

# Shared by both uninstall paths below: the interactive -Uninstall (password-gated) and the
# dashboard's remote "Uninstall Agent" button on a removed-but-still-reporting device (::UNINSTALL
# pending command, see Invoke-PendingCommand) - same cleanup either way, just gated differently.
function Invoke-UninstallCleanup {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
    Get-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
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
    $lines = Get-Content -Path $LogFile -ErrorAction SilentlyContinue
    if ($lines.Count -gt 200) { $lines[-200..-1] | Set-Content -Path $LogFile -Encoding utf8 }
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
function Invoke-SelfUpdate {
    if (-not $PSCommandPath -or -not (Test-Path $PSCommandPath)) { return }
    try {
        $resp = Invoke-RestMethod -Method Get -Uri $AgentShellUrl -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15
        if (-not $resp -or -not $resp.script) { return }
        $normalize = { param($t) $t -replace "\`r\`n", "\`n" -replace "\`r", "\`n" }
        $current = & $normalize (Get-Content -Path $PSCommandPath -Raw)
        $incoming = & $normalize $resp.script
        if ($incoming -ne $current) {
            Set-Content -Path $PSCommandPath -Value $resp.script -Encoding utf8 -NoNewline
            Write-AgentLog "Agent updated to a newly published version - re-running with the new logic now."
            & $PSCommandPath @PSBoundParameters
            exit
        }
    } catch {
        Write-Warning "Self-update check failed, continuing with the currently-installed version: $($_.Exception.Message)"
    }
}
Invoke-SelfUpdate

function Invoke-DefaultCollector {
${indented}
}

function Get-RemoteCollectorScript {
    try {
        $resp = Invoke-RestMethod -Method Get -Uri $CollectorUrl -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15
        if ($resp -and $resp.script) { return $resp.script }
    } catch {
        Write-Warning "Could not fetch remote collector script, using built-in default: $($_.Exception.Message)"
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
function Invoke-PendingCommand($command) {
    # A dashboard-queued remote uninstall (the "Uninstall Agent" button on a removed-but-still-
    # reporting device) - distinct from the interactive -Uninstall flow's password prompt above,
    # since queuing this already required being signed into the dashboard with delete permission on
    # this exact device; that authentication IS the authorization; a second local password check
    # would just be unreachable anyway (this runs completely non-interactively as SYSTEM). Reports
    # success back with its own immediate POST instead of the normal cache-for-next-cycle path used
    # below, since there IS no next cycle once the scheduled tasks are gone.
    if ($command -eq '::UNINSTALL') {
        Invoke-UninstallCleanup
        try {
            $finalPayload = @{ hostname = $env:COMPUTERNAME; light = $true; commandOutput = "Agent uninstalled remotely from the dashboard - scheduled tasks removed, local state cleared." } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $finalPayload -ContentType "application/json" -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 15 | Out-Null
        } catch {}
        exit 0
    }
    $isBatch = $command -match '^\s*::BATCH\r?\n'
    try {
        if ($isBatch) {
            $batchBody = $command -replace '^\s*::BATCH\r?\n', ''
            New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
            Set-Content -Path $PendingBatchFile -Value $batchBody -Encoding ascii
            $output = & cmd.exe /c "\`"$PendingBatchFile\`"" 2>&1 | Out-String
            Remove-Item -Path $PendingBatchFile -Force -ErrorAction SilentlyContinue
        } else {
            $output = Invoke-Expression $command 2>&1 | Out-String
        }
    } catch {
        $output = "ERROR: $($_.Exception.Message)"
    }
    New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
    @{ output = $output.Substring(0, [Math]::Min(8000, $output.Length)); ranAt = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content -Path $PendingResultFile -Encoding utf8
}

# Scrapes mydata.du.ae once a day for this SIM's own carrier-reported number/usage, as an
# alternative to the network-adapter-counter estimate above. No login is needed: browsing to that
# page over the SIM's OWN mobile-data connection auto-identifies the subscriber (the whole reason
# this works without ever touching a password/OTP) - so this only produces useful data on a PC
# whose internet actually egresses through that SIM, not over Wi-Fi/office LAN. Queue
# "Get-DuDataUsage | ConvertTo-Json" as a Run Command from the dashboard to see the raw result for
# tuning either method below.
#
# Tries the network-based method first (reads the page's own underlying API response directly - see
# Get-DuDataUsageViaNetwork below), falling back to the older DOM-text method only if that comes back
# empty. EXPERIMENTAL: the network method is unverified against a real account as of this writing -
# this dispatcher exists specifically so a PC where it doesn't pan out is no worse off than before,
# not silently stuck on a method that never works for it.
function Get-DuDataUsage {
    $viaNetwork = $null
    try { $viaNetwork = Get-DuDataUsageViaNetwork } catch { Write-AgentLog "DU network-based scrape failed: $($_.Exception.Message)" }
    if ($viaNetwork -and ($null -ne $viaNetwork.dataUsedGb -or $null -ne $viaNetwork.dataTotalGb)) { return $viaNetwork }
    return Get-DuDataUsageViaDom
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
    $browserPaths = @(
        "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
        "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
        "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
        "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
    )
    $browser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $browser) { return $null }

    $port = Get-Random -Minimum 9300 -Maximum 9899
    $tempProfile = Join-Path $env:TEMP ("du-scrape-cdp-" + [guid]::NewGuid().ToString("N"))
    $proc = $null
    $client = $null
    try {
        $proc = Start-Process -FilePath $browser -ArgumentList @(
            "--headless=new", "--disable-gpu", "--incognito", "--user-data-dir=$tempProfile",
            "--no-first-run", "--disable-extensions", "--remote-debugging-port=$port"
        ) -PassThru -WindowStyle Hidden

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
                $raw = [string]$evalMsg.result.result.value
                if ($raw.Length -ge 9) { $du.phoneNumber = "+971" + $raw.Substring(2, 2) + $raw.Substring(4, 3) + $raw.Substring(7) }
            }
        } catch {}

        return $du
    } catch {
        return $null
    } finally {
        if ($client) { try { $client.Dispose() } catch {} }
        if ($proc) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
        Remove-Item -Path $tempProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# The original method - headless Edge/Chrome's --dump-dom flag, then keyword-proximity text parsing
# (looks for a number near "used"/"left"/"total" etc) since the exact page layout isn't something we
# have visibility into ahead of time. Kept as a fallback for whenever the network-based method above
# doesn't pan out (browser too old to support the DevTools Protocol flags used there, a redirect or
# different response shape than expected, etc.) rather than replaced outright.
function Get-DuDataUsageViaDom {
    $browserPaths = @(
        "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
        "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
        "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
        "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
    )
    $browser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $browser) { return $null }

    # A fresh --user-data-dir every run, on top of --incognito, so there's no way a cookie/session
    # from a previous scrape (or a different SIM that used to be in this PC) lingers and causes
    # mydata.du.ae to show stale or wrong-account data - --incognito alone is normally enough, but a
    # brand-new profile directory removes any doubt, and it's deleted again right after since
    # nothing here needs to persist between runs anyway.
    $tempProfile = Join-Path $env:TEMP ("du-scrape-" + [guid]::NewGuid().ToString("N"))
    try {
        $dumpArgs = @("--headless=new", "--disable-gpu", "--incognito", "--user-data-dir=$tempProfile", "--no-first-run", "--disable-extensions", "--virtual-time-budget=10000", "--dump-dom", "http://mydata.du.ae/")
        $html = & $browser @dumpArgs 2>$null | Out-String
        if ([string]::IsNullOrWhiteSpace($html)) { return $null }

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

        # The real mydata.du.ae "Your Data usage" row renders as a single "X GB / Y GB" (used/total)
        # value, not separate used/left/total labels - confirmed against a live account page. Tried
        # first since it's an exact match for the real markup; the keyword-proximity scan below is
        # kept only as a fallback for account states that might render differently (e.g. a different
        # plan type), so a layout change degrades gracefully instead of returning nothing.
        $used = $null
        $total = $null
        if ($joined -match '(\\d+(?:\\.\\d+)?)\\s*GB\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*GB') {
            $used = [double]$matches[1]
            $total = [double]$matches[2]
        }

        function Find-GbNear($lines, $keywords) {
            for ($i = 0; $i -lt $lines.Count; $i++) {
                $isLabel = $false
                foreach ($kw in $keywords) { if ($lines[$i] -match "(?i)$kw") { $isLabel = $true; break } }
                if (-not $isLabel) { continue }
                foreach ($idx in @($i, ($i + 1), ($i - 1))) {
                    if ($idx -ge 0 -and $idx -lt $lines.Count -and $lines[$idx] -match '(\\d+(?:\\.\\d+)?)\\s*GB') { return [double]$matches[1] }
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

        # Included whenever the GB figures specifically are incomplete, not just when EVERYTHING
        # failed - a real account was seen where the phone number scraped fine (it's in the static
        # header) but used/left/total came back null, which the old "only if phone AND used AND left
        # AND total are all missing" condition would hide the raw page text for entirely, since one
        # piece succeeding was enough to suppress it - exactly the case that most needs to be seen to
        # debug why the usage figure itself didn't match.
        [ordered]@{
            phoneNumber = $phone
            dataUsedGb  = $used
            dataLeftGb  = $left
            dataTotalGb = $total
            rawSnippet  = if (-not $used -or -not $total) { $joined.Substring(0, [Math]::Min(1500, $joined.Length)) } else { $null }
        }
    } catch {
        return $null
    } finally {
        Remove-Item -Path $tempProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Signage PCs should show ONLY their own player/browser content full-screen - Windows Update's own
# "Setup"/"restart to finish installing" prompt, or some other app's error dialog, is itself the
# problem regardless of what caused it (real examples: a fuel-pump screen showing a stray app
# window, a Yas Mall totem with an open Windows dialog and taskbar visible over the ad content).
# Deliberately just Get-Process/MainWindowTitle - no raw Win32 API calls (EnumWindows etc.), no
# screen capture - an earlier version using both got blocked twice by Windows Defender's AMSI
# scanner (window enumeration + screenshot + network upload is close to a textbook spyware
# signature); this is a much more ordinary, common PowerShell pattern that doesn't do either.
$Script:ExpectedForegroundProcesses = @(
    'explorer', 'dwm', 'ApplicationFrameHost', 'ShellExperienceHost', 'SearchHost', 'StartMenuExperienceHost',
    'TextInputHost', 'ScreenClippingHost', 'LockApp',
    # Broadsign's/Grassfish's actual player processes are the short "bsp"/"gfPlayer", not
    # "broadsignplayer"/"broadsign"/"grassfishplayer"/"grassfish" - none of those longer strings is a
    # substring of the real short name, so both were being flagged as an "unexpected" popup on every
    # single networked screen. Kept the older/longer names too in case some builds still use them.
    'bsp', 'broadsignplayer', 'broadsign', 'gfplayer', 'grassfishplayer', 'grassfish',
    'chrome', 'msedge', 'iexplore',
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
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() } | ForEach-Object {
        $procName = $_.ProcessName
        $isExpected = $false
        foreach ($allowed in $Script:ExpectedForegroundProcesses) {
            if ($procName -match [regex]::Escape($allowed)) { $isExpected = $true; break }
        }
        if (-not $isExpected) {
            [pscustomobject]@{ title = $_.MainWindowTitle.Trim(); process = $procName }
        }
    }
}

function Invoke-Checkin([switch]$Light) {
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

    # -Light (the 20-minute poll cycle, see -PollOnce below) still collects everything locally -
    # that costs CPU time, not metered SIM data - but drops the one field that's actually large
    # enough to matter for bandwidth before it's ever sent: "software" (up to 2000 Add/Remove
    # Programs entries). Everything else here (volumes, antivirus, problems, remote-access IDs,
    # logged-in user) is at most a few hundred bytes combined, so it stays on every cycle - that's
    # what keeps Online/Offline, Issues, and Remote Access fresh every 20 minutes instead of every 6
    # hours. Software rarely changes minute-to-minute anyway, so it only needs the full 6-hourly
    # cycle. workspace-directory-checkin leaves the stored software list untouched (sticky) whenever
    # this flag is set, rather than wiping it to empty.
    if ($Light) {
        $data.software = @()
        $data.light = $true
    }

    # Only reported when the detected set actually CHANGES from last time (a local state file
    # tracks the last-reported titles) - the same stray Windows Update prompt sitting there for
    # hours shouldn't get resent every 20 minutes, only the moment something new shows up (or the
    # existing one finally clears). Runs on every check-in (light or full) since it's cheap -
    # Get-Process, no network calls, no screen capture.
    try {
        $__unexpected = @(Get-UnexpectedWindows)
    } catch { $__unexpected = @() }
    $__unexpectedKey = (($__unexpected | ForEach-Object { "$($_.title)|$($_.process)" }) | Sort-Object) -join ';'
    $__lastPopupKey = if (Test-Path $PopupStateFile) { Get-Content -Path $PopupStateFile -Raw -ErrorAction SilentlyContinue } else { '' }
    if ($__unexpectedKey -ne $__lastPopupKey) {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Content -Path $PopupStateFile -Value $__unexpectedKey -Encoding utf8 -NoNewline
        if ($__unexpected.Count -gt 0) {
            $popupSummary = ($__unexpected | ForEach-Object { "$($_.title) ($($_.process))" }) -join '; '
            $existingProblems = @($data.problems) | Where-Object { $_ }
            $data.problems = @($existingProblems + "Unexpected window/popup detected: $popupSummary")
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

    # Launching a browser is slow, so this is gated to about once a day (independent of the
    # 6-hourly check-in cadence) via a local timestamp file, same idea as the server-side gate on
    # the network-counter usage figure. The gate advances on every ATTEMPT, not just success, so a
    # temporarily-unreachable page retries tomorrow rather than every 6 hours.
    $duDue = (-not (Test-Path $DuScrapeStateFile)) -or (((Get-Date) - [datetime](Get-Content -Path $DuScrapeStateFile -Raw -ErrorAction SilentlyContinue)).TotalHours -ge 20)
    if ($duDue) {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        Set-Content -Path $DuScrapeStateFile -Value (Get-Date).ToString("o") -Encoding utf8
        try {
            $du = Get-DuDataUsage
            if ($du) {
                if ($du.phoneNumber) { $data.duPhoneNumber = $du.phoneNumber }
                if ($null -ne $du.dataUsedGb) { $data.duDataUsedGb = $du.dataUsedGb }
                if ($null -ne $du.dataLeftGb) { $data.duDataLeftGb = $du.dataLeftGb }
                if ($null -ne $du.dataTotalGb) { $data.duDataTotalGb = $du.dataTotalGb }
                Write-AgentLog "DU data-usage scrape: phone=$($du.phoneNumber) used=$($du.dataUsedGb) left=$($du.dataLeftGb) total=$($du.dataTotalGb)"
            } else {
                Write-AgentLog "DU data-usage scrape found no browser or returned nothing."
            }
        } catch {
            Write-AgentLog "DU data-usage scrape failed: $($_.Exception.Message)"
        }
    }

    $payload = $data | ConvertTo-Json -Depth 6 -Compress
    try {
        $response = Invoke-RestMethod -Method Post -Uri $CheckinUrl -Body $payload -ContentType "application/json" \`
            -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 30
        Write-Host "Checked in successfully."
        Write-AgentLog "Check-in succeeded."
        Write-AgentStatus $true "Checked in successfully."
        if ($response -and $response.pendingCommand) {
            Write-Host "Running queued command..."
            Write-AgentLog "Running queued command: $($response.pendingCommand)"
            Invoke-PendingCommand $response.pendingCommand
        }
    } catch {
        Write-Warning "Check-in failed: $($_.Exception.Message)"
        Write-AgentLog "Check-in FAILED: $($_.Exception.Message)"
        Write-AgentStatus $false $_.Exception.Message
    }
}

if (-not $Once) {
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`" -Once"
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
    try {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($RepeatTrigger, $StartupTrigger) -Principal $Principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($RepeatTrigger, $StartupTrigger) -Principal $Principal -Description "Reports this PC's inventory to the Hypermedia Operations Dashboard." | Out-Null
        }
        Write-Host "Scheduled task '$TaskName' installed (runs on startup and every 6 hours)." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register the scheduled task: $($_.Exception.Message)"
    }

    # Chocolatey is bootstrapped at install time (not on every 6-hourly -Once run) so a Run Command
    # queued from the dashboard - or a future bulk deployment - can always reach for "choco install
    # -y <pkg>" and expect it to work, without depending on winget/App Installer already being
    # present (it isn't on every Windows 10 build these back-office/kiosk PCs run, whereas
    # Chocolatey's own bootstrapper is just this one self-contained script). Skipped entirely if
    # choco.exe is already on PATH, so a re-run of the installer (e.g. after a secret rotation)
    # doesn't reinstall it every time.
    if (-not (Get-Command choco.exe -ErrorAction SilentlyContinue)) {
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
        $PollAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$PSCommandPath\`" -PollOnce"
        $PollTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 20)
        $PollTrigger.Repetition.Duration = ""
        if (Get-ScheduledTask -TaskName $PollTaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $PollTaskName -Action $PollAction -Trigger $PollTrigger -Principal $Principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $PollTaskName -Action $PollAction -Trigger $PollTrigger -Principal $Principal -Description "Checks every 20 minutes for a Force Inventory Pull request from the dashboard - runs fully hidden, no UI." | Out-Null
        }
        Write-Host "Scheduled task '$PollTaskName' installed (checks every 20 minutes, no UI)." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register the poll task: $($_.Exception.Message)"
    }
}

# Every 20-minute poll checks in - lightly (see Invoke-Checkin's -Light handling above) unless a
# Force Inventory Pull is waiting, in which case it does the real thing instead. A cheap GET decides
# which, first:
if ($PollOnce) {
    $forceRequested = $false
    try {
        $resp = Invoke-RestMethod -Method Get -Uri ($ForceStatusUrl + "?hostname=" + $env:COMPUTERNAME) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 10
        $forceRequested = $resp -and $resp.force
    } catch {}
    if ($forceRequested) {
        Invoke-Checkin
    } else {
        # The common case - keeps Online/Offline, Issues, and Remote Access fresh at 20-minute
        # resolution instead of 6 hours, without resending the installed-software list (the one field
        # actually large enough to matter on a metered cellular SIM) more often than it needs to.
        Invoke-Checkin -Light
    }
    exit
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
# Runs on every real check-in (fresh install AND the 6-hourly -Once cycle, skipped only for the
# lightweight 20-minute -PollOnce path via the exit above) rather than install time only - the outer
# shell self-updates from the published agent-shell version on every run (Invoke-SelfUpdate above),
# so this reaches the whole already-installed fleet the same way any other shell change does, no
# per-machine re-install needed. Cheap/idempotent, so running it every cycle also means it self-heals
# if something else resets these keys.
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
    ${integrationField(settings, 'sendgridEmail', 'SendGrid Email', [
      { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'fromEmail', label: 'From Email (must be a Verified Sender in SendGrid)', type: 'email' },
      { name: 'fromName', label: 'From Name (optional)' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'sendgrid-send')}
    ${integrationField(settings, 'glpiFeed', 'GLPI CSV Feed', [
      { name: 'csvUrl', label: 'CSV URL' }, { name: 'autoRefreshMinutes', label: 'Auto-refresh (minutes)', type: 'number' },
    ])}
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
