import { STATE, loadData, invalidate, toast, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { listCategories, addCategory, deleteCategory } from '../data/categories.js';
import { listContractors, saveContractor, deleteContractor } from '../data/contractors.js';
import { listNetworks, ensureNetwork } from '../data/networks.js';
import { getAllSettings, saveSetting } from '../data/settings.js';
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
  if (contractors === null) return loadingCard();
  if (contractors?.__error) return loadingCard(contractors.__error);
  const rows = contractors.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc((c.emails || []).join(', ') || '-')}</td>
      <td>${esc(c.phone || '-')}</td>
      <td><button class="btn-sm" onclick="App.removeContractorRow('${c.id}')">Delete</button></td>
    </tr>
  `).join('');
  return `
    <div class="card">
      <div class="card-head"><h3>Contractors</h3><div class="desc">Notified by email when a ticket is created for a screen assigned to them.</div></div>
      <table><thead><tr><th>Name</th><th>Emails</th><th>Phone</th><th></th></tr></thead><tbody>${rows}</tbody></table>
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

export async function removeContractorRow(id) {
  if (!confirm('Delete this contractor?')) return;
  try {
    await deleteContractor(id);
    await logAudit('Delete contractor', id);
    invalidate('contractors');
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

function integrationField(settings, key, label, fields) {
  const cfg = settings[key] || {};
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
        <button class="btn btn-orange" type="submit">Save</button>
        ${cfg.lastSync ? `<span class="small muted" style="margin-left:10px;">Last sync: ${esc(cfg.lastSync)}</span>` : ''}
      </form>
    </div>
  `;
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
    ])}
    ${integrationField(settings, 'grassfishApi', 'Grassfish API', [
      { name: 'baseUrl', label: 'Base URL' }, { name: 'apiKey', label: 'API Key', type: 'password' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox' },
    ])}
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
