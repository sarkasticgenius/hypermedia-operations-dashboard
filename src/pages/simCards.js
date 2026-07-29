import { STATE, loadData, invalidate, openModal, closeModal, toast, setState } from '../state.js';
import { loadingCard, registerModal } from '../modals.js';
import { canAdd, canEdit, canDelete, canExportArea } from '../auth.js';
import {
  listSimCards, saveSimCard, deleteSimCard, deploySimCard, returnSimToStock, markMismatchResolved,
  simLocationDuplicateCounts, isDuplicateLocationSim,
} from '../data/simCards.js';
import { listLocations } from '../data/locations.js';
import { assetInventoryForLocation } from '../data/locationStats.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { svgGroupedBarChart } from '../lib/charts.js';
import { exportToCsv } from '../lib/csv.js';
import { logAudit } from '../lib/audit.js';
import { esc, fmtMoney } from '../lib/format.js';

async function loadSimCardsData() {
  const [simCards, locations, assetInventory] = await Promise.all([
    listSimCards(), listLocations(), listAssetInventory(),
  ]);
  return { simCards, locations, assetInventory };
}

function pageData() { return STATE.pageData.simCardsPage?.data; }

function issueInfo(s, dupCounts) {
  const dup = isDuplicateLocationSim(s, dupCounts);
  if (dup) return { flagged: true, reason: 'Duplicate: another SIM is deployed at this same venue+screen' };
  if (s.has_mismatch) return { flagged: true, reason: s.mismatch_note || 'Flagged during import for manual review' };
  return { flagged: false, reason: '' };
}

