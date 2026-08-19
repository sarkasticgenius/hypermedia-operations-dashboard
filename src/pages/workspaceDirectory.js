import { STATE, loadData, invalidate, toast, setState, openModal, closeModal } from '../state.js';
import { registerModal, loadingCard } from '../modals.js';
import { listWorkspaceDevices, updateWorkspaceDevice, deleteWorkspaceDevice } from '../data/workspaceDevices.js';
import { listSimCards } from '../data/simCards.js';
import { listAssetInventory } from '../data/assetsInventory.js';
import { canEdit, canDelete } from '../auth.js';
import { esc, fmtRelativeTime } from '../lib/format.js';
import { sortTh, applySort, FIXED_TABLE_STYLE } from '../lib/sortableTable.js';
import { logAudit } from '../lib/audit.js';

// The agent checks in once a day (deliberately infrequent - several of these PCs run on
// metered cellular SIM data). 30 hours gives a bit over one cycle of slack before flagging
// Offline, rather than a device looking "down" just because its daily check-in landed a bit late.
const STALE_AFTER_MINUTES = 30 * 60;

function isOnline(d) {
  if (!d.last_seen) return false;
  return (Date.now() - new Date(d.last_seen).getTime()) / 60000 <= STALE_AFTER_MINUTES;
}

