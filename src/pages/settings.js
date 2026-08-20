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
      <div class="card-head"><h3>Digital Directory Agent</h3><div class="desc">Our own lightweight PC inventory agent (hostname, IP, AnyDesk/TeamViewer ID, Broadsign Player ID/Grassfish Box ID, OS, logged-in user, disk volumes, hardware, antivirus status, installed software, detected problems). The Broadsign/Grassfish ID matches this PC to the same screen in those Consoles (by Player Box ID, same as those syncs already use), so each side can link to the other's AnyDesk/TeamViewer or screen info. Also installs "Jstar", a tray icon + status window (Check In Now / View Log / last result) so anyone at the PC can see the agent is active - it needs the .ps1 and .bat downloaded below in the SAME folder. Generate a secret, save, then run the .bat as Administrator on each PC once (double-clicking the .ps1 directly just opens it in Notepad - Windows' default for script files). After that one install, every agent self-updates from Published Agent Version below - PCs in remote locations never need a physical reinstall again for anything except a secret rotation.</div></div>
      <form onsubmit="App.saveWorkspaceDirectoryAgentForm(event)">
        <div class="field"><label>Shared Agent Secret</label>
          <div style="display:flex;gap:8px;">
            <input id="int-wda-secret" type="password" autocomplete="off" value="${esc(cfg.secret || '')}" style="flex:1;">
            <button type="button" class="btn-outline btn-sm" onclick="App.generateWorkspaceDirectorySecret()">Generate</button>
          </div>
          <div class="small muted" style="margin-top:4px;">Every agent sends this in an x-agent-secret header instead of signing in as a user. Rotating it means re-downloading and re-installing on every PC.</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-orange" type="submit">Save</button>
          <button type="button" class="btn-outline btn-sm" ${cfg.secret ? '' : 'disabled title="Save a secret first"'} onclick="App.downloadWorkspaceDirectoryAgentScript()">Download Install Script (.ps1)</button>
          <button type="button" class="btn-outline btn-sm" onclick="App.downloadWorkspaceDirectoryAgentBatch()">Download Launcher (.bat)</button>
        </div>
      </form>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border);">
      <div class="field">
        <label>Published Agent Version</label>
        <div class="small muted" style="margin-bottom:6px;">The install script (scheduled task setup, remote-command runner, tray icon, self-update logic itself) - unlike the Data Collector Script below, this normally requires re-running the installer to change. Publishing pushes the CURRENT version of that logic here; every already-installed agent compares itself against it on each check-in and silently updates itself if different, no physical reinstall needed. Requires PCs already running an agent built after this self-update feature shipped (that batch needs the one-time reinstall above).${shell.version ? ` Currently published: v${shell.version}${shell.publishedAt ? ` (${new Date(shell.publishedAt).toLocaleString()})` : ''}.` : ' Nothing published yet.'}</div>
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

