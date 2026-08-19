import { STATE, loadData, invalidate, toast, setState, openModal, closeModal } from '../state.js';
import { registerModal, loadingCard } from '../modals.js';
import { listWorkspaceDevices, updateWorkspaceDevice, deleteWorkspaceDevice } from '../data/workspaceDevices.js';
import { canEdit, canDelete } from '../auth.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { sortTh, applySort, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';
import { logAudit } from '../lib/audit.js';

// Matches the IoT Panel's own default staleness window (src/pages/networkPanels.js) - a device
// counts Offline once it's gone this long without a check-in from
// scripts/workspace-directory-agent.ps1, which posts every 15 minutes by default.
const STALE_AFTER_MINUTES = 30;

function isOnline(d) {
  if (!d.last_seen) return false;
  return (Date.now() - new Date(d.last_seen).getTime()) / 60000 <= STALE_AFTER_MINUTES;
}

function locationTile(loc, list) {
  const online = list.filter(isOnline).length;
  const offline = list.length - online;
  const onlinePct = list.length ? (online / list.length) * 100 : 0;
  return `<div style="background:#2a3441;border-radius:10px;padding:12px;color:#fff;min-height:96px;display:flex;flex-direction:column;justify-content:space-between;gap:9px;cursor:pointer;" onclick='App.openWorkspaceLocationModal(${jsonAttr(loc)})' title="Click to see devices">
    <div>
      <div style="font-size:13px;font-weight:700;line-height:1.3;">${esc(loc)} <span style="font-weight:400;opacity:.8;">(${list.length})</span></div>
      <div style="font-size:11px;opacity:.85;margin-top:2px;"><span style="color:#5fd88f;">${online} online</span>, <span style="color:#f2857a;">${offline} offline</span></div>
    </div>
    <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;background:rgba(255,255,255,.12);">
      ${online ? `<div style="width:${onlinePct.toFixed(1)}%;background:#1f9d55;"></div>` : ''}
      ${offline ? `<div style="width:${(100 - onlinePct).toFixed(1)}%;background:#c0392b;"></div>` : ''}
    </div>
  </div>`;
}