// JSON.stringify escapes backslashes/double-quotes per spec but not single quotes - these payloads
// sit inside single-quoted onclick='...' attributes, so an apostrophe in a location name would
// otherwise break out (same helper as networkPanels.js's jsonAttr).
function jsonAttr(value) {
  return JSON.stringify(value).replace(/'/g, '&#39;');
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

// AnyDesk/TeamViewer IDs are directly actionable, not just displayed - a Connect link (the
// installed client's own custom protocol handler on whoever's browsing the dashboard) plus a Copy
// button, since not every admin will have the client set as the default handler for that scheme.
function remoteIdChip(tool, id, protocol) {
  if (!id) return '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:2px 6px;margin:1px 3px 1px 0;font-size:11px;white-space:nowrap;">
    <b>${esc(tool)}</b> <span style="font-family:monospace;">${esc(id)}</span>
    <a href="${protocol}:${esc(id)}" title="Connect via ${esc(tool)}" style="text-decoration:none;">&#128279;</a>
    <button type="button" class="link-btn" style="padding:0;" title="Copy ID" onclick="App.copyWorkspaceId(event,'${esc(id)}')">&#128203;</button>
  </span>`;
}

function remoteAccessCell(d) {
  const chips = [
    remoteIdChip('AnyDesk', d.anydesk_id, 'anydesk'),
    remoteIdChip('TeamViewer', d.teamviewer_id, 'teamviewer10'),
    ...(d.other_remote_ids || []).map((r) => remoteIdChip(r.tool, r.id, '')),
  ].filter(Boolean).join('');
  return chips || '<span class="small muted">-</span>';
}

export function copyWorkspaceId(event, id) {
  event.preventDefault();
  navigator.clipboard?.writeText(id).then(() => toast('Copied')).catch(() => {});
}

export function fillWorkspaceCommand(command) {
  const el = document.getElementById('wd-edit-command');
  if (el) el.value = command;
}

// Cross-references this PC with the screen it drives in the Broadsign/Grassfish Console, by the
// same Player Box ID those syncs themselves match on (see broadsign-sync/grassfish-sync) - so an
// admin can see "this PC is behind screen X at location Y" without leaving Digital Directory.
function matchedScreenFor(d, assetInventory) {
  if (!Array.isArray(assetInventory)) return null;
  const id = (d.broadsign_player_id || '').trim();
  const gfId = (d.grassfish_box_id || '').trim();
  if (id) {
    const row = assetInventory.find((r) => r.player_type === 'Broadsign' && String(r.player_box_id || '').trim() === id);
    if (row) return { source: 'Broadsign', row };
  }
  if (gfId) {
    const row = assetInventory.find((r) => r.player_type === 'Grassfish' && String(r.player_box_id || '').trim().toLowerCase() === gfId.toLowerCase());
    if (row) return { source: 'Grassfish', row };
  }
  return null;
}

function matchedScreenHtml(matched) {
  if (!matched) return '<span class="small muted">-</span>';
  const { source, row } = matched;
  return `<span class="small">${esc(source)}: <b>${esc(row.name)}</b>${row.venue ? ` @ ${esc(row.venue)}` : ''}</span>`;
}

function deviceRow(d, editOk, deleteOk, assetInventory) {
  const online = isOnline(d);
  const problemCount = (d.problems || []).length;
  return `<tr>
    <td><b>${esc(d.hostname)}</b></td>
    <td class="small">${esc(d.location || '-')}</td>
    <td class="small">${esc(d.ip_address || '-')}</td>
    <td>${remoteAccessCell(d)}</td>
    <td>${matchedScreenHtml(matchedScreenFor(d, assetInventory))}</td>
    <td class="small">${esc(d.os_name || '-')}${d.os_version ? ` <span class="muted">${esc(d.os_version)}</span>` : ''}</td>
    <td class="small">${esc(d.logged_in_user || '-')}</td>
    <td>${problemCount ? `<span class="badge b-red">${problemCount} issue${problemCount === 1 ? '' : 's'}</span>` : '<span class="badge b-blue">OK</span>'}</td>
    <td>${online ? '<span class="badge b-blue">Online</span>' : '<span class="badge b-red">Offline</span>'}</td>
    <td class="small">${d.last_seen ? esc(fmtRelativeTime(d.last_seen)) : 'never'}</td>
    <td style="white-space:nowrap;">
      <button class="btn-sm" onclick="App.openWorkspaceDetailsModal('${d.id}')">Details</button>
      ${editOk ? `<button class="btn-sm" onclick="App.openWorkspaceEditModal('${d.id}')">Edit</button>` : ''}
      ${deleteOk ? `<button class="btn-sm" onclick="App.removeWorkspaceDevice('${d.id}')">Delete</button>` : ''}
    </td>
  </tr>`;
}

function dataUsageTile(d, sim) {
  const allocGb = Number(sim?.data_allocation_gb) || 0;
  const usedGb = (d.data_used_mb_period || 0) / 1024;
  const leftGb = Math.max(0, allocGb - usedGb);
  const last24hGb = (d.data_used_mb_last_24h || 0) / 1024;
  const pct = allocGb ? Math.min(100, (usedGb / allocGb) * 100) : 0;
  const color = pct >= 90 ? '#c0392b' : pct >= 70 ? '#e07a2c' : '#1f9d55';
  const phone = sim?.sim_number || sim?.iccid || '';
  return `<div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;">
    <div>
      <div style="font-size:12.5px;font-weight:700;">${esc(d.hostname)}</div>
      <div class="small muted">${esc(d.location || 'Unassigned')}${phone ? ` &middot; ${esc(phone)}` : ''}</div>
    </div>
    <div style="height:7px;border-radius:4px;overflow:hidden;background:var(--bg);">
      <div style="width:${pct.toFixed(1)}%;height:100%;background:${color};"></div>
    </div>
    <div class="small" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 10px;">
      <span class="muted">Total Data</span><span style="text-align:right;">${allocGb ? `${allocGb} GB` : '&mdash;'}</span>
      <span class="muted">Data Used</span><span style="text-align:right;">${usedGb.toFixed(2)} GB</span>
      <span class="muted">Data Left</span><span style="text-align:right;">${allocGb ? `${leftGb.toFixed(2)} GB` : '&mdash;'}</span>
      <span class="muted">Percentage</span><span style="text-align:right;color:${color};">${allocGb ? `${pct.toFixed(1)}%` : '&mdash;'}</span>
      <span class="muted">Last 24h</span><span style="text-align:right;">${last24hGb.toFixed(2)} GB</span>
      <span class="muted">Last Update</span><span style="text-align:right;">${d.last_seen ? fmtRelativeTime(d.last_seen) : '&mdash;'}</span>
    </div>
    ${d.notes ? `<div class="small muted" style="border-top:1px solid var(--border);padding-top:6px;white-space:pre-wrap;">${esc(d.notes)}</div>` : ''}
  </div>`;
}

export function renderWorkspaceDirectory() {
  const devices = loadData('workspaceDevices', listWorkspaceDevices);
  const simCards = loadData('simCardsForDirectory', listSimCards);
  // Same cache key other pages (Settings, Gantt) already use for the full Asset Inventory table -
  // reuses whatever's already fetched instead of pulling a second copy of a large table.
  const assetInventory = loadData('assetInventory', listAssetInventory);
  if (devices === null || simCards === null || assetInventory === null) return loadingCard();
  if (devices?.__error) return loadingCard(devices.__error);
  if (simCards?.__error) return loadingCard(simCards.__error);
  if (assetInventory?.__error) return loadingCard(assetInventory.__error);

  if (!devices.length) {
    return `<div class="card"><div class="empty">No devices have checked in yet. Install the agent (Settings &gt; Integrations &gt; Digital Directory Agent) on a PC and it'll appear here within a few minutes of install (after that, it checks in once a day).</div></div>`;
  }

  const simById = new Map(simCards.map((s) => [s.id, s]));
  const online = devices.filter(isOnline).length;
  const offline = devices.length - online;
  const withProblems = devices.filter((d) => (d.problems || []).length).length;

  const byLocation = new Map();
  devices.forEach((d) => {
    const loc = (d.location || '').trim() || 'Unassigned';
    if (!byLocation.has(loc)) byLocation.set(loc, []);
    byLocation.get(loc).push(d);
  });
  const locations = [...byLocation.keys()].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));
  const tiles = locations.map((loc) => locationTile(loc, byLocation.get(loc))).join('');

  const dataDevices = devices.filter((d) => d.sim_card_id);
  const dataTilesHtml = dataDevices.length
    ? `<div class="card">
        <div class="card-head"><h3>SIM Data Usage</h3><div class="desc">Devices linked to a SIM Card record (Edit &gt; Linked SIM Card). Data Used/Left/Percentage are a running total since tracking started/was last reset here; Last 24h is just the latest check-in's usage. Figures are computed from the PC's own network adapter counters, not a carrier-billed figure. Comments shown below a tile come from that device's Notes (Edit).</div></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
          ${dataDevices.map((d) => dataUsageTile(d, simById.get(d.sim_card_id))).join('')}
        </div>
      </div>`
    : '';

  const search = (STATE.workspaceDirectorySearch || '').trim().toLowerCase();
  const filtered = search
    ? devices.filter((d) => `${d.hostname} ${d.location || ''} ${d.ip_address || ''} ${d.anydesk_id || ''} ${d.teamviewer_id || ''} ${d.logged_in_user || ''} ${d.os_name || ''}`.toLowerCase().includes(search))
    : devices;
  const sorted = applySort(filtered, 'workspaceDevices', {
    hostname: (d) => d.hostname || '',
    location: (d) => d.location || '',
    ip: (d) => d.ip_address || '',
    os: (d) => d.os_name || '',
    user: (d) => d.logged_in_user || '',
    problems: (d) => (d.problems || []).length,
    lastSeen: (d) => d.last_seen || '',
  });

  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const rows = sorted.map((d) => deviceRow(d, editOk, deleteOk, assetInventory)).join('')
    || `<tr><td colspan="11"><div class="empty">No devices match "${esc(STATE.workspaceDirectorySearch || '')}".</div></td></tr>`;

  return `
    <div class="kpi-row" style="margin-bottom:14px;">
      <div class="kpi"><div class="label">Total Devices</div><div class="value">${devices.length}</div></div>
      <div class="kpi"><div class="label">Online</div><div class="value" style="color:#1f9d55;">${online}</div></div>
      <div class="kpi"><div class="label">Offline</div><div class="value" style="color:#c0392b;">${offline}</div></div>
      <div class="kpi"><div class="label">With Issues</div><div class="value" style="color:${withProblems ? '#c0392b' : 'inherit'};">${withProblems}</div></div>
      <div class="kpi"><div class="label">Locations</div><div class="value">${locations.length}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>By Location</h3><div class="desc">Click a location to see its devices. Set a device's Location from the Edit button in the table below.</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;">${tiles}</div>
    </div>
    ${dataTilesHtml}
    <div class="card">
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div><h3>All Devices</h3><div class="desc">${filtered.length} of ${devices.length} device(s) shown. Offline = no check-in for ${STALE_AFTER_MINUTES / 60}+ hours (the agent checks in once a day).</div></div>
        <input placeholder="Search hostname, location, IP, remote ID, user..." value="${esc(STATE.workspaceDirectorySearch || '')}" oninput="App.setWorkspaceDirectorySearch(this.value)" style="min-width:240px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">
      </div>
      <div style="max-height:520px;overflow-y:auto;overflow-x:auto;">
        <table style="${FIXED_TABLE_STYLE}">
          <thead><tr>
            ${sortTh('workspaceDevices', 'hostname', 'Hostname', 14)}
            ${sortTh('workspaceDevices', 'location', 'Location', 12)}
            ${sortTh('workspaceDevices', 'ip', 'IP', 11)}
            <th>Remote Access</th>
            <th>Matched Screen</th>
            ${sortTh('workspaceDevices', 'os', 'OS', 16)}
            ${sortTh('workspaceDevices', 'user', 'Logged-in User', 13)}
            ${sortTh('workspaceDevices', 'problems', 'Issues', 8)}
            <th style="width:8ch;">Status</th>
            ${sortTh('workspaceDevices', 'lastSeen', 'Last Seen', 12)}
            <th style="width:18ch;"></th>
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

export function openWorkspaceDetailsModal(deviceId) {
  openModal('workspaceDetails', { deviceId });
}

export function openWorkspaceEditModal(deviceId) {
  openModal('workspaceEdit', { deviceId });
}

export async function saveWorkspaceEditForm(event, deviceId) {
  event.preventDefault();
  const location = document.getElementById('wd-edit-location').value.trim();
  const notes = document.getElementById('wd-edit-notes').value.trim();
  const simCardId = document.getElementById('wd-edit-sim').value || null;
  const pendingCommand = document.getElementById('wd-edit-command').value.trim();
  try {
    await updateWorkspaceDevice(deviceId, { location: location || null, notes: notes || null, sim_card_id: simCardId, pending_command: pendingCommand || null });
    await logAudit('Edit workspace device', deviceId);
    invalidate('workspaceDevices');
    closeModal();
    toast(pendingCommand ? 'Device updated - command will run on its next check-in.' : 'Device updated');
    setState({});
  } catch (e) { toast(e.message || 'Failed to update device', 'error'); }
}

export async function clearWorkspacePendingCommand(deviceId) {
  try {
    await updateWorkspaceDevice(deviceId, { pending_command: null });
    invalidate('workspaceDevices');
    toast('Pending command cleared');
    setState({});
  } catch (e) { toast(e.message || 'Failed to clear command', 'error'); }
}

export async function resetWorkspaceDataUsage(deviceId) {
  if (!confirm('Reset this device\'s tracked data usage back to zero?')) return;
  try {
    await updateWorkspaceDevice(deviceId, { data_used_mb_period: 0, data_used_mb_last_24h: 0 });
    await logAudit('Reset workspace device data usage', deviceId);
    invalidate('workspaceDevices');
    toast('Data usage reset');
    setState({});
  } catch (e) { toast(e.message || 'Failed to reset', 'error'); }
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
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const list = devices.filter((d) => ((d.location || '').trim() || 'Unassigned') === data.location);
  const editOk = canEdit('workspaceDirectory');
  const deleteOk = canDelete('workspaceDirectory');
  const rows = list.map((d) => deviceRow(d, editOk, deleteOk, assetInventory)).join('') || `<tr><td colspan="11"><div class="empty">No devices.</div></td></tr>`;
  return `
    <h3>${esc(data.location)} - ${list.length} device(s)</h3>
    <div style="max-height:60vh;overflow-y:auto;overflow-x:auto;">
      <table style="${FIXED_TABLE_STYLE}">
        <thead><tr><th>Hostname</th><th>Location</th><th>IP</th><th>Remote Access</th><th>Matched Screen</th><th>OS</th><th>Logged-in User</th><th>Issues</th><th>Status</th><th>Last Seen</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceDetails', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const assetInventory = STATE.pageData.assetInventory?.data || [];
  const d = devices.find((x) => x.id === data.deviceId);
  if (!d) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const matched = matchedScreenFor(d, assetInventory);

  const volumes = d.volumes || [];
  const volumesHtml = volumes.length
    ? `<table><thead><tr><th>Drive</th><th>Label</th><th>Size</th><th>Free</th></tr></thead><tbody>${volumes.map((v) => `<tr><td>${esc(v.drive)}</td><td class="small">${esc(v.label || '-')}</td><td class="small">${v.sizeGb} GB</td><td class="small">${v.freeGb} GB</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No volume data reported.</div>';

  const c = d.components || {};
  const componentsHtml = `<div class="small">
    ${c.cpu ? `<div><b>CPU:</b> ${esc(c.cpu)}</div>` : ''}
    ${c.ramGb ? `<div><b>RAM:</b> ${esc(String(c.ramGb))} GB</div>` : ''}
    ${c.gpu ? `<div><b>GPU:</b> ${esc(c.gpu)}</div>` : ''}
    ${(c.disks || []).length ? `<div><b>Disks:</b> ${c.disks.map(esc).join(', ')}</div>` : ''}
    ${!c.cpu && !c.ramGb && !c.gpu && !(c.disks || []).length ? '<div class="empty">No component data reported.</div>' : ''}
  </div>`;

  const antivirus = d.antivirus || [];
  const antivirusHtml = antivirus.length
    ? antivirus.map((a) => `<span class="badge ${a.enabled ? 'b-blue' : 'b-red'}" style="margin:0 4px 4px 0;">${esc(a.name)} - ${a.enabled ? 'Enabled' : 'Disabled'}</span>`).join('')
    : '<div class="empty">No antivirus data reported.</div>';

  const problems = d.problems || [];
  const problemsHtml = problems.length
    ? `<ul style="margin:0;padding-left:18px;">${problems.map((p) => `<li class="small" style="color:var(--red);">${esc(p)}</li>`).join('')}</ul>`
    : '<div class="small" style="color:var(--green);">No problems detected.</div>';

  const software = [...(d.software || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const softwareHtml = software.length
    ? `<details><summary style="cursor:pointer;font-size:12.5px;">${software.length} package(s) - click to expand</summary>
        <div style="max-height:260px;overflow-y:auto;margin-top:6px;">
          <table><thead><tr><th>Name</th><th>Version</th></tr></thead><tbody>${software.map((s) => `<tr><td class="small">${esc(s.name)}</td><td class="small">${esc(s.version || '-')}</td></tr>`).join('')}</tbody></table>
        </div>
      </details>`
    : '<div class="empty small">Not collected - the agent is metadata-only by default. Add it back via the Data Collector Script in Settings if you need it.</div>';

  return `
    <h3>${esc(d.hostname)}</h3>
    <div class="small muted" style="margin-bottom:10px;">${d.last_seen ? `Last check-in ${esc(fmtRelativeTime(d.last_seen))}` : 'Never checked in'} &middot; Agent v${esc(d.agent_version || '-')}</div>

    <div class="card-head" style="margin-top:4px;"><h3 style="font-size:13px;">Remote Access</h3></div>
    <div style="margin-bottom:12px;">${remoteAccessCell(d)}</div>

    <div class="card-head"><h3 style="font-size:13px;">Matched Broadsign/Grassfish Screen</h3></div>
    <div class="small" style="margin-bottom:12px;">
      ${matched ? `${esc(matched.source)}: <b>${esc(matched.row.name)}</b>${matched.row.venue ? ` @ ${esc(matched.row.venue)}` : ''}` : `<span class="muted">No match${(d.broadsign_player_id || d.grassfish_box_id) ? ` (ID ${esc(d.broadsign_player_id || d.grassfish_box_id)} not found in Asset Inventory)` : ' - no Broadsign/Grassfish player detected on this PC'}</span>`}
    </div>

    <div class="card-head"><h3 style="font-size:13px;">Problems</h3></div>
    <div style="margin-bottom:12px;">${problemsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Antivirus</h3></div>
    <div style="margin-bottom:12px;">${antivirusHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Components</h3></div>
    <div style="margin-bottom:12px;">${componentsHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Volumes</h3></div>
    <div style="margin-bottom:12px;">${volumesHtml}</div>

    <div class="card-head"><h3 style="font-size:13px;">Software</h3></div>
    <div style="margin-bottom:12px;">${softwareHtml}</div>

    ${d.pending_command ? `<div class="card-head"><h3 style="font-size:13px;">Pending Command</h3></div><div class="small" style="margin-bottom:12px;"><code>${esc(d.pending_command)}</code> - runs on the next check-in.</div>` : ''}
    ${d.last_command_output ? `<div class="card-head"><h3 style="font-size:13px;">Last Command Output</h3></div><div class="small muted" style="margin-bottom:4px;">${d.last_command_at ? esc(fmtRelativeTime(d.last_command_at)) : ''}</div><pre style="max-height:200px;overflow-y:auto;background:var(--bg);padding:8px;border-radius:6px;white-space:pre-wrap;font-size:11.5px;">${esc(d.last_command_output)}</pre>` : ''}

    <div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>
  `;
});