export async function saveWorkspaceDirectoryAgentForm(event) {
  event.preventDefault();
  const secret = document.getElementById('int-wda-secret').value.trim();
  if (!secret) { toast('Generate or enter a secret first', 'error'); return; }
  try {
    await saveSetting('workspaceDirectoryAgent', { secret });
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
  const script = buildWorkspaceDirectoryAgentScript(secret);
  const version = (settings.workspaceDirectoryAgentShell?.version || 0) + 1;
  try {
    await saveSetting('workspaceDirectoryAgentShell', { script, version, publishedAt: new Date().toISOString() });
    await logAudit('Publish Digital Directory agent version', `v${version}`);
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
  return `function Get-AnyDeskId {
    $paths = @(
        "$env:ProgramData\\AnyDesk\\service.conf",
        "$env:ProgramData\\AnyDesk\\system.conf",
        "$env:APPDATA\\AnyDesk\\user.conf"
    )
    foreach ($path in $paths) {
        if (Test-Path $path) {
            $content = Get-Content -Path $path -ErrorAction SilentlyContinue
            $match = $content | Select-String -Pattern "ad.anynet.id=(\\d+)"
            if ($match) { return $match.Matches[0].Groups[1].Value }
        }
    }
    return $null
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

# Extend this to detect more remote-access tools (Chrome Remote Desktop, LogMeIn, etc.) as
# @{ tool = 'ToolName'; id = '...' } entries - the intended extension point for "any remote
# software ID", since there's no single universal way to enumerate every possible tool.
function Get-OtherRemoteIds { @() }

# Same discovery approach Broadsign's own player leaves on disk (and the same fallback file/keyword
# search the original NSOC agent used) - matched server-side against Asset Inventory's Player Box
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
$__anydeskId = Get-AnyDeskId
$__teamviewerId = Get-TeamViewerId
$__os = Get-CimInstance Win32_OperatingSystem

@{
    hostname          = $env:COMPUTERNAME
    ip                = Get-PrimaryIPv4
    anydeskId         = $__anydeskId
    teamviewerId      = $__teamviewerId
    otherRemoteIds    = @(Get-OtherRemoteIds)
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

// A small tray app (System.Windows.Forms) that mirrors the reference GLPI Agent Monitor's own
// tray icon + status window - written to $StateDir\tray.ps1 by the outer install script (embedded
// below as base64 so nothing here needs escaping for PowerShell-inside-PowerShell) and run via its
// own "at any user's logon" scheduled task, since a tray icon needs a real interactive desktop
// session - the 6-hourly check-in task runs headless as SYSTEM and can't show one itself. Reads
// $StateDir\status.json (written by Invoke-Checkin after every attempt) so the window always
// reflects the real last result, and its "Check In Now" button runs the same agent.ps1 the
// scheduled task does, so a manual check from the tray behaves identically to an automatic one.
// Also polls workspace-directory-force-status every ~2 minutes for a "Force Inventory Pull"
// request from the dashboard, and runs the same check-in automatically if one's waiting - this is
// the ONLY way a dashboard click can reach a specific PC sooner than its next scheduled cycle,
// since these PCs are on metered SIMs behind NAT/cellular routers with no inbound reachability;
// the dashboard can never push to them, only they can poll out. Needs its own copy of the secret
// (passed in here) since it's a separate always-resident process from the scheduled check-in task.
function buildTrayScript(secret, anonKey, forceStatusUrl) {
  return `# Jstar - the Digital Directory Agent's tray status monitor
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$StateDir = "$env:ProgramData\\WorkspaceDirectoryAgent"
$StatusFile = Join-Path $StateDir "status.json"
$LogFile = Join-Path $StateDir "agent.log"
$AgentScript = Join-Path $StateDir "agent.ps1"
$DashboardUrl = "https://sarkasticgenius.github.io/hypermedia-operations-dashboard/"
$AgentSecret = "${secret}"
$AnonKey = "${anonKey}"
$ForceStatusUrl = "${forceStatusUrl}"

# A filled-circle "J" (Jstar) bitmap stands in for a real .ico asset - gives the tray a
# distinctive, branded look without shipping/loading a separate image file.
function New-TrayIcon {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 145, 178))
    $g.FillEllipse($brush, 0, 0, 32, 32)
    $font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString("J", $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, 32, 32)), $format)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function Get-AgentStatus {
    if (Test-Path $StatusFile) {
        try { return Get-Content $StatusFile -Raw | ConvertFrom-Json } catch { return $null }
    }
    return $null
}

function Format-AgentStatusSummary {
    $s = Get-AgentStatus
    if (-not $s) { return "No check-in yet" }
    $when = [datetime]$s.lastCheckin
    $mins = [math]::Round(((Get-Date) - $when).TotalMinutes)
    $ago = if ($mins -lt 60) { "$mins min ago" } else { "$([math]::Round($mins / 60, 1)) h ago" }
    $word = if ($s.success) { "OK" } else { "FAILED" }
    return "Last check-in: $ago ($word)"
}

$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = New-TrayIcon
$trayIcon.Visible = $true
$trayIcon.Text = "Jstar"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Jstar"
$form.Size = New-Object System.Drawing.Size(340, 420)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Jstar"
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(20, 20)
$form.Controls.Add($titleLabel)

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Text = "Digital Directory Agent"
$subtitleLabel.ForeColor = [System.Drawing.Color]::Gray
$subtitleLabel.AutoSize = $true
$subtitleLabel.Location = New-Object System.Drawing.Point(20, 47)
$form.Controls.Add($subtitleLabel)

$taskStatusLabel = New-Object System.Windows.Forms.Label
$taskStatusLabel.AutoSize = $true
$taskStatusLabel.Location = New-Object System.Drawing.Point(20, 78)
$form.Controls.Add($taskStatusLabel)

$checkinStatusLabel = New-Object System.Windows.Forms.Label
$checkinStatusLabel.AutoSize = $true
$checkinStatusLabel.Location = New-Object System.Drawing.Point(20, 103)
$form.Controls.Add($checkinStatusLabel)

$agentStatusLabel = New-Object System.Windows.Forms.Label
$agentStatusLabel.Text = "Agent status: idle"
$agentStatusLabel.AutoSize = $true
$agentStatusLabel.Location = New-Object System.Drawing.Point(20, 133)
$form.Controls.Add($agentStatusLabel)