function filteredSimCards(simCards, dupCounts) {
  const tab = STATE.simStatusFilter || 'All';
  const search = (STATE.simSearch || '').trim().toLowerCase();
  return simCards.filter((s) => {
    const info = issueInfo(s, dupCounts);
    if (tab === 'Spare' && s.status !== 'Spare') return false;
    if (tab === 'Deployed' && s.status !== 'Deployed') return false;
    if (tab === 'Needs Review' && !info.flagged) return false;
    if (search) {
      const hay = `${s.sim_number || ''} ${s.carrier || ''} ${s.deployed_location_name || ''} ${s.mismatch_note || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export function renderSimCards() {
  const data = loadData('simCardsPage', loadSimCardsData);
  if (data === null) return loadingCard();
  if (data.__error) return loadingCard(data.__error);

  const { simCards } = data;
  const dupCounts = simLocationDuplicateCounts(simCards);
  const needsReviewCount = simCards.filter((s) => issueInfo(s, dupCounts).flagged).length;
  const duplicateCount = simCards.filter((s) => isDuplicateLocationSim(s, dupCounts)).length;
  const mismatchCount = simCards.filter((s) => s.has_mismatch).length;

  const tab = STATE.simStatusFilter || 'All';
  const visible = filteredSimCards(simCards, dupCounts).sort((a, b) => {
    const aFlag = issueInfo(a, dupCounts).flagged;
    const bFlag = issueInfo(b, dupCounts).flagged;
    if (aFlag !== bFlag) return aFlag ? -1 : 1;
    return (a.sim_number || '').localeCompare(b.sim_number || '');
  });

  const rows = visible.map((s) => {
    const info = issueInfo(s, dupCounts);
    return `
      <tr style="${info.flagged ? 'background:#fdecea;' : ''}">
        <td>${info.flagged ? '<span title="' + esc(info.reason) + '" style="color:#c0392b;">⚠</span> ' : ''}${esc(s.sim_number || '-')}
          ${info.flagged ? `<div class="small" style="color:#c0392b;">${esc(info.reason)}</div>` : ''}
        </td>
        <td>${esc(s.carrier || '-')}</td>
        <td>${esc(s.data_plan || '-')}</td>
        <td>${fmtMoney(s.billing_cost)}</td>
        <td><span class="badge ${s.status === 'Deployed' ? 'b-green' : 'b-gray'}">${esc(s.status)}</span></td>
        <td>${esc(s.deployed_location_name || '-')}</td>
        <td>
          ${canEdit('simCards') ? `<button class="btn-sm" onclick="App.editSimCard('${s.id}')">Edit</button>` : ''}
          ${canEdit('simCards') && s.status !== 'Deployed' ? `<button class="btn-sm" onclick="App.deploySimCardRow('${s.id}')">Deploy</button>` : ''}
          ${canEdit('simCards') && s.status === 'Deployed' ? `<button class="btn-sm" onclick="App.returnSimToStockRow('${s.id}')">Return to Stock</button>` : ''}
          ${canEdit('simCards') && s.has_mismatch ? `<button class="btn-sm" onclick="App.markSimResolvedRow('${s.id}')">Mark Resolved</button>` : ''}
          ${canDelete('simCards') ? `<button class="btn-sm" onclick="App.removeSimCard('${s.id}')">Delete</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  return `
    ${renderCharts(simCards)}
    ${(duplicateCount || mismatchCount) ? `<div class="banner">${duplicateCount ? `${duplicateCount} duplicate deployment(s). ` : ''}${mismatchCount ? `${mismatchCount} unresolved import mismatch(es).` : ''}</div>` : ''}
    <div class="toolbar">
      <div class="tabs">
        ${['All', 'Spare', 'Deployed', 'Needs Review'].map((t) => `<div class="tab ${tab === t ? 'active' : ''}" onclick="App.setSimStatusFilter('${t}')">${t}${t === 'Needs Review' && needsReviewCount ? ` (${needsReviewCount})` : ''}</div>`).join('')}
      </div>
      <div class="toolbar-actions">
        <input id="sim-search" placeholder="Search SIM cards..." value="${esc(STATE.simSearch || '')}" oninput="App.setSimSearch(this.value)">
        ${canExportArea('simCards') ? `<button class="btn-sm" onclick="App.exportSimCardsCsv()">Export CSV</button>` : ''}
        ${canAdd('simCards') ? `<button class="btn-sm" onclick="App.openBulkImport('simCards')">Bulk Import</button>` : ''}
        ${canAdd('simCards') ? `<button class="btn btn-orange" onclick="App.editSimCard(null)">+ Add SIM</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${visible.length === 0 ? '<div class="empty">No SIM cards match your filters.</div>' : `
        <table>
          <thead><tr><th>SIM Number</th><th>Carrier</th><th>Data Plan</th><th>Billing</th><th>Status</th><th>Deployed At</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `}
    </div>
  `;
}

export function setSimStatusFilter(v) { setState({ simStatusFilter: v }); }
export function setSimSearch(v) { setState({ simSearch: v }); }

function renderCharts(simCards) {
  const byLocation = {};
  for (const s of simCards) {
    if (s.status !== 'Deployed') continue;
    const key = s.deployed_location_name || 'Unspecified';
    byLocation[key] = (byLocation[key] || 0) + Number(s.billing_cost || 0);
  }
  const topLocs = Object.entries(byLocation).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v * 100) / 100]);

  const spareCost = simCards.filter((s) => s.status === 'Spare').reduce((sum, s) => sum + Number(s.billing_cost || 0), 0);
  const deployedCost = simCards.filter((s) => s.status === 'Deployed').reduce((sum, s) => sum + Number(s.billing_cost || 0), 0);

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:20px;">
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Billing Cost by Location</h3><div class="desc">Deployed SIMs only</div></div>
        ${svgGroupedBarChart(topLocs.map((e) => e[0]), [{ name: 'AED/mo', color: '#1f9d55', values: topLocs.map((e) => e[1]) }])}
      </div>
      <div class="card" style="margin-bottom:0;">
        <div class="card-head"><h3>Billing Cost: Spare vs Deployed</h3></div>
        ${svgGroupedBarChart(['Spare', 'Deployed'], [{ name: 'AED/mo', color: '#3a7ca5', values: [Math.round(spareCost * 100) / 100, Math.round(deployedCost * 100) / 100] }])}
      </div>
    </div>
  `;
}

// -------------------- CRUD / actions --------------------
export function exportSimCardsCsv() {
  const simCards = pageData()?.simCards || [];
  exportToCsv('sim-cards.csv', [
    { label: 'SIM Number', value: (s) => s.sim_number }, { label: 'ICCID', value: (s) => s.iccid },
    { label: 'Carrier', value: (s) => s.carrier }, { label: 'Data Plan', value: (s) => s.data_plan },
    { label: 'Billing Cost', value: (s) => s.billing_cost }, { label: 'Status', value: (s) => s.status },
    { label: 'Deployed Location', value: (s) => s.deployed_location_name }, { label: 'Notes', value: (s) => s.notes },
  ], simCards);
}

export function editSimCard(id) {
  const simCards = pageData()?.simCards || [];
  const row = id ? simCards.find((s) => s.id === id) : null;
  openModal('simCard', row || { status: 'Spare' });
}

export async function removeSimCard(id) {
  if (!confirm('Delete this SIM card?')) return;
  try {
    await deleteSimCard(id);
    await logAudit('Delete SIM card', id);
    invalidate('simCardsPage');
    invalidate('opsOverviewV2');
    toast('SIM card deleted');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function returnSimToStockRow(id) {
  try {
    await returnSimToStock(id);
    await logAudit('Return SIM to stock', id);
    invalidate('simCardsPage');
    invalidate('opsOverviewV2');
    toast('Returned to stock');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function markSimResolvedRow(id) {
  try {
    await markMismatchResolved(id);
    await logAudit('Mark SIM mismatch resolved', id);
    invalidate('simCardsPage');
    invalidate('opsOverviewV2');
    toast('Marked resolved');
    setState({});
  } catch (e) { toast(e.message, 'error'); }
}

export async function saveSimCardForm(event) {
  event.preventDefault();
  const id = document.getElementById('sim-id').value || null;
  const row = {
    id,
    simNumber: document.getElementById('sim-number').value.trim(),
    iccid: document.getElementById('sim-iccid').value.trim(),
    carrier: document.getElementById('sim-carrier').value.trim(),
    dataPlan: document.getElementById('sim-plan').value.trim(),
    billingCost: Number(document.getElementById('sim-billing').value || 0),
    notes: document.getElementById('sim-notes').value.trim(),
    status: document.getElementById('sim-status').value,
  };
  try {
    await saveSimCard(row);
    await logAudit(id ? 'Edit SIM card' : 'Add SIM card', row.simNumber);
    invalidate('simCardsPage');
    invalidate('opsOverviewV2');
    closeModal();
    toast('SIM card saved');
  } catch (e) { toast(e.message, 'error'); }
}

export function deploySimCardRow(id) {
  const simCards = pageData()?.simCards || [];
  const row = simCards.find((s) => s.id === id);
  if (row) openModal('simCardDeploy', row);
}

export function onSimDeployLocationChange(value) {
  if (!STATE.modal) return;
  STATE.modal.data = { ...STATE.modal.data, __deployLocation: value };
  setState({});
}

export async function saveSimCardDeploy(event) {
  event.preventDefault();
  const id = document.getElementById('simd-id').value;
  const locations = pageData()?.locations || [];
  const locationName = document.getElementById('simd-location').value;
  const location = locations.find((l) => l.name === locationName);
  const assetInvId = document.getElementById('simd-screen').value || null;
  const assetInventory = pageData()?.assetInventory || [];
  const screen = assetInvId ? assetInventory.find((a) => a.id === assetInvId) : null;
  try {
    const result = await deploySimCard(id, {
      locationId: location ? location.id : null, locationName,
      assetInvId, assetInvLabel: screen ? `${screen.venue} - ${screen.location || screen.name}` : null,
    });
    await logAudit('Deploy SIM card', locationName);
    invalidate('simCardsPage');
    invalidate('opsOverviewV2');
    closeModal();
    toast(result.autoReturned ? `SIM deployed (auto-returned ${result.autoReturned} conflicting SIM to stock)` : 'SIM card deployed');
  } catch (e) { toast(e.message, 'error'); }
}

registerModal('simCard', (data) => `
  <h3>${data.id ? 'Edit' : 'Add'} SIM Card</h3>
  <form onsubmit="App.saveSimCardForm(event)">
    <input type="hidden" id="sim-id" value="${esc(data.id || '')}">
    <div class="grid2">
      <div class="field"><label>SIM Number</label><input id="sim-number" value="${esc(data.sim_number || '')}" required></div>
      <div class="field"><label>ICCID</label><input id="sim-iccid" value="${esc(data.iccid || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Carrier</label><input id="sim-carrier" value="${esc(data.carrier || '')}"></div>
      <div class="field"><label>Data Plan</label><input id="sim-plan" value="${esc(data.data_plan || '')}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Billing Cost (AED/mo)</label><input id="sim-billing" type="number" step="0.01" value="${data.billing_cost || 0}"></div>
      <div class="field"><label>Status</label>
        <select id="sim-status">
          ${['Spare', 'Deployed', 'Inactive'].map((s) => `<option value="${s}" ${(data.status || 'Spare') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="sim-notes" rows="2">${esc(data.notes || '')}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
      <button type="submit" class="btn btn-orange">Save</button>
    </div>
  </form>
`);

registerModal('simCardDeploy', (data) => {
  const pd = pageData();
  const locations = (pd?.locations || []).filter((l) => l.type === 'Installed').sort((a, b) => a.name.localeCompare(b.name));
  const selectedLocation = data.__deployLocation ?? data.deployed_location_name ?? '';
  const screens = selectedLocation ? assetInventoryForLocation(selectedLocation, pd?.assetInventory || []) : [];
  return `
    <h3>Deploy SIM ${esc(data.sim_number || '')}</h3>
    <form onsubmit="App.saveSimCardDeploy(event)">
      <input type="hidden" id="simd-id" value="${esc(data.id || '')}">
      <div class="field"><label>Location</label>
        <select id="simd-location" onchange="App.onSimDeployLocationChange(this.value)" required>
          <option value="">-</option>
          ${locations.map((l) => `<option value="${esc(l.name)}" ${selectedLocation === l.name ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Screen (optional)</label>
        <select id="simd-screen">
          <option value="">-</option>
          ${screens.map((s) => `<option value="${s.id}">${esc(s.venue)} - ${esc(s.location || s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Deploy</button>
      </div>
    </form>
  `;
});