registerModal('workspaceEdit', (data) => {
  const devices = STATE.pageData.workspaceDevices?.data || [];
  const device = devices.find((d) => d.id === data.deviceId);
  if (!device) return `<div class="empty">Device not found.</div><div class="modal-actions"><button class="btn-sm" onclick="App.closeModal()">Close</button></div>`;
  const simCards = STATE.pageData.simCardsForDirectory?.data || [];
  const simOptions = simCards.map((s) => `<option value="${s.id}" ${device.sim_card_id === s.id ? 'selected' : ''}>${esc(s.sim_number || s.iccid || s.id)}${s.data_allocation_gb ? ` (${s.data_allocation_gb}GB)` : ''}</option>`).join('');
  return `
    <h3>Edit - ${esc(device.hostname)}</h3>
    <form onsubmit="App.saveWorkspaceEditForm(event, '${device.id}')">
      <div class="field"><label>Location</label><input id="wd-edit-location" value="${esc(device.location || '')}" placeholder="e.g. Yas Mall - Back Office"></div>
      <div class="field"><label>Notes</label><textarea id="wd-edit-notes" rows="3">${esc(device.notes || '')}</textarea></div>
      <div class="field"><label>Linked SIM Card</label>
        <select id="wd-edit-sim"><option value="">None</option>${simOptions}</select>
        <div class="small muted" style="margin-top:4px;">Used to show data used vs. plan size on the Digital Directory's SIM Data Usage tiles.${device.sim_card_id ? ` <button type="button" class="link-btn" onclick="App.resetWorkspaceDataUsage('${device.id}')">Reset usage counter</button>` : ''}</div>
      </div>
      <div class="field"><label>Run Command (PowerShell, runs on this device's next check-in)</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <span class="small muted" style="align-self:center;">Install:</span>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id 7zip.7zip --silent --accept-package-agreements --accept-source-agreements')">7-Zip</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id Google.Chrome --silent --accept-package-agreements --accept-source-agreements')">Chrome</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id AnyDeskSoftwareGmbH.AnyDesk --silent --accept-package-agreements --accept-source-agreements')">AnyDesk</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget install -e --id TeamViewer.TeamViewer --silent --accept-package-agreements --accept-source-agreements')">TeamViewer</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
          <span class="small muted" style="align-self:center;">Uninstall:</span>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id 7zip.7zip --silent')">7-Zip</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id Google.Chrome --silent')">Chrome</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id AnyDeskSoftwareGmbH.AnyDesk --silent')">AnyDesk</button>
          <button type="button" class="btn-sm" onclick="App.fillWorkspaceCommand('winget uninstall -e --id TeamViewer.TeamViewer --silent')">TeamViewer</button>
        </div>
        <textarea id="wd-edit-command" rows="2" placeholder="e.g. winget install -e --id 7zip.7zip --silent">${esc(device.pending_command || '')}</textarea>
        <div class="small muted" style="margin-top:4px;">Executes locally with the agent's (SYSTEM) privileges. The presets above use <code>winget</code> (built into Windows 10 21H2+/11) - requires that PC to already have it. For anything not in the presets, type <code>winget uninstall -e --id &lt;PackageId&gt; --silent</code> directly, or run <code>winget list</code> as a command first (its output shows up in Details) to find the exact package ID installed on that PC. Covers installing/updating/removing software or pulling a log file's contents back - output shows up in Details after the device's next 1-2 check-ins. Leave blank to clear a pending command.</div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-sm" onclick="App.closeModal()">Cancel</button>
        <button type="submit" class="btn btn-orange">Save</button>
      </div>
    </form>
  `;
});
