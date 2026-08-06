import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { listCategories, addCategory, updateCategory, deleteCategory } from '../data/categories.js';
import { listContractors, saveContractor, deleteContractor } from '../data/contractors.js';
import { listNetworks, ensureNetwork, renameNetwork, countNetworkUsage, deleteNetwork } from '../data/networks.js';
import { getAllSettings, saveSetting } from '../data/settings.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { invalidateAssetInventoryCaches } from './assetsInventory.js';
import { listLocations } from '../data/locations.js';
import { listCampaigns } from '../data/campaigns.js';
import { listBrandLogos, lookupBrandLogos } from '../data/brandLogos.js';
import { brandNameForLocation } from '../data/locationStats.js';
import { brandNameForVenue, brandFallbackForVenue } from './trafficSheet.js';
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
  { key: 'integrations', label: 'Integrations' },
];

export function renderSettings() {
  const tab = STATE.settingsTab || 'categories';
  let body;
  if (tab === 'contractors') body = renderContractorsTab();
  else if (tab === 'networks') body = renderNetworksTab();
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
      <td>${c.is_rental ? '<span class="badge b-amber">Rental-tracked</span>' : '-'}</td>
      <td>
        <button class="btn-sm" onclick="App.editCategoryModal('${c.id}')">Edit</button>
        <button class="btn-sm" onclick="App.removeCategory('${c.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Asset Categories</h3><div class="desc">Rental-tracked categories (Scaffolding, Spider Lift) show a rental period + maintenance location instead of a warranty date on the Asset form.</div></div>
      <table><thead><tr><th>Name</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>
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
// fleet-wide "Devices by platform/state/camera type/version" breakdown on the IoT Panel (no
// calibration needed for those - they're plain labels). The per-Location online/offline rollup
// still needs "Offline Status Values" set once, same as Broadsign/Grassfish, since which raw
// device states count as "down" is a judgment call.
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
        <div class="field"><label>Offline Status Values</label>
          <input id="int-iotApi-offlineStatusValues" value="${esc(cfg.offlineStatusValues || '')}" placeholder="e.g. Offline,Unknown">
          <div class="small muted" style="margin-top:4px;">Comma-separated device states (from the counts below) that should count as offline for the per-location heatmap. The "Devices by ..." breakdown on the IoT Panel works without this being set.</div>
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

function renderAssetInventoryApiCard(settings) {
  const cfg = settings.assetInventoryApi || {};
  const testing = STATE.testing_assetInventoryApi;
  return `
    <div class="card">
      <div class="card-head"><h3>Asset Inventory API Sync</h3><div class="desc">Generic JSON API puller - point it at any system and map its fields to our columns. For a one-off import instead, use the Bulk Import button on the Asset Inventory page.</div></div>
      <form onsubmit="App.saveAssetInventoryApiForm(event)">
        <div class="field"><label>Base URL</label><input id="int-ai-baseUrl" value="${esc(cfg.baseUrl || '')}" placeholder="https://source-system.example.com/api/screens"></div>
        <div class="grid2">
          <div class="field"><label>Auth Header Name (optional)</label><input id="int-ai-authHeaderName" value="${esc(cfg.authHeaderName || '')}" placeholder="Authorization"></div>
          <div class="field"><label>Auth Header Value (optional)</label><input id="int-ai-authHeaderValue" type="password" value="${esc(cfg.authHeaderValue || '')}" placeholder="Bearer ..."></div>
        </div>
        <div class="field"><label>Field Mapping (JSON: our column -&gt; source field path)</label>
          <textarea id="int-ai-fieldMapping" rows="4" style="font-family:monospace;font-size:12px;">${esc(JSON.stringify(cfg.fieldMapping || { source_asset_id: 'id', name: 'name', venue: 'venue', location: 'location', category: 'category' }, null, 2))}</textarea>
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
  cfg.authHeaderName = document.getElementById('int-ai-authHeaderName').value.trim();
  cfg.authHeaderValue = document.getElementById('int-ai-authHeaderValue').value.trim();
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
// Metro/Bridges stations are gathered individually (their "Metro Station - "/"Metro Bridge - "
// prefix stripped) since many really are sponsor-branded ("Danube", "Equiti", "OnPassive") - this
// also always adds the shared "Dubai Metro Rail" fallback brand (see brandFallbackForVenue) so it
// stays cached for stations with no real sponsor of their own. Same function Traffic Sheet's own
// display uses, so the cache key here always matches the lookup key there.
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
      const n = brandNameForVenue(v);
      if (n) names.add(n.trim());
      const fb = brandFallbackForVenue(v);
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
    ${renderAssetInventoryApiCard(settings)}
    ${renderBrandfetchCard(settings)}
    ${integrationField(settings, 'trafficSheetApi', 'Traffic Sheet API (AdLive Center)', [
      { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'traffic-sheet-proxy')}
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
