import { STATE, loadData, invalidate, toast, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listCategories, addCategory, deleteCategory } from '../data/categories.js';
import { listContractors, saveContractor, deleteContractor } from '../data/contractors.js';
import { listNetworks, ensureNetwork } from '../data/networks.js';
import { getAllSettings, saveSetting } from '../data/settings.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { supabase } from '../supabaseClient.js';
import { logAudit } from '../lib/audit.js';
import { esc } from '../lib/format.js';

const TABS = [
  { key: 'categories', label: 'Asset Categories' },
  { key: 'contractors', label: 'Contractors' },
  { key: 'networks', label: 'Screen Networks' },
  { key: 'integrations', label: 'Integrations' },
];

export function renderSettings() {
  const tab = STATE.settingsTab || 'categories';
  const tabsHtml = TABS.map((t) => `<div class="tab ${tab === t.key ? 'active' : ''}" onclick="App.setSettingsTab('${t.key}')">${t.label}</div>`).join('');
  let body;
  if (tab === 'contractors') body = renderContractorsTab();
  else if (tab === 'networks') body = renderNetworksTab();
  else if (tab === 'integrations') body = renderIntegrationsTab();
  else body = renderCategoriesTab();
  return `<div class="tabs">${tabsHtml}</div>${body}`;
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
      <td><button class="btn-sm" onclick="App.removeCategory('${c.id}')">Delete</button></td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Asset Categories</h3><div class="desc">Rental-tracked categories (Scaffolding, Spider Lift) show a rental period + maintenance location instead of a warranty date on the Asset form.</div></div>
      <table><thead><tr><th>Name</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <form onsubmit="App.addCategoryForm(event)" class="grid2" style="margin-top:14px;">
        <div class="field"><label>New Category</label><input id="cat-name" required></div>
        <div class="field"><label>&nbsp;</label>
          <label style="display:flex;align-items:center;gap:6px;font-weight:400;"><input type="checkbox" id="cat-rental" style="width:auto;"> Rental-tracked</label>
        </div>
        <div><button class="btn btn-orange" type="submit">Add</button></div>
      </form>
    </div>
  `;
}

export async function addCategoryForm(event) {
  event.preventDefault();
  const name = document.getElementById('cat-name').value.trim();
  const isRental = document.getElementById('cat-rental').checked;
  try {
    await addCategory(name, isRental);
    await logAudit('Add category', name);
    invalidate('categories');
    toast('Category added');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeCategory(id) {
  if (!confirm('Delete this category?')) return;
  try {
    await deleteCategory(id);
    await logAudit('Delete category', id);
    invalidate('categories');
    toast('Category deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

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

  const rows = contractors.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc((c.emails || []).join(', ') || '-')}</td>
      <td>${esc(c.phone || '-')}</td>
      <td class="tright">${screenCounts[c.id] || 0}</td>
      <td><button class="btn-sm" onclick="App.removeContractorRow('${c.id}','${screenCounts[c.id] || 0}')">Delete</button></td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Contractors</h3><div class="desc">Notified by email when a ticket is created for a screen assigned to them. Screen assignment happens on the Asset Inventory edit/bulk-edit form.</div></div>
      <table><thead><tr><th>Name</th><th>Emails</th><th>Phone</th><th class="tright">Screens</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <form onsubmit="App.addContractorForm(event)" style="margin-top:14px;">
        <div class="grid2">
          <div class="field"><label>Name</label><input id="ct-name" required></div>
          <div class="field"><label>Phone</label><input id="ct-phone"></div>
        </div>
        <div class="field"><label>Emails (comma separated)</label><input id="ct-emails"></div>
        <button class="btn btn-orange" type="submit">Add Contractor</button>
      </form>
    </div>
  `;
}

export async function addContractorForm(event) {
  event.preventDefault();
  const name = document.getElementById('ct-name').value.trim();
  const phone = document.getElementById('ct-phone').value.trim();
  const emails = document.getElementById('ct-emails').value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await saveContractor({ name, phone, emails });
    await logAudit('Add contractor', name);
    invalidate('contractors');
    toast('Contractor added');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function removeContractorRow(id, screenCount) {
  const count = Number(screenCount) || 0;
  const msg = count > 0
    ? `This contractor is assigned to ${count} screen(s) in Asset Inventory - deleting will clear that assignment on all of them. Continue?`
    : 'Delete this contractor?';
  if (!confirm(msg)) return;
  try {
    await deleteContractor(id);
    await logAudit('Delete contractor', `${id} (${count} screens cleared)`);
    invalidate('contractors');
    invalidate('assetInventory');
    toast('Contractor deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

function renderNetworksTab() {
  const networks = loadData('networks', listNetworks);
  if (networks === null) return loadingCard();
  if (networks?.__error) return loadingCard(networks.__error);
  return `
    <div class="card">
      <div class="card-head"><h3>Screen Networks</h3></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${networks.map((n) => `<span class="file-chip">${esc(n.name)}</span>`).join('') || '<div class="empty">No networks yet.</div>'}
      </div>
      <form onsubmit="App.addNetworkForm(event)" class="grid2">
        <div class="field"><label>New Network</label><input id="net-name" required></div>
        <div><button class="btn btn-orange" type="submit">Add</button></div>
      </form>
    </div>
  `;
}

export async function addNetworkForm(event) {
  event.preventDefault();
  const name = document.getElementById('net-name').value.trim();
  try {
    await ensureNetwork(name);
    await logAudit('Add network', name);
    invalidate('networks');
    toast('Network added');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

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
    ${integrationField(settings, 'broadsignApi', 'Broadsign API', [
      { name: 'baseUrl', label: 'Base URL' }, { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'domainId', label: 'Domain ID' }, { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'broadsign-sync')}
    ${integrationField(settings, 'grassfishApi', 'Grassfish API', [
      { name: 'baseUrl', label: 'Base URL' }, { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ], 'grassfish-sync')}
    ${renderAssetInventoryApiCard(settings)}
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
