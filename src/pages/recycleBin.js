import { STATE, loadData, invalidate, toast, setState } from '../state.js';
import { loadingCard } from '../modals.js';
import { esc } from '../lib/format.js';
import { sortTh, applySort } from '../lib/sortableTable.js';
import { logAudit } from '../lib/audit.js';
import { listUsers } from '../data/users.js';
import { listDeletedAssets, restoreAsset, permanentlyDeleteAsset } from '../data/assets.js';
import { listDeletedAssetInventory, restoreAssetInventory, permanentlyDeleteAssetInventory } from '../data/assetsInventory.js';
import { invalidateAssetInventoryCaches } from './assetsInventory.js';
import { listDeletedCampaigns, restoreCampaign, permanentlyDeleteCampaign } from '../data/campaigns.js';
import { listDeletedCategories, restoreCategory, permanentlyDeleteCategory } from '../data/categories.js';
import { listDeletedContractors, restoreContractor, permanentlyDeleteContractor } from '../data/contractors.js';
import { listDeletedClients, restoreClient, permanentlyDeleteClient } from '../data/clients.js';
import { listDeletedDashboardLinks, restoreDashboardLink, permanentlyDeleteDashboardLink } from '../data/dashboards.js';
import { listDeletedLocations, restoreLocation, permanentlyDeleteLocation } from '../data/locations.js';
import { listDeletedMetroPics, restoreMetroPic, permanentlyDeleteMetroPic } from '../data/metroPics.js';
import { listDeletedNetworks, restoreNetwork, permanentlyDeleteNetwork } from '../data/networks.js';
import { listDeletedOrders, restoreOrder, permanentlyDeleteOrder } from '../data/orders.js';
import { listDeletedPermits, restorePermit, permanentlyDeletePermit } from '../data/permits.js';
import { listDeletedSimCards, restoreSimCard, permanentlyDeleteSimCard } from '../data/simCards.js';
import {
  listDeletedStaticCampaigns, restoreStaticCampaign, permanentlyDeleteStaticCampaign,
  listDeletedStaticMachines, restoreStaticMachine, permanentlyDeleteStaticMachine,
  listDeletedStaticBookings, restoreStaticBooking, permanentlyDeleteStaticBooking,
} from '../data/staticCampaigns.js';
import { listDeletedTickets, restoreTicket, permanentlyDeleteTicket } from '../data/tickets.js';

// One entry per soft-deletable entity - listDeleted/restore/purge wrap the matching data-layer
// functions (all following the same softDeleteRow/restoreRow/permanentlyDeleteRow shape from
// data/softDelete.js), cacheKeys are whatever loadData() key(s) each entity's own page uses, so
// restoring/purging here immediately reflects on that page too.
const RECYCLE_CONFIG = [
  { key: 'assets', label: 'Hardware Asset', listDeleted: listDeletedAssets, restore: restoreAsset, purge: permanentlyDeleteAsset, displayFn: (r) => r.name, cacheKeys: ['assets'] },
  { key: 'assetInventory', label: 'Asset Inventory Screen', listDeleted: listDeletedAssetInventory, restore: restoreAssetInventory, purge: permanentlyDeleteAssetInventory, displayFn: (r) => r.name },
  { key: 'campaigns', label: 'Digital Campaign', listDeleted: listDeletedCampaigns, restore: restoreCampaign, purge: permanentlyDeleteCampaign, displayFn: (r) => r.name, cacheKeys: ['campaigns'] },
  { key: 'categories', label: 'Category', listDeleted: listDeletedCategories, restore: restoreCategory, purge: permanentlyDeleteCategory, displayFn: (r) => r.name, cacheKeys: ['categories'] },
  { key: 'contractors', label: 'Contractor', listDeleted: listDeletedContractors, restore: restoreContractor, purge: permanentlyDeleteContractor, displayFn: (r) => r.name, cacheKeys: ['contractors'] },
  { key: 'clients', label: 'Client', listDeleted: listDeletedClients, restore: restoreClient, purge: permanentlyDeleteClient, displayFn: (r) => r.name, cacheKeys: ['clients'] },
  { key: 'dashboardLinks', label: 'Dashboard Link', listDeleted: listDeletedDashboardLinks, restore: restoreDashboardLink, purge: permanentlyDeleteDashboardLink, displayFn: (r) => r.name, cacheKeys: ['dashboardSections'] },
  { key: 'locations', label: 'Location', listDeleted: listDeletedLocations, restore: restoreLocation, purge: permanentlyDeleteLocation, displayFn: (r) => r.name, cacheKeys: ['locationsPage', 'locationsForNetworkPanel'] },
  { key: 'metroPics', label: 'Metro PIC', listDeleted: listDeletedMetroPics, restore: restoreMetroPic, purge: permanentlyDeleteMetroPic, displayFn: (r) => r.station, cacheKeys: ['metroPics'] },
  { key: 'networks', label: 'Network', listDeleted: listDeletedNetworks, restore: restoreNetwork, purge: permanentlyDeleteNetwork, displayFn: (r) => r.name, cacheKeys: ['networks'] },
  { key: 'orders', label: 'Order', listDeleted: listDeletedOrders, restore: restoreOrder, purge: permanentlyDeleteOrder, displayFn: (r) => r.asset_name || r.destination || 'Order', cacheKeys: ['procurementPage'] },
  { key: 'permits', label: 'Permit', listDeleted: listDeletedPermits, restore: restorePermit, purge: permanentlyDeletePermit, displayFn: (r) => r.title, cacheKeys: ['permits'] },
  { key: 'simCards', label: 'SIM Card', listDeleted: listDeletedSimCards, restore: restoreSimCard, purge: permanentlyDeleteSimCard, displayFn: (r) => r.sim_number, cacheKeys: ['simCardsPage'] },
  { key: 'staticCampaigns', label: 'Static Campaign', listDeleted: listDeletedStaticCampaigns, restore: restoreStaticCampaign, purge: permanentlyDeleteStaticCampaign, displayFn: (r) => r.name, cacheKeys: ['staticCampaigns'] },
  { key: 'staticMachines', label: 'Static Machine', listDeleted: listDeletedStaticMachines, restore: restoreStaticMachine, purge: permanentlyDeleteStaticMachine, displayFn: (r) => r.name, cacheKeys: ['staticMachines'] },
  { key: 'staticBookings', label: 'Static Booking', listDeleted: listDeletedStaticBookings, restore: restoreStaticBooking, purge: permanentlyDeleteStaticBooking, displayFn: (r) => `Booking ${r.start_date || '?'} -> ${r.end_date || '?'}`, cacheKeys: ['staticBookings'] },
  { key: 'tickets', label: 'Ticket', listDeleted: listDeletedTickets, restore: restoreTicket, purge: permanentlyDeleteTicket, displayFn: (r) => r.title, cacheKeys: ['ticketsPage'] },
];