$checkInBtn = New-Object System.Windows.Forms.Button
$checkInBtn.Text = "Check In Now"
$checkInBtn.Location = New-Object System.Drawing.Point(20, 173)
$checkInBtn.Size = New-Object System.Drawing.Size(140, 32)
$form.Controls.Add($checkInBtn)

$logBtn = New-Object System.Windows.Forms.Button
$logBtn.Text = "View Agent Log"
$logBtn.Location = New-Object System.Drawing.Point(170, 173)
$logBtn.Size = New-Object System.Drawing.Size(140, 32)
$form.Controls.Add($logBtn)

$openBtn = New-Object System.Windows.Forms.Button
$openBtn.Text = "Open Digital Directory"
$openBtn.Location = New-Object System.Drawing.Point(20, 215)
$openBtn.Size = New-Object System.Drawing.Size(290, 32)
$form.Controls.Add($openBtn)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Text = "To install/uninstall software here, queue it from this PC's Edit screen in Digital Directory (above), then Check In Now."
$hintLabel.ForeColor = [System.Drawing.Color]::Gray
$hintLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$hintLabel.Size = New-Object System.Drawing.Size(290, 45)
$hintLabel.Location = New-Object System.Drawing.Point(20, 255)
$form.Controls.Add($hintLabel)

$closeBtn = New-Object System.Windows.Forms.Button
$closeBtn.Text = "Close"
$closeBtn.Location = New-Object System.Drawing.Point(20, 308)
$closeBtn.Size = New-Object System.Drawing.Size(290, 32)
$form.Controls.Add($closeBtn)

function Update-FormStatus {
    $task = Get-ScheduledTask -TaskName "WorkspaceDirectoryAgent" -ErrorAction SilentlyContinue
    $taskWord = if ($task) { $task.State } else { "not installed" }
    $taskStatusLabel.Text = "Check-in task: $taskWord"
    $checkinStatusLabel.Text = Format-AgentStatusSummary
}