// JSON.stringify escapes backslashes/double-quotes per spec but not single quotes - these payloads
// sit inside single-quoted onclick='...' attributes, so an apostrophe in a location name would
// otherwise break out (same helper as networkPanels.js's jsonAttr).
function jsonAttr(value) {
  return JSON.stringify(value).replace(/'/g, '&#39;');
}

function deviceRow(d, editOk, deleteOk) {
  const online = isOnline(d);
  return `<tr>
    <td><b>${esc(d.hostname)}</b></td>
    <td class="small">${esc(d.location || '-')}</td>
    <td class="small">${esc(d.ip_address || '-')}</td>
    <td class="small">${d.anydesk_id ? `<span style="font-family:monospace;">${esc(d.anydesk_id)}</span>` : '-'}</td>
    <td class="small">${esc(d.os_name || '-')}${d.os_version ? ` <span class="muted">${esc(d.os_version)}</span>` : ''}</td>
    <td class="small">${esc(d.logged_in_user || '-')}</td>
    <td class="small"><button class="link-btn" onclick="App.openWorkspaceSoftwareModal('${d.id}')">${(d.software || []).length} package(s)</button></td>
    <td>${online ? '<span class="badge b-blue">Online</span>' : '<span class="badge b-red">Offline</span>'}</td>
    <td class="small">${d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : 'never'}</td>
    <td style="white-space:nowrap;">
      ${editOk ? `<button class="btn-sm" onclick="App.openWorkspaceEditModal('${d.id}')">Edit</button>` : ''}
      ${deleteOk ? `<button class="btn-sm" onclick="App.removeWorkspaceDevice('${d.id}')">Delete</button>` : ''}
    </td>
  </tr>`;
}

export function renderWorkspaceDirectory() {
  const devices = loadData('workspaceDevices', listWorkspaceDevices);
  if (devices === null) return loadingCard();
  if (devices?.__error) return loadingCard(devices.__error);

  if (!devices.length) {
    return `<div class="card"><div class="empty">No devices have checked in yet. Install the agent (Settings &gt; Integrations &gt; Workspace Directory Agent) on a PC and it'll appear here within a few minutes.</div></div>`;
  }

  const online = devices.filter(isOnline).length;
  const offline = devices.length - online;

  const byLocation = new Map();
  devices.forEach((d) => {
    const loc = (d.location || '').trim() || 'Unassigned';
    if (!byLocation.has(loc)) byLocation.set(loc, []);
    byLocation.get(loc).push(d);
  });
  // "Unassigned" always sorts last - everything else alphabetically, so a newly-checked-in device
  // without a Location set yet doesn't get lost among real, admin-named sites.
  const locations = [...byLocation.keys()].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  const tiles = locations.map((loc) => locationTile(loc, byLocation.get(loc))).join('');

  const search = (STATE.workspaceDirectorySearch || '').trim().toLowerCase();
  const filtered = search
    ? devices.filter((d) => `${d.hostname} ${d.location || ''} ${d.ip_address || ''} ${d.anydesk_id || ''} ${d.logged_in_user || ''} ${d.os_name || ''}`.toLowerCase().includes(search))
    : devices;
  const sorted = applySort(filtered, 'workspaceDevices', {
    hostname: (d) => d.hostname || '',
    location: (d) => d.location || '',
    ip: (d) => d.ip_address || '',
    anydesk: (d) => d.anydesk_id || '',
    os: (d) => d.os_name || '',
    user: (d) => d.logged_in_user || '',
    software: (d) => (d.software || []).length,
    lastSeen: (d) => d.last_seen || '',
  });

  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const rows = sorted.map((d) => deviceRow(d, editOk, deleteOk)).join('')
    || `<tr><td colspan="10"><div class="empty">No devices match "${esc(STATE.workspaceDirectorySearch || '')}".</div></td></tr>`;

  return `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi"><div class="label">Total Devices</div><div class="value">${devices.length}</div></div>
      <div class="kpi"><div class="label">Online</div><div class="value" style="color:#1f9d55;">${online}</div></div>
      <div class="kpi"><div class="label">Offline</div><div class="value" style="color:#c0392b;">${offline}</div></div>
      <div class="kpi"><div class="label">Locations</div><div class="value">${locations.length}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>By Location</h3><div class="desc">Click a location to see its devices. Set a device's Location from the Edit button in the table below.</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>
    </div>
    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div><h3>All Devices</h3><div class="desc">${filtered.length} of ${devices.length} device(s) shown. Offline = no check-in for ${STALE_AFTER_MINUTES}+ minutes.</div></div>
        <input placeholder="Search hostname, location, IP, AnyDesk ID, user..." value="${esc(STATE.workspaceDirectorySearch || '')}" oninput="App.setWorkspaceDirectorySearch(this.value)" style="min-width:240px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
      </div>
      <div style="max-height:520px;overflow-y:auto;overflow-x:auto;">
        <table style="${FIXED_TABLE_STYLE}">
          <thead><tr>
            ${sortTh('workspaceDevices', 'hostname', 'Hostname', 14)}
            ${sortTh('workspaceDevices', 'location', 'Location', 12)}
            ${sortTh('workspaceDevices', 'ip', 'IP', 11)}
            ${sortTh('workspaceDevices', 'anydesk', 'AnyDesk ID', 11)}
            ${sortTh('workspaceDevices', 'os', 'OS', 16)}
            ${sortTh('workspaceDevices', 'user', 'Logged-in User', 13)}
            ${sortTh('workspaceDevices', 'software', 'Software', 9)}
            <th style="width:8ch;">Status</th>
            ${sortTh('workspaceDevices', 'lastSeen', 'Last Seen', 12)}
            <th style="width:12ch;"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

export function setWorkspaceDirectorySearch(value) { setState({ workspaceDirectorySearch: value }); }

export function openWorkspaceLocationModal(location) {
  openModal('workspaceLocation', { location });
}

export function openWorkspaceSoftwareModal(deviceId) {
  openModal('workspaceSoftware', { deviceId });
}

export function openWorkspaceEditModal(deviceId) {
  openModal('workspaceEdit', { deviceId });
}

export async function saveWorkspaceEditForm(event, deviceId) {
  event.preventDefault();
  const location = document.getElementById('wd-edit-location').value.trim();
  const notes = document.getElementById('wd-edit-notes').value.trim();
  try {
    await updateWorkspaceDevice(deviceId, { location: location || null, notes: notes || null });
    await logAudit('Edit workspace device', deviceId);
    invalidate('workspaceDevices');
    closeModal();
    toast('Device updated');
    setState({});
  } catch (e) { toast(e.message || 'Failed to update device', 'error'); }
}

export async function removeWorkspaceDevice(id) {
  if (!confirm('Remove this device from the directory? It will reappear on its next check-in if the agent is still running.')) return;
  try {
    await deleteWorkspaceDevice(id);
    await logAudit('Delete workspace device', id);
    invalidate('workspaceDevices');
    closeModal();
    toast('Device removed');
    setState({});
  } catch (e) { toast(e.message || 'Failed to delete device', 'error'); }
}

registerModal('workspaceLocation', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const list = devices.filter((d) => ((d.location || '').trim() || 'Unassigned') === data.location);
  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const rows = list.map((d) => deviceRow(d, editOk, deleteOk)).join('') || `<tr><td colspan="10"><div class="empty">No devices.</div></td></tr>`;
  return `
    <h3>${esc(data.location)} - ${list.length} device(s)</h3>
    <div style="max-height:60vh;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr><th>Hostname</th><th>Location</th><th>IP</th><th>AnyDesk ID</th><th>OS</th><th>Logged-in User</th><th>Software</th><th>Status</th><th>Last Seen</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceSoftware', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const software = [...(device.software || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const rows = software.map((s) => `<tr><td>${esc(s.name)}</td><td class="small">${esc(s.version || '-')}</td></tr>`).join('') || `<tr><td colspan="2"><div class="empty">No software reported.</div></td></tr>`;
  return `
    <h3>${esc(device.hostname)} - Installed Software</h3>
    <div class="small muted" style="margin-bottom:8px;">${software.length} package(s), as of the last check-in${device.last_seen ? ` (${esc(fmtRelativeTime(device.last_seen))})` : ''}.</div>
    <div style="max-height:60vh;overflow-y:auto;">
      <table><thead><tr><th>Name</th><th>Version</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceEdit', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  return `
    <h3>Edit - ${esc(device.hostname)}</h3>
    <form onsubmit="App.saveWorkspaceEditForm(event, '${device.id}')">
      <div class="field"><label>Location</label><input id="wd-edit-location" value="${esc(device.location || '')}" placeholder="e.g. Yas Mall - Back Office"></div>
      <div class="field"><label>Notes</label><textarea id="wd-edit-notes" rows="3">${esc(device.notes || '')}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