async function loadRecycleBinData() {
  const [rowsByType, users] = await Promise.all([
    Promise.all(RECYCLE_CONFIG.map(async (cfg) => {
      const rows = await cfg.listDeleted();
      return rows.map((r) => ({ id: r.id, deleted_at: r.deleted_at, deleted_by: r.deleted_by, type: cfg.key, label: cfg.label, display: cfg.displayFn(r) || '(untitled)' }));
    })),
    listUsers(),
  ]);
  return { rows: rowsByType.flat().sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at)), users };
}

export function setRecycleBinSearch(value) { setState({ recycleBinSearch: value }); }
export function setRecycleBinType(value) { setState({ recycleBinType: value }); }

export async function restoreRecycleBinRow(type, id) {
  const cfg = RECYCLE_CONFIG.find((c) => c.key === type);
  if (!cfg) return;
  try {
    await cfg.restore(id);
    await logAudit(`Restore ${cfg.label}`, id);
    if (cfg.cacheKeys) cfg.cacheKeys.forEach(invalidate);
    if (type === 'assetInventory') invalidateAssetInventoryCaches();
    invalidate('recycleBin');
    toast(`${cfg.label} restored`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function purgeRecycleBinRow(type, id) {
  const cfg = RECYCLE_CONFIG.find((c) => c.key === type);
  if (!cfg) return;
  if (!confirm(`Permanently delete this ${cfg.label}? This cannot be undone - it will not be recoverable.`)) return;
  try {
    await cfg.purge(id);
    await logAudit(`Permanently delete ${cfg.label}`, id);
    invalidate('recycleBin');
    toast(`${cfg.label} permanently deleted`);
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

// Selection keys are `${type}::${id}` since ids aren't unique across the different tables this
// page pools together (an assets row and a permits row can share the same uuid by coincidence).
function rowKey(type, id) { return `${type}::${id}`; }

export function toggleRecycleBinSelection(type, id, checked) {
  const cur = new Set(STATE.recycleBinSelectedIds || []);
  const key = rowKey(type, id);
  if (checked) cur.add(key); else cur.delete(key);
  setState({ recycleBinSelectedIds: [...cur] });
}

export function toggleRecycleBinSelectAll(checked) {
  const data = STATE.pageData.recycleBin?.data;
  if (!data) return;
  const visible = visibleRecycleBinRows(data);
  const cur = new Set(STATE.recycleBinSelectedIds || []);
  if (checked) visible.forEach((r) => cur.add(rowKey(r.type, r.id)));
  else visible.forEach((r) => cur.delete(rowKey(r.type, r.id)));
  setState({ recycleBinSelectedIds: [...cur] });
}

export function clearRecycleBinSelection() { setState({ recycleBinSelectedIds: [] }); }

export async function bulkPurgeRecycleBin() {
  const keys = STATE.recycleBinSelectedIds || [];
  if (!keys.length) return;
  if (!confirm(`Permanently delete ${keys.length} selected item(s)? This cannot be undone - none of them will be recoverable.`)) return;
  try {
    const byType = new Map();
    for (const key of keys) {
      const [type, id] = key.split('::');
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(id);
    }
    for (const [type, ids] of byType.entries()) {
      const cfg = RECYCLE_CONFIG.find((c) => c.key === type);
      if (!cfg) continue;
      await Promise.all(ids.map((id) => cfg.purge(id)));
      await logAudit(`Bulk-permanently-delete ${cfg.label}`, `${ids.length} item(s)`);
    }
    invalidate('recycleBin');
    setState({ recycleBinSelectedIds: [] });
    toast(`${keys.length} item(s) permanently deleted`);
  } catch (e) { toast(e.message, 'error'); }
}

// Shared between the render and toggleRecycleBinSelectAll() so "select all" always matches
// whatever the search/type filter currently has on screen, not the full unfiltered set.
function visibleRecycleBinRows(data) {
  const typeFilter = STATE.recycleBinType || 'All';
  const search = (STATE.recycleBinSearch || '').trim().toLowerCase();
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]));
  const filtered = data.rows.filter((r) => {
    if (typeFilter !== 'All' && r.type !== typeFilter) return false;
    if (search && !r.display.toLowerCase().includes(search)) return false;
    return true;
  });
  return applySort(filtered, 'recycleBin', {
    item: (r) => r.display || '', type: (r) => r.label || '', deletedAt: (r) => r.deleted_at || '',
    deletedBy: (r) => usersById[r.deleted_by]?.name || usersById[r.deleted_by]?.username || '',
  });
}

export function renderRecycleBin() {
  const data = loadData('recycleBin', loadRecycleBinData);
  if (data === null) return loadingCard();
  if (data?.__error) return loadingCard(data.__error);

  const typeFilter = STATE.recycleBinType || 'All';
  const usersById = Object.fromEntries(data.users.map((u) => [u.id, u]));
  const rows = visibleRecycleBinRows(data);
  const selectedIds = new Set(STATE.recycleBinSelectedIds || []);
  const rowKeys = rows.map((r) => rowKey(r.type, r.id));
  const allSelected = rowKeys.length > 0 && rowKeys.every((k) => selectedIds.has(k));

  const typeOptions = ['All', ...RECYCLE_CONFIG.map((c) => c.key)]
    .map((k) => `<option value="${k}" ${typeFilter === k ? 'selected' : ''}>${k === 'All' ? 'All types' : esc(RECYCLE_CONFIG.find((c) => c.key === k).label)}</option>`)
    .join('');

  const rowsHtml = rows.map((r) => {
    const deletedBy = usersById[r.deleted_by];
    return `
      <tr>
        <td style="width:28px;"><input type="checkbox" ${selectedIds.has(rowKey(r.type, r.id)) ? 'checked' : ''} onchange="App.toggleRecycleBinSelection('${r.type}','${r.id}', this.checked)"></td>
        <td>${esc(r.display)}</td>
        <td>${esc(r.label)}</td>
        <td>${r.deleted_at ? new Date(r.deleted_at).toLocaleString() : '-'}</td>
        <td>${esc(deletedBy?.name || deletedBy?.username || 'Unknown')}</td>
        <td>
          <button class="btn-sm" onclick="App.restoreRecycleBinRow('${r.type}','${r.id}')">Restore</button>
          <button class="btn-sm" style="color:#c0392b;" onclick="App.purgeRecycleBinRow('${r.type}','${r.id}')">Delete Permanently</button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="toolbar">
      <div class="toolbar-actions">
        <input placeholder="Search deleted items..." value="${esc(STATE.recycleBinSearch || '')}" oninput="App.setRecycleBinSearch(this.value)" style="min-width:220px;">
        <select onchange="App.setRecycleBinType(this.value)">${typeOptions}</select>
      </div>
      <div class="small muted">${rows.length} of ${data.rows.length} deleted item(s)</div>
    </div>
    ${selectedIds.size > 0 ? `<div class="banner" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <span><b>${selectedIds.size}</b> item${selectedIds.size === 1 ? '' : 's'} selected</span>
      <div style="display:flex;gap:8px;">
        <button class="btn-sm" style="color:#c0392b;" onclick="App.bulkPurgeRecycleBin()">Delete Selected Permanently</button>
        <button class="btn-sm" onclick="App.clearRecycleBinSelection()">Clear Selection</button>
      </div>
    </div>` : ''}
    <div class="card">
      ${rows.length === 0 ? '<div class="empty">Nothing here - deleted items from anywhere in the app show up in this list.</div>' : `
        <table>
          <thead><tr><th style="width:28px;"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="App.toggleRecycleBinSelectAll(this.checked)" title="Select all matching this filter"></th>${sortTh('recycleBin', 'item', 'Item')}${sortTh('recycleBin', 'type', 'Type')}${sortTh('recycleBin', 'deletedAt', 'Deleted')}${sortTh('recycleBin', 'deletedBy', 'Deleted By')}<th></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `}
    </div>
  `;
}