# Shared by the button and the force-pull timer below, so a dashboard-triggered check-in behaves
# identically to a manually-clicked one (same UI feedback, same status.json update afterward).
function Invoke-TrayCheckin {
    $agentStatusLabel.Text = "Agent status: checking in..."
    $form.Refresh()
    $checkInBtn.Enabled = $false
    if (Test-Path $AgentScript) {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \`"$AgentScript\`" -Once" -WindowStyle Hidden -Wait
    }
    $checkInBtn.Enabled = $true
    $agentStatusLabel.Text = "Agent status: idle"
    Update-FormStatus
    $trayIcon.Text = ("Jstar\`n" + (Format-AgentStatusSummary))
}

$checkInBtn.Add_Click({ Invoke-TrayCheckin })
$logBtn.Add_Click({
    if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile } else { [System.Windows.Forms.MessageBox]::Show("No log yet.", "Jstar") | Out-Null }
})
$openBtn.Add_Click({ Start-Process $DashboardUrl })
$closeBtn.Add_Click({ $form.Hide() })
$form.Add_FormClosing({
    param($eventSender, $e)
    if ($e.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) { $e.Cancel = $true; $form.Hide() }
})
$form.Add_Shown({ Update-FormStatus })

$trayIcon.Add_MouseClick({
    param($eventSender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Update-FormStatus
        $form.Show()
        $form.Activate()
    }
})

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openMenuItem = $menu.Items.Add("Open Status Window")
$exitMenuItem = $menu.Items.Add("Exit")
$trayIcon.ContextMenuStrip = $menu
$openMenuItem.Add_Click({ Update-FormStatus; $form.Show(); $form.Activate() })
$exitMenuItem.Add_Click({ $trayIcon.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$trayIcon.ShowBalloonTip(4000, "Jstar", "Digital Directory Agent is active on this PC.", [System.Windows.Forms.ToolTipIcon]::Info)

# Polls for a "Force Inventory Pull" click from the dashboard - the only channel that can exist
# given these PCs have no inbound reachability (metered SIM behind NAT/cellular router), so the
# dashboard can never push to them. A couple of minutes' latency and a tiny request are an easy
# trade for "the button on the dashboard actually does something soon" instead of waiting up to 6
# hours for the next scheduled cycle.
$forceTimer = New-Object System.Windows.Forms.Timer
$forceTimer.Interval = 120000
$forceTimer.Add_Tick({
    try {
        $resp = Invoke-RestMethod -Method Get -Uri ($ForceStatusUrl + "?hostname=" + $env:COMPUTERNAME) -Headers @{ "x-agent-secret" = $AgentSecret; "apikey" = $AnonKey } -TimeoutSec 10
        if ($resp -and $resp.force) { Invoke-TrayCheckin }
    } catch {}
})
$forceTimer.Start()

[System.Windows.Forms.Application]::Run()
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
function buildWorkspaceDirectoryAgentScript(secret) {
  const checkinUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-checkin`;
  const collectorUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-collector`;
  const agentShellUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-agent-shell`;
  const forceStatusUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/workspace-directory-force-status`;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const indented = defaultCollectorScript().split('\n').map((l) => `    ${l}`).join('\n');
  // Base64, not inlined as PowerShell-inside-a-PowerShell-string, so nothing in the tray script's
  // own quotes/backticks/$variables needs escaping for this outer template - the install script
  // just writes the decoded bytes straight to tray.ps1 at install time.
  const trayScriptB64 = btoa(unescape(encodeURIComponent(buildTrayScript(secret, anonKey, forceStatusUrl))));
  return `# Digital Directory Agent
# Collects PC inventory and checks in with the Hypermedia Operations Dashboard every 6 hours via a
# scheduled task (the SIM-data-usage figure itself is only recomputed about once a day regardless -
# see workspace-directory-checkin), since several of these PCs run on metered cellular SIM data
# rather than broadband. What gets collected is fetched fresh from the dashboard on every run
# (Settings > Integrations > Digital Directory Agent > Data Collector Script) - this outer shell
# itself never needs to change or be re-installed to pick up a new field. Re-run this script any
# time to update the install (e.g. after rotating the secret).

param([switch]$Once)

$CheckinUrl = "${checkinUrl}"
$CollectorUrl = "${collectorUrl}"
$AgentShellUrl = "${agentShellUrl}"
$AgentSecret = "${secret}"
$AnonKey = "${anonKey}"
$TaskName = "WorkspaceDirectoryAgent"
$TrayTaskName = "WorkspaceDirectoryAgentTray"
$StateDir = "$env:ProgramData\\WorkspaceDirectoryAgent"
$PendingResultFile = Join-Path $StateDir "pending-command-result.json"
$StatusFile = Join-Path $StateDir "status.json"
$LogFile = Join-Path $StateDir "agent.log"
$AgentCopyPath = Join-Path $StateDir "agent.ps1"
$TrayScriptPath = Join-Path $StateDir "tray.ps1"
$DuScrapeStateFile = Join-Path $StateDir "du-scrape-last.txt"
$TrayScriptB64 = "${trayScriptB64}"

# Self-elevate if not already running as Administrator (needed to register the SYSTEM-level task).
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Once -and -not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \`"$PSCommandPath\`"" -Verb RunAs
    exit
}

# Appends one line per attempt (capped to the last 200) and refreshes status.json - both purely so
# the tray status window (tray.ps1, run separately since it needs a real desktop) has something
# real to show; this task itself never reads them back.
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
# whatever's currently Published in Settings > Integrations > Digital Directory Agent, and if they
# differ, overwrites itself and re-execs the NEW version immediately (so the rest of this run - task
# registration, tray install, check-in - already uses the updated logic), then exits so the stale
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
# rather than opening a second connection just to report it now.
function Invoke-PendingCommand($command) {
    try {
        $output = Invoke-Expression $command 2>&1 | Out-String
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
# whose internet actually egresses through that SIM, not over Wi-Fi/office LAN. Uses headless
# Edge/Chrome's own --dump-dom flag rather than Selenium/WebDriver - no extra tooling to install.
# The exact page layout isn't something we have visibility into ahead of time, so parsing is
# keyword-proximity based (looks for a number near "used"/"left"/"total" etc) rather than a fixed
# selector - queue "Get-DuDataUsage | ConvertTo-Json" as a Run Command from the dashboard to see
# the raw parsed result (or the raw page text if nothing could be parsed) for tuning.
function Get-DuDataUsage {
    $browserPaths = @(
        "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
        "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
        "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
        "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe"
    )
    $browser = $browserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $browser) { return $null }

    try {
        $dumpArgs = @("--headless=new", "--disable-gpu", "--incognito", "--no-first-run", "--disable-extensions", "--virtual-time-budget=10000", "--dump-dom", "https://mydata.du.ae")
        $html = & $browser @dumpArgs 2>$null | Out-String
        if ([string]::IsNullOrWhiteSpace($html)) { return $null }

        // Breaks the DOM into one "line" per block-level element (rather than one flattened blob)
        // before matching - a label and its value are almost always in the same or an adjacent
        // block (same table row/cell pair, or a label div followed by a value div), and matching
        // per-line avoids a keyword accidentally pairing with some UNRELATED number that just
        // happens to appear within N characters of it in a flattened string.
        $lineBreak = $html -replace '(?is)<script.*?</script>', ' ' -replace '(?is)<style.*?</style>', ' ' -replace '(?i)</(div|p|li|td|tr|span|h1|h2|h3|h4|h5|h6)>', "\`n" -replace '(?i)<br\\s*/?>', "\`n" -replace '<[^>]+>', ' '
        $lines = $lineBreak -split "\`n" | ForEach-Object { ([System.Net.WebUtility]::HtmlDecode($_) -replace '\\s+', ' ').Trim() } | Where-Object { $_ }
        if (-not $lines) { return $null }

        $phone = $null
        if (($lines -join ' | ') -match '(?:\\+?971|0)5\\d{8}') { $phone = $matches[0] }

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
        $used = Find-GbNear $lines @('used', 'consumed')
        $left = Find-GbNear $lines @('left', 'remaining', 'balance')
        $total = Find-GbNear $lines @('total', 'allocat', 'plan', 'bundle')
        if (-not $total -and $used -and $left) { $total = [math]::Round($used + $left, 2) }

        [ordered]@{
            phoneNumber = $phone
            dataUsedGb  = $used
            dataLeftGb  = $left
            dataTotalGb = $total
            rawSnippet  = if (-not $phone -and -not $used -and -not $left -and -not $total) { ($lines -join ' | ').Substring(0, [Math]::Min(1500, ($lines -join ' | ').Length)) } else { $null }
        }
    } catch {
        return $null
    }
}

function Invoke-Checkin {
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
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)
    $Trigger.Repetition.Duration = ""
    $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    try {
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Description "Reports this PC's inventory to the Hypermedia Operations Dashboard." | Out-Null
        }
        Write-Host "Scheduled task '$TaskName' installed (runs every 6 hours)." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register the scheduled task: $($_.Exception.Message)"
    }

    # Jstar (the tray status icon) needs a real interactive desktop, unlike the headless SYSTEM
    # check-in task above - so it's a separate "run at any user's logon" task, unelevated, mirroring
    # how the reference GLPI Agent Monitor tray app runs in the signed-in user's own session.
    try {
        New-Item -ItemType Directory -Path $StateDir -Force -ErrorAction SilentlyContinue | Out-Null
        if ($PSCommandPath) { Copy-Item -Path $PSCommandPath -Destination $AgentCopyPath -Force -ErrorAction SilentlyContinue }
        $trayBytes = [Convert]::FromBase64String($TrayScriptB64)
        [System.IO.File]::WriteAllText($TrayScriptPath, [System.Text.Encoding]::UTF8.GetString($trayBytes))

        $TrayAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$TrayScriptPath\`""
        $TrayTrigger = New-ScheduledTaskTrigger -AtLogOn
        $TrayPrincipal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\\Users" -RunLevel Limited
        if (Get-ScheduledTask -TaskName $TrayTaskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $TrayTaskName -Action $TrayAction -Trigger $TrayTrigger -Principal $TrayPrincipal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $TrayTaskName -Action $TrayAction -Trigger $TrayTrigger -Principal $TrayPrincipal -Description "Jstar - shows a tray icon confirming the Digital Directory Agent is active." | Out-Null
        }
        Start-Process powershell.exe -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$TrayScriptPath\`"" -ErrorAction SilentlyContinue
    } catch {
        Write-Warning "Could not install the Jstar tray icon: $($_.Exception.Message)"
    }
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
  downloadTextFile(buildWorkspaceDirectoryAgentScript(secret), 'Install-DigitalDirectoryAgent.ps1');
}

// Plain double-clickable launcher, same idea as the reference NSOC agent's own .cmd wrapper -
// double-clicking a .ps1 directly just opens it in Notepad (Windows' safety default), so this is
// the intended way to actually run the install. Requests elevation itself (the .ps1 also
// self-elevates, but starting elevated avoids two separate UAC prompts). Closes itself
// automatically on success - the Jstar tray icon that appears afterward is the visible
// confirmation - and only pauses if the install itself failed, so an error stays visible instead
// of the window vanishing before anyone can read it.
function buildAgentBatchLauncher() {
  return `@echo off
setlocal

NET SESSION >NUL 2>&1
IF %ERRORLEVEL% NEQ 0 (
    ECHO Requesting Administrator privileges...
    GOTO :ADMIN_ELEVATION
)

ECHO Launching Digital Directory Agent installation...
ECHO.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-DigitalDirectoryAgent.ps1"
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
  downloadTextFile(buildAgentBatchLauncher(), 'Install-DigitalDirectoryAgent.bat');
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
